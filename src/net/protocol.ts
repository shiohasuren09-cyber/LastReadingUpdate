// ──────────────────────────────────────────────
// net/protocol.ts — the multiplayer broadcast contract (transport-agnostic)
// ──────────────────────────────────────────────
//
// This file holds what BOTH ends share: the types, plus logic that touches no
// host API. The transport lives next door — `cast.ts` is the Rezona App's
// native bridge provider.
//
// Why the contract is its own file: the App's `rezonaBridge.cast` is a fixed,
// frozen fact, and any other client adapts to ITS semantics. If the contract
// were written into one end's transport, the other end would have to import a
// module named after its counterpart.
//
// Ported from the old @rezona/core `common/multiplayer.ts`, semantics preserved
// exactly — this mirrors a native-side protocol, so do not "improve" it.
//
// Multiplayer is added ONLY when the user invokes the `/multiplayer` skill.

/**
 * Options for joining a broadcast session.
 *
 * `maxUsers` is only a sharding hint for the transport; the protocol never
 * surfaces a "session full" branch to the page.
 */
export interface CastJoinOptions {
  timeoutMs?: number;
  maxUsers: number;
  /**
   * The key the backend shards rooms by — same game id, same room.
   *
   * The App can fall back to its native slot info when this is omitted, but the
   * web wrapper has no such fallback and the join fails with
   * `game id not resolvable`. Pass it whenever the host gives you one.
   */
  gameId?: number | string;
}

/** Identity fields injected by the transport. Never forge or override these. */
export interface CastUserIdentity {
  uid: string;
  username: string;
  avatarImage: string;
}

/**
 * A broadcast message received from a remote player.
 *
 * `data` is opaque to the protocol and goes to every participant — never put
 * credentials, keys, or private content in it.
 */
export interface CastData extends CastUserIdentity {
  data: unknown;
  timestamp: number;
}

/**
 * A live multiplayer session — **this is the transport contract itself**.
 *
 * Every provider (the native bridge, or any future implementation) returns this
 * shape, and game code only ever knows about this.
 *
 * The protocol offers just `publish` / `subscribe`: no leave, no unsubscribe, no
 * reconnect event, no history replay, and `subscribe` never echoes your own
 * messages back. The transport throttles publishes, so callers should avoid
 * publishing when nothing changed.
 */
export interface Cast extends CastUserIdentity {
  staleAfterMs: number;
  publish(data: unknown): void;
  subscribe(handler: (msg: CastData) => void): void;
}

/** Presence of a remote player, inferred from their last broadcast. */
export type RemoteUserStatus = 'active' | 'stale';

/**
 * A remote player as tracked by the page.
 *
 * `data` stays opaque to the protocol; only put state that is safe to show to
 * every participant into it.
 */
export interface RemoteUser extends CastUserIdentity {
  data: unknown;
  lastReceivedAt: number;
  status: RemoteUserStatus;
}

/**
 * The one join failure a PLAYER can fix: this browser has no session.
 *
 * Compare against `JoinFailedError.kind`. Imported as a constant rather than
 * written out, so a typo is a compile error instead of a branch that silently
 * never runs — and pair it with `signInUrl()` from the web provider.
 */
export const SIGN_IN_REQUIRED = 'SignInRequiredError';

/**
 * One join failure type for the page to handle.
 *
 * Timeout and internal transport errors are deliberately NOT distinguished from
 * each other — render one honest retry path. The single exception is
 * `SIGN_IN_REQUIRED`, and the line is drawn on whether the PLAYER can act: no
 * button the game could draw fixes a timeout, whereas signing in is one click
 * away. See `kind`.
 */
export class JoinFailedError extends Error {
  override readonly name = 'JoinFailedError';
  readonly cause?: unknown;
  /**
   * Envelope code from the host: 500 rejected, 408 timed out.
   *
   * Not an HTTP status — do not branch on it for the sign-in case even though
   * that one starts life as a 401 (see `kind`).
   */
  readonly code?: number;
  /**
   * Which classification this failure falls in: `JoinRejectedError` /
   * `JoinTimeoutError` from the App host, or `SIGN_IN_REQUIRED` (this module's
   * constant) from the web transport when the browser has no session — the App
   * never produces that one, players there are signed in natively.
   *
   * Branch on this, never on `message`: the text is diagnostic and changes.
   */
  readonly kind?: string;

