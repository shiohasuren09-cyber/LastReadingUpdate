// All narrator and tutorial lines. No item, deal, or skip lines.
import { assertSupported } from './font'
import type { CardDef } from './config'
import type { LineId } from './voice'
import type { Owner } from './rules'

export const LINES: Record<Exclude<LineId, 'custom'>, string> = {
  // Round goals
  goal1: 'Round 1. Have more gold than your rival when the cards run out.',
  goal2: 'Round 2. Have more gold than your rival when the cards run out.',
  goal3: 'Round 3. Have more gold than your rival when the cards run out.',

  // Idle hints
  hint_deck:  'Touch the glowing deck.',
  hint_place: 'Keep it, or give it to him?',

  // Help objects
  help_scale:   'More gold on your side wins the round.',
  help_beads:   'These are the cards left: gold, black and white.',
  help_candles: 'Win two rounds to open the door.',
  help_door:    'Win two rounds and you go free.',
  help_trap:    'Lose, and the floor opens.',

  // Round/match outcomes
  round_end_win:  'The scale tips in your favor.',
  round_end_lose: 'The scale falls against you.',
  round_end_tie:  'Level. The one who drew first wins.',
  match_win:      'The lock breaks. You are free.',
  match_lose:     'The chains tighten. You are his.',

  // Placeholder — real reveal text is built by revealLine().
  reveal: 'The card is revealed.',

  // Tutorial lines V01–V14 (each ≤60 chars)
  v01: 'Come. Let me show you how a reading is played.',
  v02: 'Two captives. One deck. More gold wins the round.',
  v03: 'Touch the deck to take a card. You cannot see it.',
  v04: 'Then keep it, or give it to your rival. A gamble!',
  v05: 'A black Bane is misfortune. The scale tips to you.',
  v06: 'A gold Boon is fortune. He keeps it. Even again.',
  v07: 'A white card is nothing. Draw again.',
  v08: 'A Boon for you! The scale tips your way.',
  v09: 'The beads show the cards left. Count them to guess well!',
  v10: 'Unlucky for him. A Bane lands on his side.',
  v11: 'The deck is empty. More gold wins the round.',
  v12: 'If it ends level, whoever drew first wins.',
  v13: 'Win two rounds and the iron door opens. Lose, and the floor does.',
  v14: 'Now it is your turn. Take the seat.',
}

/** Spoken after a card flips: name, kind, signed value, who received it. */
export function revealLine(def: CardDef, target: Owner): string {
  const val = def.value > 0 ? `plus ${def.value}` : def.value < 0 ? `minus ${Math.abs(def.value)}` : 'zero'
  const kind = def.kind === 'boon' ? 'a gold Boon' : def.kind === 'bane' ? 'a black Bane' : 'a white Blank'
  const who = target === 'me' ? 'for you' : 'for him'
  return `${def.name}. ${kind}, ${val}, ${who}.`
}

export function assertAllLines() {
  for (const [id, text] of Object.entries(LINES)) {
    assertSupported(text, id)
    if (id.startsWith('v') && text.length > 66) throw new Error(`tutorial line ${id} too long`)
  }
}
