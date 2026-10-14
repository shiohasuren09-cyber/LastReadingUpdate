// Pixel fonts: 5x7 for subtitles (every character explicit), 3x5 for card captions.
// Unsupported characters draw nothing and warn once — never a "?".

const BIG: Record<string, string> = {
  ' ': '00000000000000000000000000000000000', // space: no pixels; advance handled specially
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110', D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110', J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001',
  O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  a: '01110100011000111111100011000110001', b: '11110100011000111110100011000111110',
  c: '01110100011000010000100001000101110', d: '11110100011000110001100011000111110',
  e: '11111100001000011110100001000011111', f: '11111100001000011110100001000010000',
  g: '01110100011000010111100011000101111', h: '10001100011000111111100011000110001',
  i: '01110001000010000100001000010001110', j: '00111000100001000010000101001001100',
  k: '10001100101010011000101001001010001', l: '10000100001000010000100001000011111',
  m: '10001110111010110101100011000110001', n: '10001100011100110101100111000110001',
  o: '01110100011000110001100011000101110', p: '11110100011000111110100001000010000',
  q: '01110100011000110001101011001001101', r: '11110100011000111110101001001010001',
  s: '01111100001000001110000010000111110', t: '11111001000010000100001000010000100',
  u: '10001100011000110001100011000101110', v: '10001100011000110001100010101000100',
  w: '10001100011000110101101011010101010', x: '10001100010101000100010101000110001',
  y: '10001100010101000100001000010000100', z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110',
  '2': '01110100010000100010001000100011111', '3': '11110000010000101110000010000111110',
  '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000',
  '8': '01110100011000101110100011000101110', '9': '01110100011000101111000010001001100',
  '.': '00000000000000000000000000110001100', ',': '00000000000000000000011000010001000',
  "'": '00100001000100000000000000000000000', '-': '00000000000000001110000000000000000',
  '!': '00100001000010000100001000000000100', '?': '01110100010000100010001000000000100',
  ':': '00000011000110000000011000110000000', ';': '00000011000110000000011000010001000',
  '(': '00010001000010000100001000010000010', ')': '01000001000001000010000100001000100',
}

const SMALL: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
  Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
  '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010',
  '8': '111101111101111', '9': '111101111001110', '.': '000000000000010', '-': '000000111000000',
  "'": '010010000000000', ' ': '000000000000000',
}

const warned = new Set<string>()

export type FontSize = 'big' | 'small'

export function glyphW(size: FontSize) {
  return size === 'big' ? 5 : 3
}
export function glyphH(size: FontSize) {
  return size === 'big' ? 7 : 5
}

/** Space advances 3px (big) / 2px (small) with no pixels. */
export function charAdvance(ch: string, size: FontSize) {
  if (ch === ' ') return size === 'big' ? 3 : 2
  return glyphW(size) + 1
}

/**
 * Normalize for the pixel font: curly quotes → ', ellipsis → ..., dashes → -,
 * NBSP → space, collapse spaces, strip unsupported (with a one-shot warn).
 */
export function normalizeText(raw: string): string {
  let s = raw
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, "'")
    .replace(/…/g, '...')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let out = ''
  for (const ch of s) {
    if (ch === ' ' || BIG[ch]) out += ch
    else if (!warned.has(ch)) {
      warned.add(ch)
      console.warn(`last-reading font: unsupported character U+${ch.charCodeAt(0).toString(16)}`)
    }
  }
  return out
}

/** Throw if any character is unsupported — call at startup on every fixed line. */
export function assertSupported(text: string, label = 'line') {
  const n = normalizeText(text)
  for (const ch of n) {
    if (ch !== ' ' && !BIG[ch]) throw new Error(`font assert (${label}): unsupported '${ch}'`)
  }
  return n
}

export function textWidth(text: string, size: FontSize) {
  if (!text) return 0
  let w = 0
  for (let i = 0; i < text.length; i++) {
    w += charAdvance(text[i], size)
    if (i < text.length - 1 && text[i] !== ' ') { /* advance already includes gap */ }
  }
  // charAdvance already includes +1 gap for glyphs; trim trailing gap for last non-space
  if (text[text.length - 1] !== ' ') w -= 1
  return Math.max(0, w)
}

export function drawText(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
  color: string, size: FontSize = 'big', scale = 1,
) {
  const table = size === 'big' ? BIG : SMALL
  const gw = glyphW(size), gh = glyphH(size)
  ctx.fillStyle = color
  let cx = x
  for (const raw of text) {
    if (raw === ' ') { cx += (size === 'big' ? 3 : 2) * scale; continue }
    const g = table[raw] ?? (size === 'big' ? BIG[raw.toUpperCase()] : SMALL[raw.toUpperCase()])
    if (g) {
      for (let r = 0; r < gh; r++) {
        for (let c = 0; c < gw; c++) {
          if (g.charCodeAt(r * gw + c) === 49) ctx.fillRect(cx + c * scale, y + r * scale, scale, scale)
        }
      }
    }
    cx += (gw + 1) * scale
  }
}

export function drawOutlined(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
  color: string, outline: string, size: FontSize = 'big', scale = 1,
) {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox || oy) drawText(ctx, text, x + ox * scale, y + oy * scale, outline, size, scale)
    }
  }
  drawText(ctx, text, x, y, color, size, scale)
}

/** Wrap by measured pixel width (not character count). Max `maxLines` lines. */
export function wrapToWidth(text: string, maxPx: number, size: FontSize = 'big', maxLines = 2): string[] {
  const words = normalizeText(text).split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const trial = line ? line + ' ' + w : w
    if (textWidth(trial, size) <= maxPx) line = trial
    else {
      if (line) lines.push(line)
      line = w
      if (lines.length >= maxLines) break
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  return lines
}

// Keep old name for card captions
export function wrap(text: string, maxChars: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (!line) line = w
    else if (line.length + 1 + w.length <= maxChars) line += ' ' + w
    else { lines.push(line); line = w }
  }
  if (line) lines.push(line)
  return lines
}
