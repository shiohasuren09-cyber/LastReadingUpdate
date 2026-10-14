// ──────────────────────────────────────────────
// net/cast.ts — Rezona cast transport provider (JS Bridge action protocol)
// ──────────────────────────────────────────────
//
// Adapts the host's `castJoin` / `castPublish` actions and its `castMessage`
// event into the `Cast` contract from `protocol.ts`. The protocol, its types,
// and every transport-agnostic helper live there — do not move them here.
//
// TRANSPORT (identical to the shipped purchase module and device bridge):
//   H5 -> host : window.webkit.messageHandlers.rezonaBridge.postMessage(obj)   (iOS/native)
//                window.rezonaBridge.postMessage(JSON string)                  (Flutter shim)
//   host -> H5 : window.RezonaBridge.onNativeResponse({requestId, code, message, data})
//
// `window.RezonaBridge` is created BY THE PAGE, not injected by the host. An
// earlier version of this file expected the host to inject a rich
// `RezonaBridge.cast.join()` object; no host ever did, which is why every real
// device reported "no bridge". Action names are matched case-insensitively.
//
// Available only where a host bridge exists (the Rezona App, or a web wrapper
// page that implements the same actions). In a plain browser `hasCast()` is
// false — gate multiplayer UI on it and keep single-player fully playable.

import {
  JoinFailedError,
  type Cast,
  type CastData,
  type CastJoinOptions,
} from './protocol.ts';
// Static import, but only of the provider's cheap probe — the Agora SDK itself
// is loaded by `webCast.ts` behind a dynamic import, so the App never pays for
// a transport it does not use.
import { hasWebCast, signInUrl } from './webCast.ts';

/**
 * Re-exported so game code keeps importing `net/cast` and nothing else.
 *
 * Free: this module already imports the provider statically for `hasWebCast`
 * (only the Agora SDK sits behind the dynamic import below), and `signInUrl` is
 * a pure function over `location`. On the App this returns an address nobody
 * needs — the sign-in classification never arrives there.
 */
export { signInUrl };

type Envelope = { requestId?: string; code?: number; message?: string; data?: unknown }
type CastEvent = { event?: string; uid?: string; username?: string; avatarImage?: string; data?: unknown; timestamp?: number }

type BridgeWindow = Window & {
  webkit?: { messageHandlers?: { rezonaBridge?: { postMessage(v: unknown): void } } };
  rezonaBridge?: { postMessage(v: string): void };
  RezonaBridge?: Record<string, unknown> & {
    onNativeResponse?: (r: Envelope & CastEvent) => void;
    onNativeEvent?: (r: CastEvent) => void;
  };
};

const w = (): BridgeWindow | undefined =>
  typeof window === 'undefined' ? undefined : (window as BridgeWindow);

/** Fixed by the host; see the integration spec's "keep it consistent" section. */
const STALE_AFTER_MS = 12_000;
const DEFAULT_TIMEOUT_MS = 10_000;

let seq = 0;
const pending = new Map<string, (env: Envelope) => void>();

/** The single live subscriber, matching the protocol's one-handler rule. */
let castHandler: ((msg: CastData) => void) | null = null;
let installed = false;

/** Route one host payload: a pending response, or a pushed castMessage. */
function dispatch(payload: (Envelope & CastEvent) | undefined): boolean {
  if (!payload || typeof payload !== 'object') return false;

  // Events first: a castMessage that also carried a requestId would otherwise
  // be consumed as somebody's response and never reach the game. Its own shape
  // decides the route, not the order it happens to arrive in.
  if (String(payload.event ?? '').toLowerCase() === 'castmessage') {
    castHandler?.({
      uid: String(payload.uid ?? ''),
      username: String(payload.username ?? ''),
      avatarImage: String(payload.avatarImage ?? ''),
      data: payload.data,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
    });
    return true;
  }

  const id = payload.requestId;
  if (typeof id === 'string' && pending.has(id)) {
    const resolve = pending.get(id)!;
    pending.delete(id);
    resolve(payload);
    return true;
  }
  return false;
}

