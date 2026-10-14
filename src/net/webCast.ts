// ──────────────────────────────────────────────
// net/webCast.ts — Rezona cast transport provider for a plain browser
// ──────────────────────────────────────────────
//
// The App gets its cast session from the native host (see `cast.ts`). On the
// web there is no host: the game is served straight out of pgc's `/preview`
// route with nothing injecting `RezonaBridge`. So the page does the host's job
// itself — assign a room, take an RTM token, and speak Agora RTM directly —
// while `protocol.ts` keeps the contract game code sees identical on both ends.
//
//   POST {CAST_API_PREFIX}/session -> { room_name, room_limit, room_member_index,
//                                        rtm_token, rtm_token_expire_at,
//                                        uid, app_id, username, avatar_image }
//   init(app_id, uid) -> login(rtm_token) -> subscribe(room_name)
//
// The endpoint is pgc's, same-origin with the preview page, so the browser's
// session cookie rides along on its own. pgc authenticates the player, turns
// this preview into the published game behind it, and asks rezona for a room —
// the room is keyed by that game, not by anything the client says, which is what
// puts an App player and a web player in the SAME room.
//
// `uid` IS the player's real rezona user id, in the same namespace the App uses
// — one person is one identity across both ends, so anything keyed by uid
// (leaderboards, friends, ownership) lines up between the App and the web. Read
// it off the response and pass it to Agora verbatim: the token is signed FOR
// that uid, and the pair is not separable.
//
// The flip side is that the token in this page carries a real identity for as
// long as it lives, which is why its TTL is half the App's (30 min): the window
// is how long a leak can be used to take the player's place. That is also why
// renewal below is not optional — a session outliving one TTL is normal play.
//
// Deliberate parity with the App, NOT gaps to fix here (fixing one end alone
// desynchronises the two): the join response carries no roster, and
// `staleAfterMs` is a constant.

import {
  JoinFailedError,
  SIGN_IN_REQUIRED,
  type Cast,
  type CastData,
  type CastJoinOptions,
} from './protocol.ts';

/**
 * Where the web provider opens a cast session.
 *
 * Lives here rather than in `config.ts` on purpose: that file is the one net file
 * a game may tune, and this is not a tunable — it is the platform contract with
 * pgc. Keeping it beside its only caller also means seeding an existing workspace
 * refreshes the endpoint along with the provider, without touching game-owned
 * settings.
 *
 * Same-origin: pgc serves the preview page, so the session cookie rides along by
 * itself and there is no CORS to arrange. pgc is also the service that knows
 * which published game this preview belongs to.
 */
export const CAST_API_PREFIX = '/game/pgcserver/api/game/cast';

/** Fixed by the host contract; see the integration spec's §9. */
const STALE_AFTER_MS = 12_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const CAST_CUSTOM_TYPE = 'CastMessage';

/**
 * How long before `rtm_token_expire_at` to ask for the next token.
 *
 * The upstream contract's floor. It has to cover a pgc call plus rezona's own
 * Agora call, on whatever connection the player has.
 */
const RENEW_LEAD_MS = 60_000;

/**
 * Margin `rtm_token_expire_at` already holds back: the token really dies that
 * much later. Only used to decide when retrying has become pointless.
 */
const EXPIRY_MARGIN_MS = 30_000;

/** Retry ladder for a failed renewal, cut short by the real expiry. */
const RENEW_BACKOFF_MS = [5_000, 15_000, 45_000];

/**
 * Deadline for one renewal request.
 *
 * Half the lead, so a socket that accepts the request and never answers still
 * leaves room for a retry rung before the token dies. Without it the in-flight
 * flag stays set for as long as the browser tolerates the stall, and both
 * triggers are deduped away — the token expires with no retry and no log.
 */
const RENEW_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How far ahead an expiry may sit and still be believable.
 *
 * A day is orders of magnitude past any token TTL upstream issues, and orders of
 * magnitude short of what the classic slip produces: `rtm_token_expire_at` filled
 * with milliseconds lands ~55,000 years out. Left unbounded, such a value is
 * finite and positive, so it passes as an expiry and then poisons everything
 * downstream — `setTimeout` truncates the huge delay and fires at once, and every
 * honest response afterwards compares as "the expiry did not advance", which
 * burns the retry ladder down to a permanent stop inside the first minute.
 */
const MAX_EXPIRY_HORIZON_MS = 86_400_000;

/** A usable seconds-since-epoch expiry, or undefined for anything else. */
function readExpiry(value: unknown, nowMs: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value * 1000 <= nowMs + MAX_EXPIRY_HORIZON_MS ? value : undefined;
}

type BrowserWindow = Window & {
  location?: { pathname?: string; href?: string; origin?: string; hostname?: string };
};

const w = (): BrowserWindow | undefined =>
  typeof window === 'undefined' ? undefined : (window as BrowserWindow);

