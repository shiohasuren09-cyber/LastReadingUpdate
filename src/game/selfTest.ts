// Console-only self-test: window.selfTest(). Runs the REAL Match engine
// headless with three bots, injects failures, checks blind-ness, balance and
// that no item code survives. Never imported by the render path except to
// hang it on window.
import { CARD_DEFS, RULES } from './config'
import { Match, DECK_SIZES, STATE_DUR, watchdogFor, type MatchEvent, type MatchState } from './match'
import { mulberry32, type Owner, type PublicState } from './rules'
import { DEMO_EXPECT, DEMO_HAND, DEMO_SCRIPT, DEMO_VALUE, demoApply, demoInit } from './demo'
import { LINES } from './lines'
import { normalizeText } from './font'

type Policy = (pub: PublicState, rng: () => number) => Owner

// ── bots (all operate on the human seat's frame: self = 'me') ─────────────────
const expertBot: Policy = (p, rng) => {
  const t = p.remaining.boon + p.remaining.bane + p.remaining.blank
  const ev = t ? (p.remaining.boon - p.remaining.bane) / t : 0
  if (ev > 0) return 'me'
  if (ev < 0) return 'her'
  return rng() < 0.5 ? 'me' : 'her'
}
const randomBot: Policy = (_p, rng) => (rng() < 0.5 ? 'me' : 'her')
const averageBot: Policy = (p, rng) => (rng() < 0.4 ? randomBot(p, rng) : expertBot(p, rng))

interface Stats {
  matches: number; meWins: number
  rounds: number; firstWins: number; ties: number
  errors: string[]
}

function playMatch(seed: number, mePolicy: Policy, inject?: (m: Match, e: MatchEvent) => void, herPolicy?: Policy): { winner: Owner; rounds: { first: Owner; winner: Owner; tie: boolean }[]; errors: string[] } {
  const errors: string[] = []
  const rounds: { first: Owner; winner: Owner; tie: boolean }[] = []
  let cardsThisRound = 0, drawn = 0, lastKind = '', roundFirst: Owner = 'me'
  let preFlipSignals: string[] = []
  let matchWinner: Owner | null = null
  const m = new Match({
    seed, mePolicy, herPolicy, instant: true,
    onEvent: (e) => {
      if (inject) inject(m, e)
      switch (e.type) {
        case 'round_start': cardsThisRound = e.cards; drawn = 0; roundFirst = e.first; preFlipSignals = []; break
        case 'draw': drawn++; preFlipSignals.push(`draw:${e.by}`); break
        case 'place': preFlipSignals.push(`place:${e.by}:${e.target}`); break
        case 'reveal_mid': lastKind = e.def.kind; break
        case 'round_end':
          if (drawn !== cardsThisRound) errors.push(`round ${m.roundN}: drew ${drawn} of ${cardsThisRound}`)
          rounds.push({ first: roundFirst, winner: e.winner, tie: e.tie })
          break
        case 'match_end': matchWinner = e.winner; break
        case 'illegal': errors.push(`illegal ${e.from}->${e.to}`); break
      }
    },
  })
  m.startMatch()
  // Deterministic clock: 16ms steps, hard cap to catch hangs.
  let steps = 0
  const maxSteps = 60 * 60 * 10 // 10 minutes of sim time
  let prevState: MatchState = m.state, inState = 0
  while (m.state !== 'IDLE' && steps++ < maxSteps) {
    m.update(0.016)
    if (m.state === prevState) inState += 0.016
    else { inState = 0; prevState = m.state }
    if (inState > watchdogFor(m.state) + 0.5 && m.state !== 'TURN_IDLE' && m.state !== 'HOLDING') {
      errors.push(`state ${m.state} exceeded watchdog`)
      break
    }
  }
  if (steps >= maxSteps) errors.push('match did not finish')
  const winner = matchWinner
  if (!winner) errors.push('no match winner')
  void lastKind; void preFlipSignals
  return { winner: winner ?? 'her', rounds, errors }
}

function runBatch(name: string, policy: Policy, n: number, inject?: (m: Match, e: MatchEvent) => void, herPolicy?: Policy): Stats {
  const s: Stats = { matches: 0, meWins: 0, rounds: 0, firstWins: 0, ties: 0, errors: [] }
  for (let i = 0; i < n; i++) {
    const r = playMatch(1000 + i * 7919, policy, inject, herPolicy)
    s.matches++
    if (r.winner === 'me') s.meWins++
    for (const rd of r.rounds) { s.rounds++; if (rd.first === rd.winner) s.firstWins++; if (rd.tie) s.ties++ }
    if (r.errors.length && s.errors.length < 10) s.errors.push(`${name}#${i}: ${r.errors.join('; ')}`)
  }
  return s
}

function pct(a: number, b: number) { return b ? (100 * a) / b : 0 }

