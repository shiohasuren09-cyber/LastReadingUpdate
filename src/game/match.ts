// Headless match engine — the single state machine the live game AND
// selfTest() drive. No three.js, no DOM, no audio. Presentation subscribes
// to events; it can never block or reorder a transition.
//
// Every change goes through go(state). Non-interactive states carry a
// watchdog (2× expected + 1s) that force-completes them with a console.warn.
import { CARD_DEFS, MAX_DECK, RULES, type CardDef } from './config'
import { aiDecide, thinkDelay } from './ai'
import {
  buildDeck, mulberry32, removeBead, resolveCard, roundWinner, scaleTilt, ROUND_MIX,
  type BeadState, type Owner, type PublicState, type ScoreState,
} from './rules'

export type MatchState =
  | 'IDLE'        // not in a match
  | 'ROUND_INTRO' // narrator says the goal
  | 'TURN_IDLE'   // waiting for the active player to take a card
  | 'HOLDING'     // active player holds a face-down card
  | 'PLACING'     // card travels to a mat
  | 'TENSION'     // 0.5s beat, card face-down on the mat
  | 'REVEAL'      // flip; face assigned at midpoint
  | 'RESOLVE'     // scale moves, turn passes or repeats
  | 'ROUND_END'   // pan drops, bell, sweep
  | 'MATCH_END'   // door or trapdoor, then back to IDLE

/** Expected durations (s) of non-interactive states; watchdog = 2×d + 1. */
export const STATE_DUR: Partial<Record<MatchState, number>> = {
  ROUND_INTRO: 3.2,
  PLACING: 0.3,
  TENSION: RULES.tensionSec,
  REVEAL: 0.3,
  RESOLVE: 0.9,
  ROUND_END: RULES.panDropSec + RULES.roundEndPause + RULES.cardSweepSec + 0.6,
  MATCH_END: RULES.doorOpenSec + RULES.doorHoldSec + 1.6,
}
export const watchdogFor = (s: MatchState) => {
  const d = STATE_DUR[s]
  return d === undefined ? Infinity : d * 2 + 1
}

const LEGAL: Record<MatchState, MatchState[]> = {
  IDLE: ['ROUND_INTRO'],
  ROUND_INTRO: ['TURN_IDLE'],
  TURN_IDLE: ['HOLDING', 'ROUND_END'],
  HOLDING: ['PLACING'],
  PLACING: ['TENSION'],
  TENSION: ['REVEAL'],
  REVEAL: ['RESOLVE'],
  RESOLVE: ['TURN_IDLE', 'ROUND_END'],
  ROUND_END: ['ROUND_INTRO', 'MATCH_END'],
  MATCH_END: ['IDLE'],
}

export type MatchEvent =
  | { type: 'state'; from: MatchState; to: MatchState }
  | { type: 'round_start'; roundN: number; first: Owner; cards: number }
  | { type: 'goal'; roundN: number }
  | { type: 'draw'; by: Owner; cardsLeft: number }       // card lifted, face unknown
  | { type: 'place'; by: Owner; target: Owner }           // face-down on a mat
  | { type: 'reveal_mid'; def: CardDef; target: Owner }   // the ONLY moment identity exists
  | { type: 'resolve'; def: CardDef; target: Owner; score: ScoreState; again: boolean }
  | { type: 'round_end'; winner: Owner; tie: boolean; score: ScoreState; myWins: number; herWins: number }
  | { type: 'match_end'; winner: Owner }
  | { type: 'watchdog'; state: MatchState }
  | { type: 'illegal'; from: MatchState; to: MatchState }

export interface MatchOptions {
  seed?: number
  /** Called for every event; must never throw into the engine (we guard). */
  onEvent?: (e: MatchEvent) => void
  /** Replace the built-in AI for the 'her' seat (used by selfTest). */
  herPolicy?: (pub: PublicState, rng: () => number) => Owner
  /** Replace the human seat with a bot (used by selfTest). */
  mePolicy?: (pub: PublicState, rng: () => number) => Owner
  /** Skip AI think delays (headless). */
  instant?: boolean
}

export class Match {
  state: MatchState = 'IDLE'
  stateT = 0            // seconds spent in current state
  t = 0
  roundN = 0
  myWins = 0
  herWins = 0
  first: Owner = 'me'
  turn: Owner = 'me'
  score: ScoreState = { myScore: 0, herScore: 0 }
  beads: BeadState = { cardsLeft: 0, cardsTotal: 0 }
  /** Public reveal counts this round (what everyone has SEEN). */
  revealed = { boon: 0, bane: 0, blank: 0 }
  seed: number
  rng: () => number
  readonly log: string[] = []
  private logCap = 64
  private deck: CardDef[] = []            // PRIVATE: never exposed
  private pendingTarget: Owner | null = null
  private pendingDef: CardDef | null = null
  private aiTimer = -1
  private onEvent: (e: MatchEvent) => void
  private herPolicy?: MatchOptions['herPolicy']
  private mePolicy?: MatchOptions['mePolicy']
  private instant: boolean
  /** Set by presentation when its animation for the current state is done. */
  private ready = false
  matchWinner: Owner | null = null
  /**
   * Presentation clears this while the Reader is still speaking so neither the
   * human nor the AI can start a new action until the line finishes.
   */
  actable = true