/** Codes are opaque but bounded: short, and drawn from an alphanumeric alphabet. */
const PREVIEW_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/pv/{code}/{version}/...` (bytes) and `/play/{code}` (short link).
 *
 * The version group is optional because the short-link form has none — it 302s
 * to the `/pv/` form, so a page actually running has the redirected URL and a
 * version. Landing here without one means the version is genuinely unknown.
 */
const PREVIEW_PATH_PATTERN = /(?:^|\/)(?:pv|play)\/([^/]*)(?:\/([^/]*))?/;

/**
 * Legacy plain shape: `/preview/{user_id}/{project_id}/{version}/...`.
 *
 * pgc still serves this route for links shared before opaque codes existed, and
 * such a link points at `current` / `v{n}` — which keep updating as the game is
 * developed. So an old link can perfectly well be showing a NEW build running
 * this provider; recognising only `/pv/` would make multiplayer silently
 * unavailable there, with nothing on the page explaining why.
 */
const LEGACY_PREVIEW_PATH_PATTERN = /(?:^|\/)preview\/(\d{1,18})\/(\d{1,18})\/([^/]*)/;

/**
 * The version directory this page is running out of, as it appears in the path.
 *
 * A plausibility filter, deliberately NOT pgc's version vocabulary: writing
 * `v{n}|current` here would be a second, staler copy of a scheme that lives over
 * there. Whether a given version has a room is pgc's answer (409) — `current` and
 * an unpublished `v5` are the same case, and neither is decidable on this side.
 */
const PREVIEW_VERSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * What the page is, in whichever shape its own URL happens to be written, plus
 * which version directory it is running out of.
 *
 * `version` is not optional. Different versions run different bundles whose
 * protocols need not be compatible, so they must not share a room — pgc resolves
 * the room from (preview, version) and rejects a request without one. A ref that
 * cannot name its version cannot join, so it is not a ref.
 */
export type PreviewRef = ({ code: string } | { userId: number; projectId: number }) & {
  version: string;
};

/**
 * Which preview this page is — the only thing the game has to tell pgc.
 *
 * Read off the page's own path, and from nowhere else. pgc serves the game from
 * `/pv/{code}/...`, so the code is always already there: share links need no
 * hand-decorating for multiplayer, and a link made before multiplayer existed
 * still works.
 *
 * Deliberately takes no override. `CastJoinOptions.gameId` means a rezona game
 * id — the App's notion — and a preview reference is a different thing; letting
 * one be passed as the other would give the page a second, contradictory way to
 * say which room it wants. The room key is resolved server-side from this
 * reference, and the page never names it.
 */
/**
 * The path to read the preview reference out of.
 *
 * `document.baseURI` first, and that is not a nicety: the share link a player
 * actually opens is `/game/share/{code}/{version}` — its address bar says
 * nothing about `/pv/`. What identifies the version directory there is the
 * `<base href>` the share page injects, pointing at
 * `/game/pgcserver/pv/{code}/{version}/dist/`. Reading only `location` leaves
 * multiplayer dead on every real share link.
 *
 * With no `<base>`, `baseURI` IS the document URL — so bytes served straight off
 * `/pv/…` and the legacy `/preview/…` shape fall out of the same expression.
 *
 * The flip side is a dependency worth stating: a wrapper page that serves this
 * bundle **must** point `<base href>` at the version directory. Without it the
 * relative asset URLs would not load either, so this is not a new requirement —
 * but it is now also what multiplayer keys off.
 */
function previewPathname(): string | null {
  const base = (globalThis as { document?: { baseURI?: string } }).document?.baseURI;
  if (typeof base === 'string' && base !== '') {
    try {
      return new URL(base).pathname;
    } catch {
      // Unparseable baseURI: fall through to the document's own location.
    }
  }
  const pathname = w()?.location?.pathname;
  return typeof pathname === 'string' && pathname !== '' ? pathname : null;
}

export function resolvePreviewRef(): PreviewRef | null {
  const pathname = previewPathname();
  if (pathname === null) return null;

  const coded = PREVIEW_PATH_PATTERN.exec(pathname);
  if (typeof coded?.[1] === 'string') {
    const trimmed = coded[1].trim();
    const version = readVersion(coded[2]);
    // Validated rather than passed through: both come out of a URL path and are
    // relayed to pgc verbatim, so anything implausible is dropped here.
    if (PREVIEW_CODE_PATTERN.test(trimmed) && version !== null) {
      return { code: trimmed, version };
    }
  }

  const legacy = LEGACY_PREVIEW_PATH_PATTERN.exec(pathname);
  if (legacy) {
    const userId = Number(legacy[1]);
    const projectId = Number(legacy[2]);
    const version = readVersion(legacy[3]);
    if (
      Number.isSafeInteger(userId) &&
      userId > 0 &&
      Number.isSafeInteger(projectId) &&
      projectId > 0 &&
      version !== null
    ) {
      return { userId, projectId, version };
    }
  }

  return null;
}

/** pgc's bound on `room_limit` (`ge=1, le=100`). Outside it every join is a 422. */
const ROOM_LIMIT_MAX = 100;

/** The version segment if it is present and plausible, else `null`. */
function readVersion(segment: string | undefined): string | null {
  if (typeof segment !== 'string') return null;
  const trimmed = segment.trim();
  return PREVIEW_VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Can this browser join a cast session at all?
 *
 * Gated on a resolvable preview code rather than "is this a browser": off a
 * preview URL every join would fail, and a multiplayer entry point that can only
 * ever error is worse than none. A URL with no version segment falls in the same
 * bucket — pgc rejects a session request without one.
 */
export function hasWebCast(): boolean {
  return w() !== undefined && resolvePreviewRef() !== null;
}

/**
 * Where the main site signs a player in, set to come back here afterwards.
 *
 * A browser player joins with their own session cookie, so "not signed in" is
 * the one join failure the player can actually fix — `joinWebCast` reports it as
 * `kind: 'SignInRequiredError'` and this is the address that resolves it. Wire
 * it to something the player clicks:
 *
 *   const url = signInUrl();
 *   if (url) location.assign(url);
 *
 * **Never navigate on your own.** The game has to stay playable solo, and a
 * visitor who opened a share link to try it out must see the game, not a login
 * screen. Signing in is an offer, not a gate.
 *
 * `redirect` carries the CURRENT full href, not the origin: the player has to
 * come back to this version directory (`/pv/{code}/{version}/…`, or the
 * `/game/share/{code}/{version}` address bar), not to the site's front page.
 *
 * `null` means "do not navigate": no `window`, or an origin that is not the main
 * site. Sign-in only exists on `rezona.ai`, and the session cookie it sets
 * belongs to that domain — a page served from anywhere else cannot read it, so a
 * jump would either loop or land on a path that does not exist there. Show the
 * URL instead of following it while developing locally.
 *
 * An allowlist, not a localhost blacklist: `localhost` is only the most common
 * of these origins. `vite --host` to test on a phone serves the game from a LAN
 * address, mDNS gives `*.local`, and this module's own fetch is written so a
 * game hosted elsewhere still works — every one of those would otherwise be
 * handed a dead URL on its own origin.
 *
 * The path is a SECOND copy of a rule that lives in the main site
 * (`rezonalab-game-web/src/lib/auth.ts`). Deliberate: the alternative is a new
 * field on a pgc response, and pgc does not know the front-end's routes. The
 * cost is real — if the site moves sign-in, this silently points at a 404.
 */
export function signInUrl(): string | null {
  const win = w();
  const href = win?.location?.href;
  const origin = win?.location?.origin;
  const hostname = win?.location?.hostname;
  if (!href || !origin || !hostname || !isMainSiteHost(hostname)) return null;
  return `${origin}/studio/sign-in?redirect=${encodeURIComponent(href)}`;
}

/**
 * Is this page served by the main site, i.e. is there a sign-in to send it to?
 *
 * `rezona.ai` is hardcoded for the same reason `/studio/sign-in` is (see
 * `signInUrl`): the alternative is a field on a pgc response, and pgc does not
 * know the front-end's domains. Lowercased defensively — `location.hostname` is
 * already lowercase in every browser, but this function is also the one place a
 * caller could pass something else.
 */
function isMainSiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'rezona.ai' || host.endsWith('.rezona.ai');
}

// --- transport -------------------------------------------------------------

/** The slice of the Agora RTM client this provider uses. */
export interface WebCastRtmClient {
  addEventListener(event: 'message', handler: (evt: RtmMessageEvent) => void): void;
  /** Fired ~30s before the token really expires — the renewal backstop. */
  addEventListener(event: 'tokenPrivilegeWillExpire', handler: (channelName?: string) => void): void;
  /** Every change in the SDK's connection to RTM — including being kicked. */
  addEventListener(event: 'linkState', handler: (evt: RtmLinkStateEvent) => void): void;
  removeEventListener?(event: 'message', handler: (evt: RtmMessageEvent) => void): void;
  login(options: { token: string }): Promise<unknown>;
  /**
   * Swap in a fresh token for the SAME uid, without dropping the connection.
   *
   * No options: `RenewTokenOptions.channelName` is for stream channels, and this
   * provider uses a message channel — the login privilege is what expires.
   */
  renewToken(token: string): Promise<unknown>;
  subscribe(channelName: string, options?: unknown): Promise<unknown>;
  unsubscribe(channelName: string): Promise<unknown>;
  logout(): Promise<unknown>;
  publish(
    channelName: string,
    payload: string,
    options: { channelType: string; customType: string },
  ): Promise<unknown>;
}

/**
 * One RTM link-state change, narrowed to what this provider reads.
 *
 * Deliberately NOT a mirror of the SDK's `LinkStateEvent`: the fields left out
 * (`affectedChannels`, `unrestoredChannels`, `serviceType`, `isResumed`) either
 * name the room — a credential here, see the module header — or would invite a
 * second, subtler branch beside the one on `currentState`.
 *
 * `currentState` is the whole decision. `LinkState` is a six-value state
 * machine; `reasonCode` is one of forty-odd strings that live in Agora's
 * vocabulary, so it is diagnostic text and never a branch — copying that list
 * here would only age into a staler copy of it.
 */
export interface RtmLinkStateEvent {
  currentState?: string;
  previousState?: string;
  operation?: string;
  reasonCode?: string;
  /**
   * `MESSAGE` or `STREAM`. Kept solely to ignore the other one: a stream
   * channel's link state is emitted on the SAME client, so a STREAM failure
   * would otherwise tear down a healthy message session.
   */
  serviceType?: string;
}

export interface RtmMessageEvent {
  publisher?: string;
  message?: unknown;
  customType?: string;
  timestamp?: number;
}

/** Seams for tests. Production callers pass nothing. */
export interface WebCastDeps {
  fetch?: typeof globalThis.fetch;
  createRtm?: (appId: string, uid: string) => Promise<WebCastRtmClient>;
  /**
   * Clock and timer, injectable because renewal is entirely time-driven: the
   * real lead time is 29 minutes, so a test that cannot move the clock can only
   * assert renewal by waiting for it.
   */
  now?: () => number;
  scheduleTimer?: (run: () => void, delayMs: number) => () => void;
}

/** Default timer: `setTimeout`, returning its own canceller. */
function defaultScheduleTimer(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  // A browser handle is a number and simply has no `unref`; under Node a pending
  // half-hour timer would otherwise hold the process open.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
}

type SessionData = {
  room_name?: string;
  room_limit?: number;
  room_member_index?: number;
  rtm_token?: string;
  rtm_token_expire_at?: number;
  /**
   * The player's real rezona user id as a decimal string — variable length, and
   * the same value the App logs in with. Never reformat, pad, or truncate it:
   * the token is signed for this exact string.
   */
  uid?: string;
  app_id?: string;
  username?: string;
  avatar_image?: string;
};

/** One live session's teardown handle — module state, like the native provider. */
type Session = {
  client: WebCastRtmClient;
  channelName: string | null;
  handler: ((msg: CastData) => void) | null;
  /** Stops this session's token renewal loop. Set once the session is live. */
  stopRenew: (() => void) | null;
  /**
   * Set when a terminal link state arrived while this attempt was still
   * connecting — the reason code, so the failure can name it. The connect
   * sequence reads it at its checkpoints; a live session never uses it (it is
   * torn down instead).
   */
  ended: string | null;
};

let session: Session | null = null;

/**
 * Which join attempt is the current one.
 *
 * A timeout only decides when `joinWebCast` returns — the connect sequence
 * underneath keeps going, and whatever it finishes afterwards is a client
 * nobody holds: still logged in as this user, still subscribed. Agora kicks the
 * older connection when the same uid logs in twice, so one orphan turns the
 * natural "retry after the 408" into "join works once, then never again", and
 * its listener delivers every remote message a second time.
 *
 * When a kick does happen — the orphan above, or the same account playing from
 * two devices — `onLinkState` is what notices and says so. Generations only
 * cover attempts this page started.
 *
 * Every attempt claims a generation; starting another attempt or disposing
 * bumps it. After each await the sequence checks whether it is still the
 * current generation and, if not, tears ITSELF down — the abandoning side
 * cannot do it, because it does not know how far the sequence got.
 */
let joinGeneration = 0;

function rejected(message: string, cause?: unknown): JoinFailedError {
  return new JoinFailedError(message, { cause, code: 500, kind: 'JoinRejectedError' });
}

const timedOut = (): JoinFailedError =>
  new JoinFailedError('Join timed out', { code: 408, kind: 'JoinTimeoutError' });

/**
 * No session in this browser — the player signs in and tries again.
 *
 * `code` stays 500 like every other rejection: that field carries the host's
 * classification (500 rejected / 408 timed out), and putting an HTTP 401 in it
 * would invite branching on the wrong thing. `kind` is the branch.
 */
const signInRequired = (): JoinFailedError =>
  new JoinFailedError('no user session', { code: 500, kind: SIGN_IN_REQUIRED });

/**
 * Load the Agora SDK lazily.
 *
 * Dynamic on purpose: inside the App the native bridge answers and this module
 * never runs, so the SDK must not sit in the main bundle that every multiplayer
 * game — App builds included — has to download.
 */
async function defaultCreateRtm(appId: string, uid: string): Promise<WebCastRtmClient> {
  const mod = (await import('agora-rtm-sdk')) as unknown as {
    RTM?: new (appId: string, uid: string) => WebCastRtmClient;
    default?: { RTM: new (appId: string, uid: string) => WebCastRtmClient };
  };
  const RTM = mod.RTM ?? mod.default?.RTM;
  if (!RTM) throw new Error('agora-rtm-sdk exposes no RTM constructor');
  return new RTM(appId, uid);
}

async function postJson<T>(
  doFetch: typeof globalThis.fetch,
  path: string,
  body: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(`${CAST_API_PREFIX}${path}`, {
      method: 'POST',
      // Explicit rather than relying on the same-origin default: a game hosted
      // elsewhere must still send the session cookie, or every join is 401.
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw rejected(`${path} request failed`, cause);
  }

  // The proxy authenticates with the browser's own session; without one there
  // is no identity to issue a token for, which is the App's `no user session`.
  //
  // Its own classification, and the only failure here that gets one: the player
  // can fix this by signing in (`signInUrl()`), while every other rejection is
  // something they can only retry.
  //
  // 401 ONLY. pgc has no 403 that means "not signed in" — its 403s are a banned
  // account, a PAT calling a browser-only endpoint, and a guest account that
  // needs upgrading (`CAST_ACCOUNT_UPGRADE_REQUIRED`, whose documented handling
  // is "引导升级为正式账号", a different action). Every one of those players IS
  // signed in, so offering them a sign-in link is a loop: they log in, come
  // back, and fail identically. Falling through instead keeps the envelope
  // `code` in the message, which is what actually names the cause. 401 already
  // covers both halves of "no session": no credential at all, and one the
  // upstream rejected.
  if (response.status === 401) throw signInRequired();

  // pgc's envelope: { success, code, message, data }. `code` is a STRING there
  // ("OK", "CAST_GAME_NOT_PUBLISHED", …), not the numeric 0 koubou's proxy used
  // to return — judge on `success`, and surface `code` because it is the stable,
  // greppable half of the failure.
  let envelope: { success?: boolean; code?: string; message?: string; data?: T } | undefined;
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch (cause) {
    throw rejected(`${path} returned no JSON`, cause);
  }
  if (!response.ok || envelope?.success !== true) {
    throw rejected(`${path} failed: ${envelope?.code ?? response.status}`);
  }
  return (envelope.data ?? {}) as T;
}

/**
 * `withTimeout` on an injected clock, for work whose deadline a test must drive.
 *
 * Same shape as `withTimeout`; it exists only because the renewal path's timers
 * are injectable and its real deadlines are minutes long.
 */
function withDeadline<T>(
  clock: { scheduleTimer: (run: () => void, delayMs: number) => () => void },
  delayMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let cancel: (() => void) | null = null;
  const alarm = new Promise<never>((_resolve, reject) => {
    cancel = clock.scheduleTimer(() => reject(timedOut()), delayMs);
  });
  return Promise.race([run(), alarm]).finally(() => cancel?.());
}

async function withTimeout<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alarm = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timedOut()), timeoutMs);
  });
  try {
    return await Promise.race([run(), alarm]);
  } finally {
    clearTimeout(timer);
  }
}

/** Release one client, best effort — teardown must never mask a failure. */
async function release(client: WebCastRtmClient, channelName: string | null): Promise<void> {
  try {
    if (channelName) await client.unsubscribe(channelName);
  } catch {
    /* already gone */
  }
  try {
    // Detach first where the SDK allows it: logout is asynchronous, and a
    // message delivered in between would reach a handler this session no
    // longer owns.
    client.removeEventListener?.('message', () => {});
  } catch {
    /* optional in the SDK surface */
  }
  try {
    await client.logout();
  } catch {
    /* already gone */
  }
}

/**
 * Invalidate every attempt in flight, and return the generation that did it.
 *
 * Must be called synchronously by whoever is taking over — two callers that
 * both bump after an await can end up claiming the SAME generation, and then
 * neither sees itself as abandoned.
 */
function claimGeneration(): number {
  joinGeneration += 1;
  return joinGeneration;
}

/** Drop the current session. Does not touch generations — see claimGeneration. */
async function disposeSession(): Promise<void> {
  const current = session;
  session = null;
  if (!current) return;
  // Before the awaits below: a renewal timer that fires mid-teardown would ask
  // pgc for a seat nobody is sitting in.
  current.stopRenew?.();
  current.stopRenew = null;
  await release(current.client, current.channelName);
}

/**
 * The one link state this session does not come back from.
 *
 * `FAILED` is where the SDK ends a session: a kick (`SERVER_REJECT` /
 * `SAME_UID_LOGIN` — Agora removes the older connection from every joined
 * channel when the same uid logs in again, and the uid is the player's real
 * rezona id, so "same account on both ends" produces exactly this), a login or
 * join that failed outright, and reconnection finally giving up
 * (`AUTO_RECONNECT` / `RECONNECT_TIMEOUT`). In the SDK's own emitter, `FAILED`
 * is also the only state that runs its end-of-session cleanup.
 *
 * `DISCONNECTED` is deliberately NOT here, though it reads like it belongs.
 * Every one of its emitters in agora-rtm-sdk 2.2.4 is a link the SDK is about to
 * restore: `HEARTBEAT_TIMEOUT` (immediately followed by RECONNECTING, then back
 * to `CONNECTED` / `RECONNECT_SUCCESS`), `NETWORK_CHANGE` (wifi to cellular),
 * and `SERVER_TIMEOUT` (which later degrades to `SUSPENDED`). Treating it as
 * terminal would turn one tunnel or one wifi handover into a permanent silent
 * drop — worse than the silence this whole path exists to remove, and worse than
 * the behaviour before it. `SUSPENDED` and `CONNECTING` are out for the same
 * reason. Nothing is lost by the narrowing: a link that really is done reaches
 * `FAILED` on its own.
 */
const TERMINAL_LINK_STATES = new Set(['FAILED']);

/** Diagnostic event name. NOT a contract — see `emitLinkStateDiagnostic`. */
const LINK_STATE_EVENT = 'rezona:cast-linkstate';

/**
 * Announce a dead session on `window`, for diagnostic builds only.
 *
 * The `Cast` contract has no disconnect surface, on purpose: the App host
 * protocol has no such event either, and a web-only callback would be exactly
 * the asymmetry the rest of this file works to avoid. But a kicked page that
 * shows nothing at all is what made a real cross-end test conclude "the two
 * ends are in different rooms", so the information has to leave the module
 * somehow. This event is that seam — the same kind of diagnostic peephole the
 * test game's fetch wrapper uses to display the room name. **Game code must not
 * build on it**; it carries no guarantee and the App never fires it.
 *
 * Carries the four non-sensitive fields only. No channel name, no token, no
 * uid: the room name is a credential (module header), and a diagnostic is the
 * last place it should surface.
 *
 * Every piece is optional at runtime — a page with no `window`, no
 * `dispatchEvent` (the unit tests' fake), or no `CustomEvent` must not take the
 * teardown down with it.
 */
function emitLinkStateDiagnostic(evt: RtmLinkStateEvent, currentState: string): void {
  const win = w();
  if (!win || typeof win.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  try {
    win.dispatchEvent(
      new CustomEvent(LINK_STATE_EVENT, {
        detail: {
          currentState,
          previousState: evt.previousState ?? '',
          operation: evt.operation ?? '',
          reasonCode: evt.reasonCode ?? '',
        },
      }),
    );
  } catch {
    /* diagnostics never break play */
  }
}

/**
 * React to one link-state change on the attempt that registered this handler.
 *
 * Three cases, and the generation tells them apart. An event from a generation
 * that is no longer current belongs to an attempt this page has abandoned or
 * replaced (a superseded session, or a slow orphan the retry left behind) — its
 * end is not news, and reporting it would announce a disconnect every time the
 * page re-joins or unloads. Our own `logout` is that case too, twice over: the
 * SDK reports `IDLE` for logout and leave, which is not terminal anyway.
 *
 * Within the current generation, the session may be live (`session === mine`) or
 * still connecting. Live: tear it down. Connecting: record it on the attempt, so
 * the connect sequence — the only side that knows how far it got — unwinds
 * itself at its next checkpoint and the join fails honestly. A kick can land
 * inside that window: the other end may already be holding this uid.
 *
 * Never claims a generation. A bump would invalidate an unrelated join already
 * in flight, and there is nothing here to invalidate.
 */
function onLinkState(mine: Session, generation: number, evt: RtmLinkStateEvent): void {
  if (generation !== joinGeneration) return;
  // A stream channel's link state rides the same emitter as the message
  // channel's. This provider only ever opens a message channel, so today the
  // guard is unreachable — and that is exactly why it is cheaper here than as a
  // future debugging session over a healthy session torn down by a STREAM event.
  if (evt.serviceType !== undefined && evt.serviceType !== 'MESSAGE') return;
  const currentState = String(evt.currentState ?? '');
  if (!TERMINAL_LINK_STATES.has(currentState)) return;
  // The one line that turns "multiplayer just stopped" into a lead. `reason`
  // is Agora's own code (`SAME_UID_LOGIN` for the same-account case).
  console.error(
    `cast link ${currentState} (operation=${evt.operation ?? '-'}, reason=${evt.reasonCode ?? '-'}) — session over`,
  );
  emitLinkStateDiagnostic(evt, currentState);
  if (session === mine) {
    void disposeSession();
    return;
  }
  // Still connecting. Recorded, not torn down here: the sequence checks this at
  // its next checkpoint and releases exactly what it has built so far.
  mine.ended = evt.reasonCode ? String(evt.reasonCode) : currentState;
}

/**
 * Keep this session's RTM token alive for as long as the session lasts.
 *
 * The web token's TTL is 30 minutes — half the App's, because this one lives in
 * a browser and the window is how long a leaked token can be used to take the
 * player's place. A normal session outlives it, so this is not an optimisation:
 * without renewal Agora drops the connection mid-game.
 *
 * Renewing means asking pgc for the session again. That call is idempotent by
 * contract — same player, same room, same seat, new token — so there is nothing
 * to reconcile locally beyond handing the token to Agora.
 *
 * Two triggers, deliberately: a timer computed from `rtm_token_expire_at`, and
 * the SDK's own `tokenPrivilegeWillExpire`. The timer is the main path — it has
 * the full lead time to work with. The event is the backstop for a response that
 * carried no usable expiry, and it arrives with only the margin left, which is
 * why it cannot be the primary trigger.
 */
function startRenewal(
  live: Session,
  requestBody: Record<string, unknown>,
  doFetch: typeof globalThis.fetch,
  clock: { now: () => number; scheduleTimer: (run: () => void, delayMs: number) => () => void },
  firstExpireAt: number | undefined,
): void {
  let cancel: (() => void) | null = null;
  let expireAt = firstExpireAt;
  let attempt = 0;
  let running = false;
  let stopped = false;
  /** Consecutive schedules that came out shorter than the lead itself. */
  let subLeadRuns = 0;

  const stop = (): void => {
    stopped = true;
    cancel?.();
    cancel = null;
  };
  // Registered before anything can fire, so teardown always has a way to stop
  // this loop — see disposeSession.
  live.stopRenew = stop;

  /** This loop belongs to ONE session; the module global says which is current. */
  const alive = (): boolean => !stopped && session === live;

  const arm = (delayMs: number): void => {
    cancel?.();
    cancel = clock.scheduleTimer(() => {
      cancel = null;
      void renew();
    }, Math.max(0, delayMs));
  };

  const armFromExpiry = (): void => {
    if (expireAt === undefined) return; // event-only: nothing to compute from
    const delayMs = expireAt * 1000 - RENEW_LEAD_MS - clock.now();
    // A lead that has already passed is NOT "renew right now". The expiry is
    // anchored to the server's clock, so a browser clock running more than
    // (TTL - lead) ahead computes the same negative lead after every renewal:
    // clamping it to zero would renew as fast as the network allows, for the
    // whole session, from every tab. The SDK's expiry event is server-driven and
    // immune to that, so it takes over as the only trigger.
    if (delayMs <= 0) return;
    // The same wrong clock one step less obvious: a browser running just UNDER
    // (TTL - lead) ahead stays on the positive side and recomputes the same
    // sub-lead delay after every successful renewal — a /session call every few
    // seconds for the whole session, from every tab. A single sub-lead delay is
    // legitimate (a token that really is nearly dead, which the retry ladder is
    // sized for); a run of them means the local clock cannot be scheduled from,
    // so hand over to the event exactly as a non-positive lead does.
    subLeadRuns = delayMs < RENEW_LEAD_MS ? subLeadRuns + 1 : 0;
    if (subLeadRuns > 1) return;
    arm(delayMs);
  };

  async function renew(): Promise<void> {
    // The timer and the event can land together; a doubled renewal would burn a
    // second seat request and race two tokens onto one client.
    if (!alive() || running) return;
    running = true;
    try {
      // Deadline on the injected clock, matching the join's reason for having
      // one: a request that never answers must become a failure we can retry,
      // not a renewal that silently never happens.
      const next = await withDeadline(clock, RENEW_REQUEST_TIMEOUT_MS, () =>
        postJson<SessionData>(doFetch, '/session', requestBody),
      );
      if (!alive()) return;
      if (!next.rtm_token) throw rejected('renewal returned no token');

      // An absent room name is a truncated answer, not a move: retryable, like
      // the missing token above it. Only a name that is present and different
      // is upstream's verdict about where this player belongs.
      if (!next.room_name) throw rejected('renewal returned no room');

      // A different room means upstream re-numbered the rooms (the assignment
      // key expired) and put this player somewhere else. That token is for a
      // channel we are not subscribed to, so renewing with it buys nothing —
      // and following the move would mean re-subscribing, which is reconnection,
      // not renewal.
      if (next.room_name !== live.channelName) {
        console.error('cast token renewal landed in another room; stopping');
        stop();
        return;
      }

      const nextExpireAt = readExpiry(next.rtm_token_expire_at, clock.now());
      // No forward progress — two renewals in the same second, or a briefly
      // cached upstream response. A failure, not a verdict: the token in hand
      // still has time on it, so go down the retry ladder rather than disabling
      // renewal for the rest of the session (which `stop()` would also do to the
      // SDK-event backstop).
      if (expireAt !== undefined && nextExpireAt !== undefined && nextExpireAt <= expireAt) {
        throw rejected('renewal did not extend the expiry');
      }

      await live.client.renewToken(next.rtm_token);
      if (!alive()) return;
      attempt = 0;
      expireAt = nextExpireAt;
      armFromExpiry();
    } catch (err) {
      if (!alive()) return;
      const backoff = RENEW_BACKOFF_MS[attempt];
      attempt += 1;
      const realExpiry = expireAt === undefined ? undefined : expireAt * 1000 + EXPIRY_MARGIN_MS;
      // The expiry bound is only as good as the clock it is compared against. An
      // expiry that has ALREADY passed locally, on a connection that is still
      // up, proves the local clock is wrong rather than the token dead — and
      // trusting it here would turn one failed request into a permanent stop(),
      // taking the SDK-event backstop down with it.
      const bound = realExpiry !== undefined && realExpiry > clock.now() ? realExpiry : undefined;
      // Out of rungs, or the next attempt would land after the token is already
      // dead. Either way the connection is going; the game sees it as the other
      // players ageing out, which the protocol already expresses.
      if (backoff === undefined || (bound !== undefined && clock.now() + backoff >= bound)) {
        console.error('cast token renewal gave up', err);
        stop();
        return;
      }
      console.error('cast token renewal failed, retrying', err);
      arm(backoff);
    } finally {
      running = false;
    }
  }

  // Never detached, deliberately: `stop()` makes the handler inert (`renew`
  // returns on `!alive()`), and the client it is attached to is discarded with
  // the session — so this retains one dead closure per abandoned client, not a
  // renewal that outlives its room.
  live.client.addEventListener('tokenPrivilegeWillExpire', () => {
    void renew();
  });
  armFromExpiry();
}

let unloadInstalled = false;

/**
 * Release the session when the page goes away.
 *
 * Without it Agora keeps the subscription, and the same user logging in again
 * from a reopened page kicks the stale connection — which looks like "join
 * works once, then never again". `pagehide` fires on bfcache navigations too,
 * where `beforeunload` does not.
 *
 * Still worth doing even though `onLinkState` now reports a kick: this is what
 * prevents the kick, and the reported one belongs to whoever got kicked — the
 * reopened page never learns that it displaced its own earlier self.
 */
function installUnloadRelease(): void {
  const win = w();
  if (!win || unloadInstalled) return;
  unloadInstalled = true;
  win.addEventListener('pagehide', () => {
    // Invalidate first: a join still connecting would otherwise finish after
    // the page is gone and leave a live subscription behind.
    claimGeneration();
    void disposeSession();
  });
}

/**
 * Wrap and broadcast one payload.
 *
 * Best-effort by contract: the game calls this from its loop and never awaits
 * it, so a send failure is logged and dropped rather than thrown.
 */
async function publishEnvelope(
  identity: { uid: string; username: string; avatarImage: string },
  payload: unknown,
): Promise<void> {
  const current = session;
  if (!current?.channelName) return;
  const envelope = {
    ...identity,
    data: payload,
    timestamp: Date.now(),
  };
  try {
    await current.client.publish(current.channelName, JSON.stringify(envelope), {
      // All three are load-bearing: a STREAM channel, a binary payload, or a
      // different customType and the App silently never sees the message.
      channelType: 'MESSAGE',
      customType: CAST_CUSTOM_TYPE,
    });
  } catch (err) {
    console.error('cast publish failed', err);
  }
}

/** Route one RTM message to the game, applying the App's field fallbacks. */
function onRtmMessage(evt: RtmMessageEvent, selfUid: string): void {
  // Agora delivers your own messages back to you. Without this the game runs
  // every local action twice.
  if (evt.publisher === selfUid) return;

  // Only our own envelope shape is parseable. A host that omits customType is
  // still trusted — dropping those would silently kill multiplayer against an
  // end that does not set it — but a DIFFERENT type is somebody else's message.
  if (evt.customType && evt.customType !== CAST_CUSTOM_TYPE) return;

  const handler = session?.handler;
  if (!handler) return;

  let decoded: unknown;
  try {
    decoded = typeof evt.message === 'string' ? JSON.parse(evt.message) : evt.message;
  } catch (err) {
    console.error('cast message decode failed', err);
    return;
  }
  if (typeof decoded !== 'object' || decoded === null) return;

  const msg = decoded as Partial<CastData>;
  handler({
    // Agora stamps `publisher` against the token that logged in; the envelope's
    // own `uid` is just what the sender typed. The host contract words this the
    // other way round (envelope first, publisher as fallback), and taking the
    // signed value instead is invisible on the wire — an honest client sends
    // the same string in both. A dishonest one would otherwise claim any uid,
    // including "", which wins pickSharedOwnerUid outright and takes over every
    // piece of owner-published shared state.
    uid: String(evt.publisher ?? msg.uid ?? ''),
    username: String(msg.username ?? ''),
    avatarImage: String(msg.avatarImage ?? ''),
    data: msg.data,
    timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
  });
}

/**
 * Join a broadcast session from a plain browser.
 *
 * Sequence and error classification mirror the App exactly: room assignment
 * happens BEFORE the timeout window (so a slow or rejected room is `500`, never
 * `408`), and only token + login + subscribe run under `timeoutMs`. Getting
 * this boundary wrong is the one way two ends can disagree about what failed.
 */
export async function joinWebCast(options: CastJoinOptions, deps: WebCastDeps = {}): Promise<Cast> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const createRtm = deps.createRtm ?? defaultCreateRtm;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Claimed before the first await: two joins started in the same tick (a
  // double-clicked button, React StrictMode's double invoke) must not end up
  // holding the same generation, or neither recognises itself as superseded and
  // both connect.
  const generation = claimGeneration();
  const abandoned = () => generation !== joinGeneration;

  await disposeSession();

  const ref = resolvePreviewRef();
  // Names BOTH dimensions on purpose: since versions shard rooms, this branch now fires
  // for a missing/implausible version just as often as for a missing code, and an author
  // debugging "multiplayer stopped working on my share link" needs to know which.
  if (ref === null) throw rejected('preview reference not resolvable (needs code + version)');

  // Setup sits OUTSIDE the join timeout, so anything wrong with it is a rejected
  // join (500), never a timed out one (408) — 408 means the Agora connect
  // sequence stalled, and that distinction is what keeps web and App error codes
  // aligned. It still needs a deadline of its own, or a hung request would hang
  // the join forever; blowing that deadline is a rejection too.
  // Kept, not rebuilt: renewal asks for the SAME session, and a request that
  // differed by a field would be a request for a different room.
  const requestBody: Record<string, unknown> = {
    // Whichever shape this page's URL is written in; pgc accepts both.
    ...(('code' in ref) ? { code: ref.code } : { user_id: ref.userId, project_id: ref.projectId }),
    // Which version directory this page is running out of. pgc keys the room on
    // (preview, version) so that two versions never share one — see the note on
    // `PreviewRef`. Pinned here rather than re-read at renewal time: a body that
    // differed by this field would be a request for a different room.
    version_id: ref.version,
    // Clamped, not passed through: pgc bounds this at 1..100 and 422s anything outside,
    // which in a browser is just another opaque "join rejected" with nothing pointing at
    // the cause. Clamping is not overriding the author — the field is a *hint* and the
    // effective cap comes back in the response, so `maxUsers: 200` means "as many as the
    // backend allows" and ROOM_LIMIT_MAX is that.
    room_limit: Math.min(Math.max(Math.trunc(options.maxUsers) || 1, 1), ROOM_LIMIT_MAX),
  };

  const identity = await withTimeout(timeoutMs, () =>
    postJson<SessionData>(doFetch, '/session', requestBody),
  ).catch((cause: unknown) => {
    // Only the deadline itself is rewritten here: a slow setup is a rejected
    // join, never a 408 (see the tests around the connect sequence). Every other
    // classification the request already produced passes through unchanged —
    // listing the ones to keep instead would silently swallow the next one added,
    // which is exactly what happened to `SIGN_IN_REQUIRED` on its way in.
    if (cause instanceof JoinFailedError && cause.kind !== 'JoinTimeoutError') throw cause;
    throw rejected('cast session request timed out', cause);
  });

  // Destructured before use, not read off `identity` at each site: narrowing an
  // optional property does not survive into the callbacks below, and the checks
  // would have to be repeated (or silently coerced) inside each one.
  const channelName = identity.room_name;
  const { rtm_token: rtmToken, app_id: appId, uid } = identity;
  if (!channelName) throw rejected('cast session returned no room_name');
  if (!rtmToken || !appId || !uid) throw rejected('cast session response is incomplete');

  let client: WebCastRtmClient | null = null;
  let established: Session | null = null;
  try {
    await withTimeout(timeoutMs, async () => {
      if (abandoned()) throw rejected('join superseded');

      const connecting = await createRtm(appId, uid);
      client = connecting;
      // Abandoned before it ever connected: nothing to unwind but the client.
      if (abandoned()) {
        await release(connecting, null);
        throw rejected('join superseded');
      }

      const mine: Session = {
        client: connecting,
        channelName: null,
        handler: null,
        stopRenew: null,
        ended: null,
      };
      connecting.addEventListener('message', (evt) => {
        // Gated on identity, not on the module global: an abandoned client
        // whose logout has not landed yet must not feed the live session's
        // handler, or every remote message arrives twice.
        if (session !== mine) return;
        onRtmMessage(evt, uid);
      });
      // Before login, on purpose: the other end may already be holding this uid,
      // so a kick can land inside the connect window. Gated on the generation
      // rather than on `session` — during this window there is no live session to
      // compare against, and a terminal event here has to reach the checkpoints
      // below instead of being dropped.
      connecting.addEventListener('linkState', (evt) => onLinkState(mine, generation, evt));

      await connecting.login({ token: rtmToken });
      if (abandoned()) {
        await release(connecting, null);
        throw rejected('join superseded');
      }
      // The link ended while we were connecting — most often this uid being
      // taken by the other end. Failing here is the point: the alternative is
      // handing the game a Cast that can never hear anyone, which is the exact
      // silence this file's link-state handling exists to remove.
      if (mine.ended) {
        await release(connecting, null);
        throw rejected(`cast link ended during join (${mine.ended})`);
      }

      // Verbatim: the backend hands both ends the same string, and any prefix
      // or case change here is a room the App players are not in.
      await connecting.subscribe(channelName, { withMessage: true, withPresence: false });
      if (abandoned()) {
        await release(connecting, channelName);
        throw rejected('join superseded');
      }
      if (mine.ended) {
        await release(connecting, channelName);
        throw rejected(`cast link ended during join (${mine.ended})`);
      }
      mine.channelName = channelName;
      established = mine;
    });
  } catch (err) {
    // Stop this attempt's own sequence if it is still running: it checks after
    // each await and unwinds itself, because only it knows how far it got.
    // Guarded, or a slow attempt failing late would invalidate the NEWER join
    // that superseded it and both would fail.
    if (!abandoned()) claimGeneration();
    // Roll back what this attempt finished before the failure. A sequence that
    // is still running will unwind itself at its next checkpoint.
    const live = client as WebCastRtmClient | null;
    if (live && !established) await release(live, null);
    throw err instanceof JoinFailedError ? err : rejected(String(err), err);
  }

  const live = established as Session | null;
  if (!live) throw rejected('join superseded');

  const username = String(identity.username ?? '');
  const avatarImage = String(identity.avatar_image ?? '');
  session = live;
  // After `session = live`, because the renewal loop's liveness check is exactly
  // "am I still the current session".
  const renewClock = {
    now: deps.now ?? Date.now,
    scheduleTimer: deps.scheduleTimer ?? defaultScheduleTimer,
  };
  startRenewal(
    live,
    requestBody,
    doFetch,
    renewClock,
    // Same filter every renewal response goes through: one unusable field (NaN,
    // Infinity, 0, or a value so far out it can only be the wrong unit) must
    // degrade to "no expiry, use the event", never to a bogus deadline.
    readExpiry(identity.rtm_token_expire_at, renewClock.now()),
  );
  installUnloadRelease();

  return {
    uid,
    username,
    avatarImage,
    // Fixed at 12s to match the App. Not a knob — see the header note.
    staleAfterMs: STALE_AFTER_MS,
    publish(payload: unknown) {
      // Bound to the session this handle came from. Resolving the module global
      // instead would let a handle kept across a re-join (a ref held by a "play
      // again" flow) silently publish into the NEW room.
      if (session !== live) return;
      void publishEnvelope({ uid, username, avatarImage }, payload);
    },
    subscribe(handler: (msg: CastData) => void) {
      // One handler, last wins — the protocol has no unsubscribe.
      if (session !== live) return;
      live.handler = handler;
    },
  };
}
