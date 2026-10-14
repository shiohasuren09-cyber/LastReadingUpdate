// Reader's voice: speechSynthesis when available (lowest-pitch English,
// pitch 0.1, rate 0.78), else a procedural whisper-chant through vowel formants.
// VOICE map is a hook for recorded files later.

export type LineId =
  | 'goal1' | 'goal2' | 'goal3'
  | 'hint_deck' | 'hint_place'
  | 'help_scale' | 'help_beads' | 'help_candles' | 'help_door' | 'help_trap'
  | 'round_end_win' | 'round_end_lose' | 'round_end_tie'
  | 'match_win' | 'match_lose'
  | 'reveal'
  | 'v01' | 'v02' | 'v03' | 'v04' | 'v05' | 'v06' | 'v07'
  | 'v08' | 'v09' | 'v10' | 'v11' | 'v12' | 'v13' | 'v14'
  | 'custom'

/** Future recorded clips keyed by line id. Empty for now. */
export const VOICE: Partial<Record<LineId, string>> = {}

const CPS = 16 // characters per second when no voice events

let unlocked = false
let ctx: AudioContext | null = null
let master: GainNode | null = null
let speaking = false
let cancelCurrent: (() => void) | null = null

export function unlockVoice() {
  unlocked = true
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.35
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
}

export interface SpeakHandle {
  /** Estimated duration in seconds (for subtitle timing). */
  duration: number
  /** Progress 0..1 of spoken text (glyph ignition). */
  progress: () => number
  stop: () => void
}

const FORMANTS: Record<string, [number, number]> = {
  A: [700, 1220], E: [530, 1840], I: [270, 2290], O: [570, 840], U: [300, 870],
}

function vowelsOf(text: string): string[] {
  const out: string[] = []
  for (const ch of text.toUpperCase()) {
    if ('AEIOU'.includes(ch)) out.push(ch)
    else if (ch === 'Y') out.push('I')
    else if (ch === ' ') out.push(' ')
  }
  return out.length ? out : ['A']
}

function whisperChant(text: string): SpeakHandle {
  if (!ctx || !master) {
    const dur = Math.max(0.8, text.length / CPS)
    const t0 = performance.now()
    return {
      duration: dur,
      progress: () => Math.min(1, (performance.now() - t0) / (dur * 1000)),
      stop: () => {},
    }
  }
  const vowels = vowelsOf(text)
  const msPer = 90
  const dur = (vowels.length * msPer) / 1000
  const t0 = ctx.currentTime
  const nodes: AudioNode[] = []
  const stoppers: OscillatorNode[] = []

  // shared noise
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * Math.ceil(dur + 0.2), ctx.sampleRate)
  const nd = noiseBuf.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1

  let t = t0
  for (const v of vowels) {
    if (v === ' ') { t += msPer / 1000; continue }
    const [f1, f2] = FORMANTS[v] ?? FORMANTS.A
    const saw = ctx.createOscillator()
    saw.type = 'sawtooth'
    saw.frequency.value = 90
    const trem = ctx.createOscillator()
    const tremG = ctx.createGain()
    trem.frequency.value = 4
    tremG.gain.value = 0.15
    trem.connect(tremG)
    tremG.connect(saw.frequency)

    const bp1 = ctx.createBiquadFilter(); bp1.type = 'bandpass'; bp1.frequency.value = f1; bp1.Q.value = 8
    const bp2 = ctx.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = f2; bp2.Q.value = 6
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + msPer / 1000)

    const ns = ctx.createBufferSource()
    ns.buffer = noiseBuf
    const ng = ctx.createGain()
    ng.gain.value = 0.08

    saw.connect(bp1); bp1.connect(bp2); bp2.connect(g); g.connect(master!)
    ns.connect(ng); ng.connect(master!)
    saw.start(t); saw.stop(t + msPer / 1000 + 0.02)
    trem.start(t); trem.stop(t + msPer / 1000 + 0.02)
    ns.start(t, 0, msPer / 1000 + 0.02)
    stoppers.push(saw, trem)
    nodes.push(g, ng)
    t += msPer / 1000
  }

  const startMs = performance.now()
  let stopped = false
  cancelCurrent = () => {
    if (stopped) return
    stopped = true
    for (const o of stoppers) { try { o.stop() } catch {} }
  }
  speaking = true
  return {
    duration: dur,
    progress: () => stopped ? 1 : Math.min(1, (performance.now() - startMs) / (dur * 1000)),
    stop: () => { cancelCurrent?.(); speaking = false },
  }
}

function ttsSpeak(text: string): SpeakHandle | null {
  if (!('speechSynthesis' in window)) return null
  const synth = window.speechSynthesis
  const voices = synth.getVoices()
  const english = voices.filter((v) => /en(-|_)?/i.test(v.lang))
  // lowest pitch preference: prefer names hinting low/deep/male, else first English
  english.sort((a, b) => {
    const score = (v: SpeechSynthesisVoice) =>
      (/deep|low|bass|male|daniel|fred|bruce|alex/i.test(v.name) ? 0 : 1)
    return score(a) - score(b)
  })
  const voice = english[0] ?? voices[0]
  if (!voice && voices.length === 0) {
    // voices may load async — fall through to procedural
    return null
  }
  const u = new SpeechSynthesisUtterance(text)
  if (voice) u.voice = voice
  u.pitch = 0.1
  u.rate = 0.78
  u.volume = 1
  // Subtitle timing never depends on TTS events: progress is wall-clock at
  // 16 cps, so a speechSynthesis that never fires onend cannot stall anything.
  const dur = Math.max(1.0, text.length / CPS)
  const t0 = performance.now()
  let ended = false
  u.onend = () => { ended = true; speaking = false }
  u.onerror = () => { ended = true; speaking = false }
  try { synth.cancel(); synth.speak(u) } catch { return null }
  speaking = true
  cancelCurrent = () => { try { synth.cancel() } catch {} ended = true; speaking = false }
  return {
    duration: dur,
    progress: () => Math.min(1, (performance.now() - t0) / (dur * 1000)),
    stop: () => { cancelCurrent?.() },
  }
}

/**
 * Speak a line. Prefers recorded VOICE[id], then TTS, then whisper-chant.
 * Returns a handle for subtitle sync.
 */
export function speak(id: LineId, text: string): SpeakHandle {
  unlockVoice()
  cancelCurrent?.()
  // Recorded files (future): if VOICE[id] is set, play it — skipped for now.
  void VOICE[id]
  const tts = ttsSpeak(text)
  if (tts) return tts
  return whisperChant(text)
}

export function stopSpeaking() {
  cancelCurrent?.()
  speaking = false
}

export function isSpeaking() { return speaking }

export const CHAR_PER_SEC = CPS
