// After-post subtitle compositor: amber #e8c27a with 1px ink outline + drop
// shadow, centered near the bottom, ≤2 lines, glyphs ignite hot→amber over
// 0.2s timed to the voice and dissolve into embers 0.5s after speech ends.
import { assertSupported, drawText, normalizeText, textWidth, wrapToWidth } from './font'
import { speak, stopSpeaking, type LineId, type SpeakHandle, CHAR_PER_SEC } from './voice'

const AMBER = '#e8c27a'
const HOT = '#ff8a3a'
const INK = '#1c1626'
const EMBER = '#c4625e'

export interface SubLine {
  id: LineId
  text: string
  /** When the line started (game time). */
  t0: number
  handle: SpeakHandle
  /** Game time when speech ended (set once progress hits 1). */
  endedAt: number | null
}

export class Subtitles {
  private current: SubLine | null = null
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  w = 400
  h = 225

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.w
    this.canvas.height = this.h
    const st = this.canvas.style
    st.position = 'absolute'
    st.imageRendering = 'pixelated'
    st.pointerEvents = 'none'
    st.zIndex = '2'
    host.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')!
  }

  /** Keep the overlay locked to the pixel canvas's CSS box. */
  syncBox(cssLeft: number, cssTop: number, cssW: number, cssH: number, lw: number, lh: number) {
    if (this.w !== lw || this.h !== lh || this.canvas.width !== lw || this.canvas.height !== lh) {
      this.w = lw; this.h = lh
      this.canvas.width = lw
      this.canvas.height = lh
    }
    const st = this.canvas.style
    st.left = cssLeft + 'px'
    st.top = cssTop + 'px'
    st.width = cssW + 'px'
    st.height = cssH + 'px'
  }

  say(id: LineId, text: string, gameT: number) {
    // Never throw out of here — a bad glyph must not kill the narration subsystem.
    const clean = normalizeText(text)
    if (!clean) return
    try { assertSupported(clean, id) } catch (e) { console.warn(e) }
    stopSpeaking()
    const handle = speak(id, clean)
    this.current = { id, text: clean, t0: gameT, handle, endedAt: null }
  }

  /** True while a line is still being spoken (dissolve does not count). */
  busy(): boolean {
    const line = this.current
    if (!line) return false
    return line.handle.progress() < 1
  }

  clear() {
    stopSpeaking()
    this.current = null
    this.ctx.clearRect(0, 0, this.w, this.h)
  }

  /** Draw one frame. `gameT` is the game clock. */
  draw(gameT: number) {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.w, this.h)
    const line = this.current
    if (!line) return

    const prog = line.handle.progress()
    if (prog >= 1 && line.endedAt === null) line.endedAt = gameT
    const after = line.endedAt !== null ? gameT - line.endedAt : -1
    if (after > 0.5 + 0.4) { // dissolve finished
      this.current = null
      return
    }

    const maxPx = Math.floor(this.w * 0.9)
    const lines = wrapToWidth(line.text, maxPx, 'big', 2)
    const full = lines.join(' ')
    // Characters revealed by voice progress
    const revealed = Math.min(full.length, Math.ceil(prog * full.length))
    const lh = 10
    const blockH = lines.length * lh
    let y = this.h - blockH - 10

    let charIndex = 0
    for (const ln of lines) {
      const tw = textWidth(ln, 'big')
      const x = Math.round((this.w - tw) / 2)
      // drop shadow
      drawText(ctx, ln.slice(0, Math.max(0, revealed - charIndex)), x + 1, y + 1, INK, 'big', 1)
      // outline + per-glyph color
      this.drawIgnited(ctx, ln, x, y, charIndex, revealed, line.t0, gameT, after)
      charIndex += ln.length + 1 // + space between lines (approx)
      y += lh
    }

    // embers after end
    if (after >= 0) this.drawEmbers(ctx, lines, after)
  }

  private drawIgnited(
    ctx: CanvasRenderingContext2D, ln: string, x: number, y: number,
    baseIdx: number, revealed: number, _t0: number, gameT: number, after: number,
  ) {
    let cx = x
    for (let i = 0; i < ln.length; i++) {
      const ch = ln[i]
      const globalI = baseIdx + i
      if (globalI >= revealed && after < 0) break
      // ignition: each glyph goes hot→amber over 0.2s from when it appears
      // Glyph i is "revealed" once progress has crossed it; then it ignites
      // hot→amber over 0.2s of wall-clock speech (≈ CHAR_PER_SEC * 0.2 chars).
      const igniteChars = Math.max(1, CHAR_PER_SEC * 0.2)
      const ignite = after >= 0 ? 1 : Math.min(1, Math.max(0, (revealed - globalI) / igniteChars))
      const color = ignite >= 1 ? AMBER : this.lerpColor(HOT, AMBER, ignite)
      // outline
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (ox || oy) drawText(ctx, ch, cx + ox, y + oy, INK, 'big', 1)
      }
      if (after >= 0) {
        // dissolving: fade toward ember then out
        const fade = Math.min(1, after / 0.5)
        ctx.globalAlpha = 1 - fade
        drawText(ctx, ch, cx, y, fade > 0.3 ? EMBER : color, 'big', 1)
        ctx.globalAlpha = 1
      } else {
        drawText(ctx, ch, cx, y, color, 'big', 1)
      }
      cx += ch === ' ' ? 3 : 6
    }
  }

  private drawEmbers(ctx: CanvasRenderingContext2D, lines: string[], after: number) {
    // a few rising ember pixels
    const n = 12
    for (let i = 0; i < n; i++) {
      const seed = i * 97.13
      const px = (this.w * 0.2) + ((seed * 13) % (this.w * 0.6))
      const py = this.h - 14 - after * 40 - ((seed * 7) % 10)
      const a = Math.max(0, 1 - after / 0.5)
      ctx.globalAlpha = a * 0.8
      ctx.fillStyle = i % 2 ? HOT : EMBER
      ctx.fillRect(px | 0, py | 0, 1, 1)
    }
    ctx.globalAlpha = 1
    void lines
  }

  private lerpColor(a: string, b: string, t: number) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
    const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255
    const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255
    const r = (ar + (br - ar) * t) | 0
    const g = (ag + (bg - ag) * t) | 0
    const bl = (ab + (bb - ab) * t) | 0
    return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`
  }
}
