// Scripted tutorial. Runs on a phantom table state (DemoState) that never
// touches the live Match. Lines V01–V14; the hand is fixed:
//   D1 Bane, D2 Boon, D3 Blank, D4 Boon, D5 Bane, D6 Boon, D7 Bane.
// Phantom A sits in your seat, B across. Final: A +1, B −1 → A wins.
import type { Owner } from './rules'
import type { LineId } from './voice'

export type DemoKind = 'bane' | 'boon' | 'blank'
export const DEMO_HAND: DemoKind[] = ['bane', 'boon', 'blank', 'boon', 'bane', 'boon', 'bane']

export interface DemoState {
  a: number // phantom A fortune (your seat)
  b: number // phantom B fortune
  cardsLeft: number
  /** Currently animating card: index into DEMO_HAND, or -1. */
  card: number
  holder: Owner | null
  target: Owner | null
  revealed: boolean
}

export const demoInit = (): DemoState => ({ a: 0, b: 0, cardsLeft: DEMO_HAND.length, card: -1, holder: null, target: null, revealed: false })

/** One beat of the script. `hl` = highlight keys for the focus mask. */
export interface DemoBeat {
  line?: LineId
  /** Phantom draws a card (A = 'me', B = 'her'). */
  draw?: Owner
  /** Phantom places the held card on a mat. */
  place?: Owner
  /** Reveal + apply the held card. */
  reveal?: boolean
  hl?: ('deck' | 'mat_me' | 'mat_her' | 'scale' | 'beads' | 'candles' | 'door' | 'trap')[]
  /** Beat duration (s) after voice ends. */
  hold?: number
}

/** Who ends up with each card per the brief. */
export const DEMO_SCRIPT: DemoBeat[] = [
  { line: 'v01', hl: [], hold: 0.4 },
  { line: 'v02', hl: ['mat_me', 'mat_her', 'scale'], hold: 0.4 },
  { line: 'v03', hl: ['deck'], draw: 'me', hold: 0.3 },               // A lifts D1
  { line: 'v04', hl: ['mat_me', 'mat_her'], place: 'her', hold: 0.2 }, // A gives to B
  { line: 'v05', hl: ['scale'], reveal: true, hold: 0.5 },             // D1 Bane → B −1
  { draw: 'her', place: 'her', hold: 0.2 },                            // B takes D2, keeps
  { line: 'v06', hl: ['scale'], reveal: true, hold: 0.5 },             // D2 Boon → B 0
  { draw: 'me', place: 'me', hold: 0.2 },                              // A takes D3, keeps
  { line: 'v07', hl: ['deck'], reveal: true, hold: 0.4 },              // D3 Blank → draw again
  { draw: 'me', place: 'me', hold: 0.2 },                              // A takes D4, keeps
  { line: 'v08', hl: ['scale', 'mat_me'], reveal: true, hold: 0.5 },   // D4 Boon → A +1
  { line: 'v09', hl: ['beads'], hold: 0.6 },
  { draw: 'her', place: 'her', hold: 0.2 },                            // B takes D5, keeps
  { line: 'v10', hl: ['scale', 'mat_her'], reveal: true, hold: 0.5 },  // D5 Bane → B −1
  { draw: 'me', place: 'me', reveal: true, hold: 0.5 },                // A keeps D6 Boon → A +2
  { draw: 'her', place: 'me', reveal: true, hold: 0.5 },               // B gives D7 Bane → A +1
  { line: 'v11', hl: ['scale', 'beads'], hold: 0.5 },
  { line: 'v12', hl: ['scale'], hold: 0.4 },
  { line: 'v13', hl: ['candles', 'door', 'trap'], hold: 0.5 },
  { line: 'v14', hl: ['deck'], hold: 0.6 },
]

export const DEMO_VALUE: Record<DemoKind, number> = { boon: 1, bane: -1, blank: 0 }

/** Apply the current card to the demo state (pure). */
export function demoApply(s: DemoState): DemoState {
  if (s.card < 0 || !s.target) return s
  const v = DEMO_VALUE[DEMO_HAND[s.card]]
  return {
    ...s,
    a: s.target === 'me' ? s.a + v : s.a,
    b: s.target === 'her' ? s.b + v : s.b,
    revealed: true,
  }
}

/** Expected end state — selfTest asserts the script lands here. */
export const DEMO_EXPECT = { a: 1, b: -1 }