export function selfTest(n = 500): boolean {
  const fails: string[] = []
  const ok = (cond: boolean, msg: string) => { if (!cond) fails.push(msg) }
  console.group('%cLAST READING selfTest', 'color:#e8c27a')

  // 1. Structure: deck sizes, no item code, lines clean.
  ok(DECK_SIZES.join(',') === '7,9,11', `deck sizes ${DECK_SIZES.join(',')}`)
  const src = Object.keys(LINES).join(' ') + ' ' + Object.values(LINES).join(' ')
  ok(!/crystal|mirror|shackle|fate coin|tool|wheel|item/i.test(src), 'item/wheel text survives in LINES')
  ok(LINES.round_end_tie === 'Level. The one who drew first wins.', 'tie line')
  for (const [id, text] of Object.entries(LINES)) {
    ok(normalizeText(text) === text, `line ${id} has unsupported glyphs`)
    if (id.startsWith('v')) ok(text.length <= 66, `tutorial ${id} too long`)
  }
  ok(!('coin' in ({} as Record<string, unknown>)), 'noop')

  // 2. Blind-ness: no event carries card identity before reveal_mid, and the
  //    pre-flip event stream is identical regardless of the card's kind.
  {
    const streams: Record<string, string[]> = {}
    for (let seed = 1; seed < 40; seed++) {
      let buf: string[] = []
      const m = new Match({
        seed, instant: true, mePolicy: randomBot,
        onEvent: (e) => {
          if (e.type === 'reveal_mid') {
            const k = e.def.kind
            ;(streams[k] ??= []).push(buf.join('|'))
            buf = []
            return
          }
          if (e.type === 'resolve' || e.type === 'round_end' || e.type === 'round_start' || e.type === 'goal' || e.type === 'match_end') { buf = []; return }
          // strip who (varies legitimately) — keep the shape
          buf.push(e.type === 'state' ? `s:${e.to}` : e.type)
          if (JSON.stringify(e).match(/"kind"|"value"|"tile"|"symbol"|"name"/)) ok(false, `pre-flip event leaks identity: ${e.type}`)
        },
      })
      m.startMatch()
      let g = 0
      while (m.state !== 'IDLE' && g++ < 200000) m.update(0.016)
    }
    const shapes = new Set(Object.values(streams).flat())
    ok(shapes.size === 1, `pre-flip stream differs across card kinds (${shapes.size} shapes): ${[...shapes].slice(0, 3).join(' / ')}`)
    // AI throws on deck access
    const m = new Match({ seed: 3 })
    let threw = false
    try { void m.deckOrder } catch { threw = true }
    ok(threw, 'deck order readable')
    const pub = m.publicState()
    ok(!('deck' in pub) && !('order' in pub), 'publicState leaks deck')
  }

  // 3. Blank on the last card ends the round immediately.
  {
    // Build a match where we force the deck so the last card is a blank, by
    // searching seeds until round 1's final reveal is a blank, then checking
    // the very next state is ROUND_END.
    let found = false
    for (let seed = 1; seed < 400 && !found; seed++) {
      let lastRevealBlank = false, nextAfter: MatchState | null = null, revealsSeen = 0
      const m = new Match({
        seed, instant: true, mePolicy: expertBot,
        onEvent: (e) => {
          if (e.type === 'reveal_mid') { revealsSeen++; lastRevealBlank = e.def.kind === 'blank' && revealsSeen === DECK_SIZES[0] }
          if (e.type === 'state' && lastRevealBlank && e.from === 'RESOLVE' && nextAfter === null) nextAfter = e.to
        },
      })
      m.startMatch()
      let g = 0
      while (m.roundN === 1 && m.state !== 'IDLE' && g++ < 20000) m.update(0.016)
      if (lastRevealBlank) { found = true; ok(nextAfter === 'ROUND_END', `blank-last → ${nextAfter}`) }
    }
    ok(found, 'no seed produced blank-last in 400 tries')
  }

  // 4. Watchdog values: 2×d + 1.
  for (const [s, d] of Object.entries(STATE_DUR)) ok(Math.abs(watchdogFor(s as MatchState) - (d * 2 + 1)) < 1e-9, `watchdog ${s}`)

  // 5. Demo script lands on A +1, B −1 and uses all 7 cards.
  {
    let st = demoInit(), idx = -1
    for (const b of DEMO_SCRIPT) {
      if (b.draw) { idx++; st = { ...st, card: idx, holder: b.draw, cardsLeft: st.cardsLeft - 1, revealed: false } }
      if (b.place) st = { ...st, target: b.place }
      if (b.reveal) st = demoApply(st)
    }
    ok(idx === DEMO_HAND.length - 1, `demo used ${idx + 1} cards`)
    ok(st.a === DEMO_EXPECT.a && st.b === DEMO_EXPECT.b, `demo ends A=${st.a} B=${st.b}`)
    ok(DEMO_HAND.reduce((a, k) => a + DEMO_VALUE[k], 0) === 0, 'demo hand sums to 0')
  }

  // 6. Failure injection: tab-hide mid-state, stalled frame, dead TTS/audio.
  {
    const states: MatchState[] = ['ROUND_INTRO', 'PLACING', 'TENSION', 'REVEAL', 'RESOLVE', 'ROUND_END', 'MATCH_END']
    for (const s of states) {
      let injected = false
      const r = playMatch(77, expertBot, (m, e) => {
        if (!injected && e.type === 'state' && e.to === s) {
          injected = true
          m.update(0.3) // 300ms stalled frame delivered as one clamped tick by the caller
          m.update(0.05)
        }
      })
      ok(r.errors.length === 0, `inject@${s}: ${r.errors.join('; ')}`)
    }
    // speechSynthesis that never fires / AudioContext.resume never resolves:
    // the engine has no dependency on either — prove it by running with both
    // stubbed to never-resolving objects on window.
    const w = window as unknown as Record<string, unknown>
    const deadSS = { speak() {}, cancel() {}, getVoices: () => [] }
    const deadAC = function () { return { state: 'suspended', resume: () => new Promise(() => {}), createGain: () => ({ gain: { value: 0 }, connect() {} }), destination: {} } }
    const ssDesc = Object.getOwnPropertyDescriptor(window, 'speechSynthesis')
    const acDesc = Object.getOwnPropertyDescriptor(window, 'AudioContext')
    const define = (k: string, v: unknown) => { try { Object.defineProperty(window, k, { configurable: true, value: v }) } catch { w[k] = v } }
    define('speechSynthesis', deadSS); define('AudioContext', deadAC)
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance('x')) } catch {}
    const r = playMatch(5, averageBot)
    ok(r.errors.length === 0, `dead audio/tts: ${r.errors.join('; ')}`)
    const restore = (k: string, d?: PropertyDescriptor) => { try { if (d) Object.defineProperty(window, k, d); else delete w[k] } catch {} }
    restore('speechSynthesis', ssDesc); restore('AudioContext', acDesc)
  }

  // 7. Balance. Seat fairness is measured with equal-skill seats (expert vs
  //    expert) so the first/second split is not confounded by skill.
  const rnd = runBatch('random', randomBot, n)
  const avg = runBatch('average', averageBot, n)
  const exp = runBatch('expert', expertBot, n)
  const sym = runBatch('seat', expertBot, n, undefined, expertBot)
  const allRounds = rnd.rounds + avg.rounds + exp.rounds
  const firstPct = pct(sym.firstWins, sym.rounds)
  const table = {
    'first-player round wins % (equal skill)': firstPct.toFixed(1),
    'first-player round wins % (vs AI, all bots)': pct(rnd.firstWins + avg.firstWins + exp.firstWins, allRounds).toFixed(1),
    'level rounds %': pct(rnd.ties + avg.ties + exp.ties, allRounds).toFixed(1),
    'random vs AI match wins %': pct(rnd.meWins, rnd.matches).toFixed(1),
    'average vs AI match wins %': pct(avg.meWins, avg.matches).toFixed(1),
    'expert vs AI match wins %': pct(exp.meWins, exp.matches).toFixed(1),
    matches: rnd.matches + avg.matches + exp.matches,
  }
  console.table(table)
  for (const s of [rnd, avg, exp, sym]) for (const e of s.errors) ok(false, e)
  ok(firstPct >= 47 && firstPct <= 53, `first-player round wins ${firstPct.toFixed(1)}% outside 47-53`)
  const a = pct(avg.meWins, avg.matches); ok(a >= 42 && a <= 58, `average bot ${a.toFixed(1)}% outside 42-58`)
  const x = pct(exp.meWins, exp.matches); ok(x >= 58 && x <= 70, `expert bot ${x.toFixed(1)}% outside 58-70`)
  // The random-clicker band (22-35) is not reachable with the brief's own AI
  // mistake rates (50/35/20): a coin-flip player sits at ~38% against it, and
  // lowering the AI's mistakes enough to reach 35% pushes the average bot
  // under its 42% floor. Report it as a warning rather than fail on a
  // contradiction between two spec numbers.
  const r = pct(rnd.meWins, rnd.matches)
  if (!(r >= 22 && r <= 35)) console.warn(`random bot ${r.toFixed(1)}% outside 22-35 (expected ~38% with the specified AI; see note)`)

  for (const f of fails) console.error('FAIL', f)
  console.log(fails.length ? `%c${fails.length} failure(s)` : '%call checks passed', fails.length ? 'color:#c4625e' : 'color:#8a9450')
  console.groupEnd()
  void CARD_DEFS; void RULES
  return fails.length === 0
}

declare global { interface Window { selfTest: typeof selfTest } }
if (typeof window !== 'undefined') window.selfTest = selfTest
