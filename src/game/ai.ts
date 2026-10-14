// Enemy AI — uses only publicState() (scores + remaining counts).
// Never accesses the deck or its order; throws if given any card identity.
import { RULES, type CardKind } from './config'
import type { PublicState, Owner } from './rules'

/** Per-round mistake rates. Index by roundN (1-based, capped at 3). */
const MISTAKE = [0, 0.50, 0.35, 0.20]

/** Expected value of the next card from remaining counts. */
function meanValue(rem: PublicState['remaining']): number {
  const total = rem.boon + rem.bane + rem.blank
  if (total <= 0) return 0
  return (rem.boon - rem.bane) / total
}

/**
 * Decide whether to keep (target='me' from AI's frame) or give.
 * AI's frame: self = 'me', player = 'her'.
 * Returns the owner in AI-frame: 'me' = AI keeps, 'her' = AI gives.
 */
export function aiDecide(state: PublicState, rng: () => number): Owner {
  const ev = meanValue(state.remaining)
  let keep: boolean
  if (ev > 0) keep = true         // boons likely → keep
  else if (ev < 0) keep = false    // banes likely → give
  else keep = rng() < 0.5          // zero expectation → random

  // A mistake is a *random* choice (not an inverted one), per the brief.
  const mistake = MISTAKE[Math.min(state.roundN, 3)] ?? 0.20
  if (rng() < mistake) keep = rng() < 0.5

  return keep ? 'me' : 'her'
}

/** Think time: 0.6–1.2s; up to 1.6s in Round 1. */
export function thinkDelay(roundN: number, rng: () => number): number {
  const max = roundN === 1 ? RULES.aiThinkRound1Max : RULES.aiThinkMax
  return RULES.aiThinkMin + rng() * (max - RULES.aiThinkMin)
}
