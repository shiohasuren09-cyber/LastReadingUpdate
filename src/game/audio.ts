// Synthesised feedback sounds and a low room drone (no external audio files,
// per the brief). Everything is created lazily after the first user gesture.

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noiseBuf: AudioBuffer | null = null
let droneStarted = false

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.55
    master.connect(ctx.destination)
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  if (ctx.state === 'suspended') void ctx.resume()
  if (!droneStarted) startDrone()
}

export function suspendAudio() { if (ctx && ctx.state === 'running') void ctx.suspend() }
export function resumeAudio() { if (ctx && ctx.state === 'suspended') void ctx.resume() }

function startDrone() {
  if (!ctx || !master) return
  droneStarted = true
  const g = ctx.createGain()
  g.gain.value = 0.0
  g.gain.linearRampToValueAtTime(0.07, ctx.currentTime + 4)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 320
  lp.connect(g)
  g.connect(master)
  for (const [f, type] of [[55, 'sawtooth'], [55.4, 'sawtooth'], [82.4, 'triangle']] as const) {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = f
    o.connect(lp)
    o.start()
  }
  // slow breathing on the filter
  const lfo = ctx.createOscillator()
  const lg = ctx.createGain()
  lfo.frequency.value = 0.08
  lg.gain.value = 120
  lfo.connect(lg)
  lg.connect(lp.frequency)
  lfo.start()
}

function env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
}

function noise(dur: number, freq: number, q: number, peak: number, delay = 0, type: BiquadFilterType = 'bandpass') {
  if (!ctx || !master || !noiseBuf) return
  const t = ctx.currentTime + delay
  const src = ctx.createBufferSource()
  src.buffer = noiseBuf
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  const g = ctx.createGain()
  env(g, t, peak, 0.005, dur)
  src.connect(f); f.connect(g); g.connect(master)
  src.start(t, Math.random() * 0.5, dur + 0.05)
}

function tone(freq: number, dur: number, peak: number, type: OscillatorType = 'sine', delay = 0, slideTo = 0) {
  if (!ctx || !master) return
  const t = ctx.currentTime + delay
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur)
  const g = ctx.createGain()
  env(g, t, peak, 0.004, dur)
  o.connect(g); g.connect(master)
  o.start(t); o.stop(t + dur + 0.05)
}

export const sfx = {
  draw() { noise(0.14, 2400, 0.8, 0.25); noise(0.08, 900, 1, 0.1, 0.05) },
  place() { noise(0.09, 1400, 0.7, 0.3); tone(110, 0.12, 0.12, 'sine') },
  tension() { tone(73.4, 0.8, 0.12, 'triangle', 0, 70) ; noise(0.7, 300, 4, 0.04) },
  flip() { noise(0.05, 3200, 1.2, 0.35); tone(220, 0.06, 0.08, 'square') },
  boon(i: number) { tone(880 * Math.pow(1.122, i), 0.25, 0.14, 'sine'); tone(1760 * Math.pow(1.122, i), 0.12, 0.05, 'sine', 0.01) },
  bane(i: number) { tone(98 / Math.pow(1.06, i), 0.35, 0.25, 'sawtooth', 0, 60); noise(0.12, 400, 1, 0.12) },
  cancel() { tone(520, 0.1, 0.1, 'triangle'); noise(0.05, 5000, 2, 0.08) },
  blank() { tone(330, 0.3, 0.07, 'triangle', 0, 300) },
  extraTurn() { tone(660, 0.15, 0.08, 'sine'); tone(990, 0.2, 0.08, 'sine', 0.12) },
  creak() { noise(0.35, 650, 9, 0.07) },
  bead(win: boolean) { tone(win ? 1320 : 440, 0.18, 0.15, 'triangle'); noise(0.04, 4000, 2, 0.15) },
  voice() { tone(140 + Math.random() * 30, 0.05, 0.03, 'square') },
  bell(low = false) { tone(low ? 196 : 392, 1.4, 0.12, 'sine'); tone(low ? 294 : 588, 1.2, 0.05, 'sine', 0.02) },
  lamp() { tone(1200, 0.08, 0.05, 'sine'); noise(0.05, 2000, 3, 0.05) },
  sweep() { noise(0.5, 1800, 0.6, 0.15, 0, 'highpass') },
  tick() { noise(0.025, 6000, 5, 0.10); tone(1100, 0.025, 0.04, 'sine') },
  snap() { noise(0.06, 2500, 1.5, 0.4); noise(0.04, 5500, 2, 0.2, 0.02) },
  door() { noise(1.2, 300, 2.5, 0.2, 0, 'lowpass'); tone(70, 1.0, 0.12, 'sawtooth', 0, 45) },
  fall() { tone(220, 0.7, 0.18, 'sawtooth', 0, 40); noise(0.7, 500, 1, 0.1, 0, 'lowpass') },
}