  constructor(message: string, options?: { cause?: unknown; code?: number; kind?: string }) {
    super(message);
    this.cause = options?.cause;
    this.code = options?.code;
    this.kind = options?.kind;
    Object.setPrototypeOf(this, JoinFailedError.prototype);
  }
}

/**
 * Upsert a remote player from a broadcast, returning the record just written.
 *
 * NOTE: this replaces the map entry with a fresh object, so anything caching
 * the previous object (a sprite holding onto it) will silently freeze.
 *
 * `subscribe` never echoes your own messages, so the local player's state is
 * yours to maintain separately.
 */
export function updateRemoteUsers(
  remoteUsers: Map<string, RemoteUser>,
  msg: CastData,
  now: number = Date.now(),
): RemoteUser {
  const remoteUser: RemoteUser = {
    uid: msg.uid,
    username: msg.username,
    avatarImage: msg.avatarImage,
    data: msg.data,
    lastReceivedAt: now,
    status: 'active',
  };

  remoteUsers.set(msg.uid, remoteUser);
  return remoteUser;
}

/** The uids `pruneStaleRemoteUsers` marked or removed on this sweep. */
export interface PruneStaleRemoteUsersResult {
  marked: string[];
  removed: string[];
}

/**
 * Infer who has left, from how long ago they last broadcast.
 *
 * Marks `stale` when `age > staleAfterMs`; deletes when `age > 2 * staleAfterMs`.
 * Both thresholds are strict. Repeated calls are idempotent: an already-stale
 * player is not reported in `marked` again.
 *
 * Nothing calls this for you — run it on a timer or each frame.
 *
 * CAUTION: a player is not guaranteed to pass through `marked` before
 * `removed`. If sweeps are far enough apart that a player's age jumps straight
 * past `2 * staleAfterMs`, they are only ever reported as removed — so do not
 * build a "player is dropping out" affordance that assumes `marked` fires first.
 */
export function pruneStaleRemoteUsers(
  remoteUsers: Map<string, RemoteUser>,
  staleAfterMs: number,
  now: number = Date.now(),
): PruneStaleRemoteUsersResult {
  const marked: string[] = [];
  const removed: string[] = [];

  for (const [uid, remoteUser] of remoteUsers) {
    const age = now - remoteUser.lastReceivedAt;

    if (age > 2 * staleAfterMs) {
      remoteUsers.delete(uid);
      removed.push(uid);
      continue;
    }

    if (age > staleAfterMs && remoteUser.status === 'active') {
      remoteUser.status = 'stale';
      marked.push(uid);
    }
  }

  return { marked, removed };
}

/**
 * Elect the lowest uid among the local and remote players as the owner of
 * shared state.
 *
 * Compares uids only; it never inspects the business shape of `data`.
 *
 * Which iterable you pass matters: passing every tracked uid keeps a `stale`
 * player as owner until they are actually removed, leaving shared state without
 * a publisher for up to `2 * staleAfterMs`. Filter to active players first if
 * your game cannot tolerate that gap.
 */
export function pickSharedOwnerUid(
  localUid: string,
  remoteUserUids: Iterable<string>,
): string {
  let ownerUid = localUid;

  for (const uid of remoteUserUids) {
    if (uid < ownerUid) {
      ownerUid = uid;
    }
  }

  return ownerUid;
}

/** Options for `safeSubscribe`'s handler-exception callback. */
export interface SafeSubscribeOptions {
  onError?: (err: unknown, msg: CastData) => void;
}

/**
 * Subscribe with the game's handler exceptions isolated.
 *
 * The protocol has no unsubscribe, and calling `subscribe` twice replaces the
 * previous handler.
 *
 * This never logs — broadcast `data` could leak into the console. That means a
 * throwing handler is SILENT unless you pass `onError`; do pass it.
 */
export function safeSubscribe(
  cast: Cast,
  handler: (msg: CastData) => void,
  options?: SafeSubscribeOptions,
): void {
  cast.subscribe((msg) => {
    try {
      handler(msg);
    } catch (err) {
      options?.onError?.(err, msg);
    }
  });
}