  constructor(opts: MatchOptions = {}) {
    this.seed = opts.seed ?? ((Math.random() * 0xffffffff) >>> 0)
    this.rng = mulberry32(this.seed)
    this.onEvent = opts.onEvent ?? (() => {})
    this.herPolicy = opts.herPolicy
    this.mePolicy = opts.mePolicy
    this.instant = !!opts.instant
  }

  setActable(v: boolean) { this.actable = v }

  // ── public view ─────────────────────────────────────────────────────────────

  /** The ONLY information the AI may see. Deck order is never part of it. */
  publicState(): PublicState {
    const mix = ROUND_MIX[Math.min(Math.max(this.roundN - 1, 0), ROUND_MIX.length - 1)]
    return {
      roundN: this.roundN,
      cardsLeft: this.beads.cardsLeft,
      myScore: this.score.herScore, // AI frame: self = 'her'
      herScore: this.score.myScore,
      remaining: {
        boon: Math.max(0, mix.boon - this.revealed.boon),
        bane: Math.max(0, mix.bane - this.revealed.bane),
        blank: Math.max(0, mix.blank - this.revealed.blank),
      },
    }
  }

  /** Any attempt to read the deck throws — selfTest asserts this. */
  get deckOrder(): never { throw new Error('deck order is private') }

  cardsLeft() { return this.deck.length }
  tilt() { return scaleTilt(this.score) }

  // ── transitions ─────────────────────────────────────────────────────────────

  go(to: MatchState) {
    const from = this.state
    if (!LEGAL[from].includes(to)) {
      this.emit({ type: 'illegal', from, to })
      this.push(`ILLEGAL ${from}->${to}`)
      // recover to a safe interactive state inside a round, else to IDLE
      to = this.roundN > 0 && from !== 'MATCH_END' ? 'TURN_IDLE' : 'IDLE'
      if (!LEGAL[from].includes(to)) { this.state = to; this.stateT = 0; this.ready = false; return }
    }
    this.state = to
    this.stateT = 0
    this.ready = false
    this.push(`${from}->${to}`)
    this.emit({ type: 'state', from, to })
    this.enter(to)
  }

  /** Presentation tells us its animation finished for the current state. */
  done() { this.ready = true }

  private enter(s: MatchState) {
    switch (s) {
      case 'ROUND_INTRO': {
        this.roundN++
        this.score = { myScore: 0, herScore: 0 }
        this.revealed = { boon: 0, bane: 0, blank: 0 }
        this.deck = buildDeck(this.roundN - 1, this.rng)
        this.beads = { cardsLeft: this.deck.length, cardsTotal: this.deck.length }
        this.turn = this.first
        this.emit({ type: 'round_start', roundN: this.roundN, first: this.first, cards: this.deck.length })
        this.emit({ type: 'goal', roundN: this.roundN })
        break
      }
      case 'TURN_IDLE': {
        if (this.deck.length === 0) { this.go('ROUND_END'); return }
        this.aiTimer = this.turn === 'her' || this.mePolicy
          ? (this.instant ? 0 : thinkDelay(this.roundN, this.rng))
          : -1
        break
      }
      case 'RESOLVE': {
        const def = this.pendingDef!, target = this.pendingTarget!
        const r = resolveCard(def, target, this.score, this.turn)
        this.score = r.newScore
        this.revealed[def.kind]++
        const again = r.nextTurn !== null
        this.emit({ type: 'resolve', def, target, score: this.score, again })
        if (!again) this.turn = this.turn === 'me' ? 'her' : 'me'
        this.pendingDef = null; this.pendingTarget = null
        break
      }
      case 'ROUND_END': {
        const tie = this.score.myScore === this.score.herScore
        const winner = roundWinner(this.score, this.first)
        if (winner === 'me') this.myWins++; else this.herWins++
        this.emit({ type: 'round_end', winner, tie, score: this.score, myWins: this.myWins, herWins: this.herWins })
        // loser of this round goes first next round
        this.first = winner === 'me' ? 'her' : 'me'
        break
      }
      case 'MATCH_END': {
        this.matchWinner = this.myWins >= RULES.roundsToWin ? 'me' : 'her'
        this.emit({ type: 'match_end', winner: this.matchWinner })
        break
      }
      case 'IDLE': {
        this.roundN = 0; this.myWins = 0; this.herWins = 0; this.first = 'me'
        this.deck = []; this.matchWinner = null
        break
      }
    }
  }

