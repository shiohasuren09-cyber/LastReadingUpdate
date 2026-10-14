// ──────────────────────────────────────────────
// net/config.ts — tunables for multiplayer sessions
// ──────────────────────────────────────────────
//
// There is no "multiplayer on/off" flag here, and that is deliberate: a game is
// single-player exactly when nothing imports `src/net/**`. Vite never bundles a
// module no one imports, so non-import IS the switch — a flag would only be a
// second, weaker copy of that truth, and gating on one that was never flipped
// would let the bundler dead-code-eliminate the whole net layer, silently
// dropping you back to single-player with no error.
//
// The only way to add multiplayer is the user invoking the `/multiplayer` skill.
// The agent must never wire it on its own — see the game-kit skill's
// references/interactions/multiplayer.md.

/**
 * Player cap hint for a broadcast session.
 *
 * Only a sharding hint for the transport — the protocol never tells the page a
 * session is full, so do not build "room full" UI on it.
 */
export const MAX_USERS = 4;

/** How long to wait for `joinCast`, in ms. Omit to let the transport decide. */
export const JOIN_TIMEOUT_MS = 10_000;

// The cast endpoint used to be configured here. It moved into `webCast.ts`
// deliberately: this file is the one net file a game MAY tune (player cap, join
// timeout), while the endpoint is part of the platform contract — pinning it
// next to its only caller is what lets `seed_template.py` refresh the provider
// in existing workspaces without touching anything a game owns.
