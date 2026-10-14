// Pure rules engine — no items, no wheel, strictly blind deck.
// All functions are pure transformations of plain state objects.
// The AI is given only publicState(); nothing here exposes deck order.
import { CARD_DEFS, RULES, type CardDef, type CardKind } from './config'

// ── owner ─────────────────────────────────────────────────────────────────────

export type Owner = 'me' | 'her'

// ── score & bead state ────────────────────────────────────────────────────────

export interface ScoreState {
  myScore: number
  herScore: number
}

export interface BeadState {
  cardsLeft: number
  cardsTotal: number
}

export function removeBead(state: BeadState): BeadState {
  return { ...state, cardsLeft: Math.max(0, state.cardsLeft - 1) }
}

// ── resolve ───────────────────────────────────────────────────────────────────

export interface ResolveResult {
  newScore: ScoreState
  /** placedBy again if blank (same player draws again); null if turn passes. */
  nextTurn: Owner | null
  leader: Owner | null
  beamDeg: number
  myGlow: boolean
  herGlow: boolean
}

export function resolveCard(
  def: CardDef,
  recipient: Owner,
  score: ScoreState,
  placedBy: Owner,
): ResolveResult {
  const next = { ...score }
  if (def.value !== 0) {
    if (recipient === 'me') next.myScore += def.value
    else next.herScore += def.value
  }
  const blank = def.kind === 'blank'
  return {
    newScore: next,
    nextTurn: blank ? placedBy : null,
    ...scaleTilt(next),
  }
}

// ── scale tilt ────────────────────────────────────────────────────────────────

export interface TiltResult {
  leader: Owner | null
  beamDeg: number
  myGlow: boolean
  herGlow: boolean
}

export function scaleTilt(score: ScoreState): TiltResult {
  const diff = score.myScore - score.herScore
  const beamDeg = Math.max(-RULES.scaleClampDeg, Math.min(RULES.scaleClampDeg, diff * RULES.scaleDegPerPoint))
  const leader: Owner | null = diff > 0 ? 'me' : diff < 0 ? 'her' : null
  return { leader, beamDeg, myGlow: leader === 'me', herGlow: leader === 'her' }
}

// ── public state (only what the AI may see) ───────────────────────────────────

export interface PublicState {
  roundN: number
  cardsLeft: number
  myScore: number  // AI's score
  herScore: number // player's score
  remaining: { boon: number; bane: number; blank: number }
}

// ── RNG ───────────────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function fisherYates<T>(a: readonly T[], rng: () => number): T[] {
  const r = [...a]
  for (let i = r.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

// ── deck mixes — R1: 7 (3/3/1), R2: 9 (3/5/1), R3: 11 (3/7/1) ───────────────

export const ROUND_MIX: readonly { boon: number; bane: number; blank: number }[] = [
  { boon: 3, bane: 3, blank: 1 },
  { boon: 3, bane: 5, blank: 1 },
  { boon: 3, bane: 7, blank: 1 },
]

export function buildDeck(roundIdx: number, rng: () => number): CardDef[] {
  const mix = ROUND_MIX[Math.min(roundIdx, ROUND_MIX.length - 1)]
  const pick = (kind: CardKind, n: number) => {
    const pool = CARD_DEFS.filter((d) => d.kind === kind)
    const idx = fisherYates(pool.map((_, i) => i), rng)
    return idx.slice(0, Math.min(n, pool.length)).map((i) => pool[i])
  }
  return fisherYates([
    ...pick('boon', mix.boon),
    ...pick('bane', mix.bane),
    ...pick('blank', mix.blank),
  ], rng)
}

// ── round winner (tie → first player wins) ────────────────────────────────────

export function roundWinner(score: ScoreState, firstPlayer: Owner): Owner {
  if (score.myScore > score.herScore) return 'me'
  if (score.herScore > score.myScore) return 'her'
  return firstPlayer // tie: whoever went first wins
}