  // ── player actions (human seat) ─────────────────────────────────────────────

  startMatch() { if (this.state === 'IDLE') this.go('ROUND_INTRO') }

  /** Tap the deck. Only legal in TURN_IDLE on my turn, and only when actable. */
  takeCard(): boolean {
    if (!this.actable || this.state !== 'TURN_IDLE' || this.turn !== 'me' || this.deck.length === 0) return false
    this.lift('me')
    return true
  }

  /** Tap a mat while holding. */
  placeCard(target: Owner): boolean {
    if (!this.actable || this.state !== 'HOLDING' || this.turn !== 'me') return false
    this.commit(target)
    return true
  }

  private lift(by: Owner) {
    this.beads = removeBead(this.beads)
    this.emit({ type: 'draw', by, cardsLeft: this.beads.cardsLeft })
    this.go('HOLDING')
  }

  private commit(target: Owner) {
    this.pendingTarget = target
    this.emit({ type: 'place', by: this.turn, target })
    this.go('PLACING')
  }

  // ── clock ───────────────────────────────────────────────────────────────────

  /** Advance the engine. dt is clamped by the caller. Capped loop. */
  update(dt: number) {
    this.t += dt
    this.stateT += dt
    let guard = 0
    while (guard++ < 8) {
      const before = this.state
      this.step(dt)
      if (this.state === before) break
    }
  }

  private step(dt: number) {
    const s = this.state
    const wd = watchdogFor(s)
    const timedOut = this.stateT >= wd
    if (timedOut && s !== 'TURN_IDLE' && s !== 'HOLDING' && s !== 'IDLE') {
      console.warn(`last-reading watchdog: ${s} exceeded ${wd.toFixed(1)}s — forcing`)
      this.emit({ type: 'watchdog', state: s })
      this.ready = true
    }
    switch (s) {
      case 'ROUND_INTRO':
        if (this.ready || this.stateT >= STATE_DUR.ROUND_INTRO!) this.go('TURN_IDLE')
        break
      case 'TURN_IDLE':
        // Think timer only runs while the Reader is silent; actions start after.
        if (this.aiTimer >= 0) {
          if (!this.actable) break
          this.aiTimer -= dt
          if (this.aiTimer <= 0) {
            this.aiTimer = -1
            const pub = this.publicState()
            if (this.turn === 'her') {
              const dec = (this.herPolicy ?? aiDecide)(pub, this.rng) // AI frame
              this.lift('her')
              // 'me' in AI frame = keep = her mat
              this.commit(dec === 'me' ? 'her' : 'me')
            } else if (this.mePolicy) {
              // bot in the human seat: frame is self='me'
              const dec = this.mePolicy({ ...pub, myScore: this.score.myScore, herScore: this.score.herScore }, this.rng)
              this.lift('me')
              this.commit(dec)
            }
          }
        }
        break
      case 'HOLDING':
        break
      case 'PLACING':
        if (this.ready || this.stateT >= STATE_DUR.PLACING!) this.go('TENSION')
        break
      case 'TENSION':
        if (this.stateT >= STATE_DUR.TENSION!) this.go('REVEAL')
        break
      case 'REVEAL': {
        // Identity is assigned exactly once, at the midpoint. Before this
        // instant nothing in the engine or its events has mentioned the card.
        if (this.pendingDef === null && this.stateT >= STATE_DUR.REVEAL! * 0.5) {
          const def = this.deck.pop()!
          this.pendingDef = def
          this.emit({ type: 'reveal_mid', def, target: this.pendingTarget! })
        }
        if (this.pendingDef !== null && (this.ready || this.stateT >= STATE_DUR.REVEAL!)) this.go('RESOLVE')
        break
      }
      case 'RESOLVE':
        if (this.ready || this.stateT >= STATE_DUR.RESOLVE!) {
          this.go(this.deck.length === 0 ? 'ROUND_END' : 'TURN_IDLE')
        }
        break
      case 'ROUND_END':
        if (this.ready || this.stateT >= STATE_DUR.ROUND_END!) {
          if (this.myWins >= RULES.roundsToWin || this.herWins >= RULES.roundsToWin) this.go('MATCH_END')
          else this.go('ROUND_INTRO')
        }
        break
      case 'MATCH_END':
        if (this.ready || this.stateT >= STATE_DUR.MATCH_END!) this.go('IDLE')
        break
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private emit(e: MatchEvent) {
    try { this.onEvent(e) } catch (err) { console.error('last-reading: event handler', err) }
  }
  private push(line: string) {
    this.log.push(`${this.t.toFixed(2)} ${line}`)
    if (this.log.length > this.logCap) this.log.splice(0, this.log.length - this.logCap)
  }
}

export const DECK_SIZES = ROUND_MIX.map((m) => m.boon + m.bane + m.blank)
export { CARD_DEFS, MAX_DECK }