/**
 * Listen on every plausible delivery path.
 *
 * The host contract documents the castMessage payload but not how it reaches
 * the page, so we accept all three shapes rather than guess one: chained
 * `onNativeResponse`, a dedicated `onNativeEvent`, and `postMessage` from a
 * wrapper frame. Chaining (never replacing) keeps the purchase module and the
 * device bridge working when they share the page.
 */
function install(): void {
  const win = w();
  if (!win || installed) return;
  installed = true;

  const bridge = (win.RezonaBridge = win.RezonaBridge ?? {});

  // Chain onto whoever already owns the slot — but ONLY if our assignment
  // actually took. The purchase module pins `onNativeResponse` as an accessor
  // whose getter returns its own dispatcher and whose setter files us into its
  // foreign-hook chain instead of replacing it. Blindly calling the captured
  // "previous" handler would then call purchase's dispatcher, which calls us
  // again: measured 3890 re-entries (and a caught RangeError) from ONE response.
  // If the getter does not hand our function back, the owner will invoke us and
  // we must not invoke it.
  let chainResponse = false;
  const prevResponse = bridge.onNativeResponse;
  const ourResponse = (payload: Envelope & CastEvent) => {
    if (dispatch(payload)) return;
    if (chainResponse) prevResponse?.(payload);
  };
  bridge.onNativeResponse = ourResponse;
  chainResponse = bridge.onNativeResponse === ourResponse;

  let chainEvent = false;
  const prevEvent = bridge.onNativeEvent;
  const ourEvent = (payload: CastEvent) => {
    if (dispatch(payload)) return;
    if (chainEvent) prevEvent?.(payload);
  };
  bridge.onNativeEvent = ourEvent;
  chainEvent = bridge.onNativeEvent === ourEvent;

  win.addEventListener('message', (ev: MessageEvent) => {
    // Only the wrapper frame that hosts this game may speak for the bridge.
    // Without this, any co-resident frame could post a castMessage and appear
    // as a remote player, or forge an envelope resolving a pending request.
    if (ev.source !== win.parent || ev.source === win) return;
    const raw = ev.data;
    if (typeof raw === 'string') {
      try {
        dispatch(JSON.parse(raw));
      } catch {
        /* not ours */
      }
      return;
    }
    dispatch(raw as CastEvent);
  });
}

function sendChannel(): 'webkit' | 'flutter' | null {
  const win = w();
  if (!win) return null;
  if (win.webkit?.messageHandlers?.rezonaBridge) return 'webkit';
  if (typeof win.rezonaBridge?.postMessage === 'function') return 'flutter';
  return null;
}

/**
 * Can this page join a cast session?
 *
 * True inside a Rezona host (a send channel exists), and true in a plain browser
 * whose URL yields a preview reference — a code (or legacy id pair) **and** the
 * version directory it is running out of. There `webCast.ts` speaks Agora RTM
 * directly and lands in the SAME room as the App players on that same published
 * version. Still the single gate game code gates its multiplayer UI on; which
 * provider answers is not the game's business.
 *
 * Not `gameId`: that is the App's notion, resolved server-side from the preview
 * reference. The page never names a room.
 *
 * Says nothing about being signed in, deliberately: a signed-out visitor should
 * still see the multiplayer entry point, with a sign-in offer on it. That case
 * arrives from `joinCast` as `SIGN_IN_REQUIRED` — see `signInUrl`.
 */
export function hasCast(): boolean {
  return sendChannel() !== null || hasWebCast();
}

/**
 * Post one action and forget it — no pending entry, no timer.
 *
 * `publish` is called on every state change (tens of times a second in a real
 * game loop) and nothing consumes its response. Routing it through
 * `callAction` would park a closure plus a 10s timer per call: at 30 publishes
 * a second that is ~300 live timers and map entries at steady state, all of
 * them destined to time out and be swallowed. Measured: 200 publishes left 200
 * outstanding timers.
 */
