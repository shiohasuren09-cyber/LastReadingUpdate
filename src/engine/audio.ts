// ── engine/audio.ts — Web Audio manager with mobile unlock ──
// Browsers keep AudioContext suspended until a user gesture (iOS Safari,
// Chrome autoplay policy). This module installs one-time gesture listeners
// and resumes automatically; playBgm() before unlock is remembered and starts
// on the first tap/keypress. Load sounds up front, then fire-and-forget:
//   await audio.load('hit', ASSETS.sfx_hit)
//   audio.playSfx('hit'); audio.playBgm('theme', { volume: 0.4 })
// Foundation helper with no game shape; delete if unused.

type SfxOpts = { volume?: number; rate?: number }
type BgmOpts = { volume?: number }

let ctx: AudioContext | null = null
let unlocked = false
let muted = false
const buffers = new Map<string, AudioBuffer>()
let bgm: { source: AudioBufferSourceNode; gain: GainNode; volume: number } | null = null
let pendingBgm: { key: string; opts: BgmOpts } | null = null

function ensureContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    const unlock = () => {
      void ctx!.resume().then(() => {
        unlocked = ctx!.state === 'running'
        if (unlocked && pendingBgm) {
          const p = pendingBgm
          pendingBgm = null
          audio.playBgm(p.key, p.opts)
        }
      })
    }
    // Not { once: true }: some browsers re-suspend after a bfcache restore and
    // need another gesture; resuming an already-running context is a no-op.
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  }
  return ctx
}

export const audio = {
  async load(key: string, url: string): Promise<void> {
    const c = ensureContext()
    if (buffers.has(key)) return
    const res = await fetch(url)
    buffers.set(key, await c.decodeAudioData(await res.arrayBuffer()))
  },

  playSfx(key: string, opts: SfxOpts = {}): void {
    const buf = buffers.get(key)
    if (!ctx || !buf || muted || ctx.state !== 'running') return
    const source = ctx.createBufferSource()
    source.buffer = buf
    source.playbackRate.value = opts.rate ?? 1
    const gain = ctx.createGain()
    gain.gain.value = opts.volume ?? 1
    source.connect(gain).connect(ctx.destination)
    source.start()
  },

  playBgm(key: string, opts: BgmOpts = {}): void {
    const c = ensureContext()
    const buf = buffers.get(key)
    if (!buf) return
    if (c.state !== 'running') {
      pendingBgm = { key, opts } // starts on the first user gesture
      return
    }
    this.stopBgm()
    const source = c.createBufferSource()
    source.buffer = buf
    source.loop = true
    const volume = opts.volume ?? 0.4
    const gain = c.createGain()
    gain.gain.value = muted ? 0 : volume
    source.connect(gain).connect(c.destination)
    source.start()
    bgm = { source, gain, volume }
  },

  stopBgm(): void {
    pendingBgm = null
    if (!bgm) return
    try {
      bgm.source.stop()
    } catch {
      // already stopped
    }
    bgm = null
  },

  setMuted(m: boolean): void {
    muted = m
    if (bgm) bgm.gain.gain.value = m ? 0 : bgm.volume
  },
  get muted(): boolean {
    return muted
  },
  get unlocked(): boolean {
    return unlocked
  },
}