function postAction(action: string, params: Record<string, unknown>): void {
  const channel = sendChannel();
  const win = w();
  if (!channel || !win) return;

  const payload = { action, requestId: `cast-${action}-${Date.now()}-${++seq}`, version: '1.0', params };
  try {
    if (channel === 'webkit') win.webkit!.messageHandlers!.rezonaBridge!.postMessage(payload);
    else win.rezonaBridge!.postMessage(JSON.stringify(payload));
  } catch {
    // Best-effort by contract: a failed send must never reach the game.
  }
}

function callAction(action: string, params: Record<string, unknown>, timeoutMs: number): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const channel = sendChannel();
    const win = w();
    if (!channel || !win) return reject(new JoinFailedError('bridge unavailable'));

    install();
    const requestId = `cast-${action}-${Date.now()}-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new JoinFailedError('Join timed out', { code: 408, kind: 'JoinTimeoutError' }));
    }, timeoutMs);

    pending.set(requestId, (env) => {
      clearTimeout(timer);
      resolve(env);
    });

    const payload = { action, requestId, version: '1.0', params };
    try {
      if (channel === 'webkit') win.webkit!.messageHandlers!.rezonaBridge!.postMessage(payload);
      else win.rezonaBridge!.postMessage(JSON.stringify(payload));
    } catch (cause) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new JoinFailedError('bridge send failed', { cause, code: 500, kind: 'JoinRejectedError' }));
    }
  });
}

/**
 * Join a broadcast session.
 *
 * Resolves to a `Cast` synthesised from the host's join response, so game code
 * and the pure helpers in `protocol.ts` stay transport-agnostic. Every failure
 * arrives as `JoinFailedError`, carrying the host's `code` (500 rejected /
 * 408 timed out) and `kind` for diagnostics.
 *
 * One `kind` is browser-only: `SIGN_IN_REQUIRED`, when the page has no session.
 * A host bridge never produces it — an App player is signed in natively — so
 * write that branch as one the App simply never takes, and pair it with
 * `signInUrl()` from the web provider. Everything else stays one retry path.
 */
export async function joinCast(options: CastJoinOptions): Promise<Cast> {
  // No host bridge: hand over to the web provider, which speaks Agora RTM
  // itself and lands in the same backend-assigned room the App players are in.
  // Loaded here rather than at module scope so the Agora SDK only ships to the
  // pages that actually need it.
  // Past this point a send channel exists, so the old "cast bridge
  // unavailable" guard would be unreachable — the web provider now owns every
  // no-bridge case and reports the host's own verdict instead.
  if (sendChannel() === null) {
    const { joinWebCast } = await import('./webCast.ts');
    return joinWebCast(options);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const params: Record<string, unknown> = { maxUsers: options.maxUsers, timeoutMs };
  if (options.gameId !== undefined) params.gameId = options.gameId;

  const env = await callAction('castJoin', params, timeoutMs);
  const data = (env.data ?? {}) as {
    uid?: string
    username?: string
    avatarImage?: string
    staleAfterMs?: number
    name?: string
  };

  if (env.code !== 0) {
    throw new JoinFailedError(env.message || 'join rejected', {
      code: env.code,
      kind: data.name ?? (env.code === 408 ? 'JoinTimeoutError' : 'JoinRejectedError'),
    });
  }

  // A Cast only exists after a successful join, so publish needs no "have we
  // joined yet" guard, and subscribe needs no install() — callAction already
  // installed the listeners on the way in.
  return {
    uid: String(data.uid ?? ''),
    username: String(data.username ?? ''),
    avatarImage: String(data.avatarImage ?? ''),
    staleAfterMs: typeof data.staleAfterMs === 'number' ? data.staleAfterMs : STALE_AFTER_MS,
    publish(payload: unknown) {
      // Best-effort by contract: a failed send must never throw at the game,
      // and must not accumulate state (see postAction).
      postAction('castPublish', { data: payload });
    },
    subscribe(handler: (msg: CastData) => void) {
      // One handler, last wins — the protocol has no unsubscribe.
      castHandler = handler;
    },
  };
}
