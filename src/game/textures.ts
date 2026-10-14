// Procedural pixel textures: one prop atlas (64×64 and 32×32 tiles) and one
// card atlas (64×112 tiles). Painting is split into jobs so the title screen
// can bake them in <8ms slices.
import * as THREE from 'three'
import { CARD, CARD_DEFS, type Symbol } from './config'
import { drawText, textWidth } from './font'

// ── tiny seeded RNG ──
let seed = 1
function srand(s: number) { seed = s >>> 0 || 1 }
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }

type RGB = [number, number, number]
function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Pixel painter over a sub-rectangle of an ImageData-backed canvas. */
class Painter {
  data: Uint8ClampedArray
  constructor(public img: ImageData, public ox: number, public oy: number, public w: number, public h: number) {
    this.data = img.data
  }
  set(x: number, y: number, c: RGB, a = 255) {
    x |= 0; y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = ((this.oy + y) * this.img.width + this.ox + x) * 4
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = a
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c)
  }
  fill(c: RGB) { this.rect(0, 0, this.w, this.h, c) }
  frame(x: number, y: number, w: number, h: number, c: RGB) {
    for (let i = 0; i < w; i++) { this.set(x + i, y, c); this.set(x + i, y + h - 1, c) }
    for (let j = 0; j < h; j++) { this.set(x, y + j, c); this.set(x + w - 1, y + j, c) }
  }
  disc(cx: number, cy: number, r: number, c: RGB) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, c)
  }
  ring(cx: number, cy: number, r0: number, r1: number, c: RGB) {
    for (let y = Math.floor(cy - r1); y <= cy + r1; y++)
      for (let x = Math.floor(cx - r1); x <= cx + r1; x++) {
        const d = (x - cx) ** 2 + (y - cy) ** 2
        if (d <= r1 * r1 && d >= r0 * r0) this.set(x, y, c)
      }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= n; i++) this.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c)
  }
  poly(pts: number[], c: RGB) {
    let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i])
      minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1])
    }
    for (let y = Math.floor(minY); y <= maxY; y++)
      for (let x = Math.floor(minX); x <= maxX; x++) {
        let inside = false
        const px = x + 0.5, py = y + 0.5
        for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
          const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1]
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
        }
        if (inside) this.set(x, y, c)
      }
  }
  noise(cols: RGB[], amount: number) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++)
      if (rnd() < amount) this.set(x, y, cols[(rnd() * cols.length) | 0])
  }
}

// ── palette shortcuts ──
const C = {
  ink: hex('#1c1626'), ink2: hex('#261d33'), vio0: hex('#2f2440'), vio1: hex('#3b2c4f'), vio2: hex('#4a3760'),
  vio3: hex('#5d4673'), vio4: hex('#735a8a'), vio5: hex('#8f78a3'),
  wine0: hex('#3a1a24'), wine1: hex('#50202e'), wine2: hex('#6b2a38'), wine3: hex('#8a3442'), wine4: hex('#a8474e'), wine5: hex('#c4625e'),
  amb0: hex('#4a2c1c'), amb1: hex('#6b3f22'), amb2: hex('#8f5628'), amb3: hex('#b0702e'), amb4: hex('#d08f3c'), amb5: hex('#e8b25a'), amb6: hex('#f5d08a'),
  gold0: hex('#5c4a24'), gold1: hex('#7d6630'), gold2: hex('#a08440'), gold3: hex('#c4a858'),
  bone0: hex('#6e6250'), bone1: hex('#9a8a70'), bone2: hex('#c2b292'), bone3: hex('#e0d4b4'), bone4: hex('#f4ead2'),
  moss0: hex('#263224'), moss1: hex('#34442c'), moss2: hex('#4a5a36'), moss3: hex('#66753f'),
  oak0: hex('#3a2a22'), oak1: hex('#5a3e2c'), oak2: hex('#7a5636'), oak3: hex('#9a7044'),
}

// ── prop atlas layout ──
export const ATLAS_SIZE = 512
export enum T {
  OAK_TOP, OAK_DARK, VELVET_VIO, VELVET_WINE, STONE, WALL, FLOOR, BRASS,
  ROBE_CAPTIVE, ROBE_READER, FACE, HAIR, CURTAIN, BOOKS, CEILING, WHEEL,
  READER_FACE, SKIN, WOOD_PALE, CHAIN,
  // 32×32 tiles start here (each occupies a quarter of a 64 slot)
  COIN_GOLD = 100, COIN_BLACK, BEAD, WAX, FLAME, IRON, CORD, GLASS,
}
const BIG_COUNT = 20
/** UV rect [u0, v0, u1, v1] of a tile inside the prop atlas (flipY=false, v down). */
export function tileRect(t: T): [number, number, number, number] {
  let x: number, y: number, s: number
  if (t < 100) { x = (t % 8) * 64; y = Math.floor(t / 8) * 64; s = 64 }
  else {
    const k = t - 100
    const slot = BIG_COUNT + (k >> 2)
    const q = k & 3
    x = (slot % 8) * 64 + (q & 1) * 32; y = Math.floor(slot / 8) * 64 + (q >> 1) * 32; s = 32
  }
  const e = 0.5 // half-texel inset against bleeding
  return [(x + e) / ATLAS_SIZE, (y + e) / ATLAS_SIZE, (x + s - e) / ATLAS_SIZE, (y + s - e) / ATLAS_SIZE]
}
function tileOrigin(t: T): [number, number, number] {
  if (t < 100) return [(t % 8) * 64, Math.floor(t / 8) * 64, 64]
  const k = t - 100, slot = BIG_COUNT + (k >> 2), q = k & 3
  return [(slot % 8) * 64 + (q & 1) * 32, Math.floor(slot / 8) * 64 + (q >> 1) * 32, 32]
}

// ── card atlas layout ──
export const CARD_COLS = 8
export const CARD_ATLAS_W = CARD.texW * CARD_COLS
export const CARD_ATLAS_H = CARD.texH * 2
export function cardRect(tile: number): [number, number, number, number] {
  const x = (tile % CARD_COLS) * CARD.texW, y = Math.floor(tile / CARD_COLS) * CARD.texH
  const e = 0.5
  return [(x + e) / CARD_ATLAS_W, (y + e) / CARD_ATLAS_H, (x + CARD.texW - e) / CARD_ATLAS_W, (y + CARD.texH - e) / CARD_ATLAS_H]
}

// ── tile painters ──
function paintPlanks(p: Painter, base: RGB[], vertical: boolean) {
  const plank = 16
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const a = vertical ? x : y, b = vertical ? y : x
    const band = Math.floor(a / plank)
    const g = Math.sin(b * 0.18 + band * 2.1 + Math.sin(a * 0.9) * 1.4)
    let k = g > 0.55 ? 0 : g < -0.6 ? 2 : 1
    if (band % 2) k = Math.min(k + (rnd() < 0.15 ? 1 : 0), 2)
    p.set(x, y, base[k + (a % plank === 0 ? 0 : 1)] ?? base[k])
    if (a % plank === 0) p.set(x, y, base[0])
  }
  for (let i = 0; i < 3; i++) {
    const kx = (rnd() * p.w) | 0, ky = (rnd() * p.h) | 0
    p.ring(kx, ky, 1, 2.5, base[0]); p.set(kx, ky, base[1])
  }
}

function paintVelvet(p: Painter, dark: RGB, mid: RGB, lite: RGB, trim: RGB, trimLite: RGB) {
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const n = Math.sin(x * 0.7 + y * 0.31) + Math.sin(y * 0.53 - x * 0.2)
    p.set(x, y, n > 1.1 ? lite : n < -0.9 ? dark : mid)
  }
  p.frame(2, 2, p.w - 4, p.h - 4, trim)
  p.frame(4, 4, p.w - 8, p.h - 8, trimLite)
  for (let i = 6; i < p.w - 6; i += 4) { p.set(i, 3, trimLite); p.set(i, p.h - 4, trimLite) }
  for (let j = 6; j < p.h - 6; j += 4) { p.set(3, j, trimLite); p.set(p.w - 4, j, trimLite) }
  // corner diamonds
  const corners = [8, 8, p.w - 9, 8, 8, p.h - 9, p.w - 9, p.h - 9]
  for (let i = 0; i < 8; i += 2) p.poly([corners[i], corners[i + 1] - 3, corners[i] + 3, corners[i + 1], corners[i], corners[i + 1] + 3, corners[i] - 3, corners[i + 1]], trimLite)
  // card slot outline in the centre
  const cx = p.w / 2, cy = p.h / 2
  for (let i = -9; i <= 9; i += 2) { p.set(cx + i, cy - 14, trim); p.set(cx + i, cy + 14, trim) }
  for (let j = -14; j <= 14; j += 2) { p.set(cx - 9, cy + j, trim); p.set(cx + 9, cy + j, trim) }
}

function paintStoneBlocks(p: Painter, bw: number, bh: number, cols: RGB[], mortar: RGB, moss: boolean) {
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const row = Math.floor(y / bh)
    const xo = x + (row % 2) * (bw / 2)
    const edge = y % bh === 0 || xo % bw === 0
    const r = rnd()
    p.set(x, y, edge ? mortar : r < 0.2 ? cols[0] : r < 0.85 ? cols[1] : cols[2])
  }
  for (let i = 0; i < 4; i++) {
    let x = rnd() * p.w, y = rnd() * p.h
    for (let k = 0; k < 6; k++) { p.set(x, y, mortar); x += rnd() * 2 - 0.5; y += rnd() * 2 - 1 }
  }
  if (moss) for (let i = 0; i < 40; i++) {
    const x = rnd() * p.w, y = p.h - rnd() * rnd() * p.h
    p.set(x, y, rnd() < 0.5 ? C.moss1 : C.moss2)
  }
}

function paintCloth(p: Painter, cols: RGB[], hem: RGB | null) {
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const f = Math.sin(x * 0.45 + Math.sin(y * 0.08) * 2)
    p.set(x, y, f > 0.6 ? cols[2] : f < -0.5 ? cols[0] : cols[1])
  }
  if (hem) {
    p.rect(0, p.h - 6, p.w, 1, hem)
    for (let x = 1; x < p.w; x += 4) { p.set(x, p.h - 4, hem); p.set(x + 1, p.h - 3, hem); p.set(x + 2, p.h - 4, hem) }
    p.rect(0, p.h - 2, p.w, 1, hem)
  }
}

function paintFace(p: Painter) {
  p.fill(C.amb2)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (rnd() < 0.08) p.set(x, y, C.amb1)
  p.rect(0, 0, 64, 14, C.ink2) // hair line
  for (let x = 0; x < 64; x += 3) p.rect(x, 12, 2, 4 + ((x * 7) % 5), C.ink2)
  p.rect(0, 0, 6, 64, C.ink2); p.rect(58, 0, 6, 64, C.ink2)
  // brows and eyes
  p.rect(14, 24, 12, 2, C.oak0); p.rect(38, 24, 12, 2, C.oak0)
  p.rect(15, 29, 10, 5, C.bone3); p.rect(39, 29, 10, 5, C.bone3)
  p.rect(18, 29, 4, 5, C.vio1); p.rect(42, 29, 4, 5, C.vio1)
  p.set(19, 30, C.bone4); p.set(43, 30, C.bone4)
  p.rect(15, 35, 10, 1, C.amb1); p.rect(39, 35, 10, 1, C.amb1)
  // nose, mouth, bruise
  p.rect(31, 32, 2, 12, C.amb1); p.rect(29, 44, 6, 2, C.amb1)
  p.rect(24, 51, 16, 2, C.wine2); p.rect(26, 53, 12, 1, C.wine1)
  p.disc(48, 42, 4, C.vio3); p.disc(48, 42, 2, C.vio2)
}

function paintReaderFace(p: Painter) {
  p.fill(C.ink)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const d = Math.hypot(x - 32, (y - 36) * 0.8)
    if (d < 22) p.set(x, y, C.gold1)
    if (d < 20) p.set(x, y, (x + y) % 7 === 0 ? C.gold1 : C.gold2)
  }
  p.rect(18, 30, 10, 4, C.ink); p.rect(36, 30, 10, 4, C.ink)
  p.rect(21, 31, 3, 2, C.amb6); p.rect(40, 31, 3, 2, C.amb6)
  p.rect(30, 38, 4, 8, C.gold3); p.rect(24, 50, 16, 2, C.ink)
  p.rect(31, 8, 2, 12, C.gold3); p.ring(32, 14, 3, 5, C.gold3)
}

function paintWheel(p: Painter) {
  p.fill(C.bone1)
  p.noise([C.bone0, C.bone2], 0.25)
  p.frame(0, 0, 64, 64, C.oak0); p.frame(1, 1, 62, 62, C.gold1)
  p.ring(32, 32, 20, 23, C.wine3); p.ring(32, 32, 8, 10, C.wine3)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    p.line(32 + Math.cos(a) * 10, 32 + Math.sin(a) * 10, 32 + Math.cos(a) * 20, 32 + Math.sin(a) * 20, C.ink2)
    p.disc(32 + Math.cos(a + 0.4) * 15, 32 + Math.sin(a + 0.4) * 15, 1.5, C.gold2)
  }
  p.disc(32, 32, 4, C.ink2); p.disc(32, 32, 2, C.amb5)
  for (let i = 0; i < 4; i++) p.disc(i % 2 ? 6 : 57, i < 2 ? 6 : 57, 2.5, C.vio2)
}

function paintBooks(p: Painter) {
  p.fill(C.oak0)
  const cols = [C.wine2, C.vio3, C.moss2, C.amb1, C.wine3, C.vio2, C.bone1, C.moss1]
  for (let shelf = 0; shelf < 2; shelf++) {
    let x = 1
    const y0 = shelf * 32
    while (x < 63) {
      const w = 3 + ((rnd() * 4) | 0), h = 18 + ((rnd() * 10) | 0)
      const c = cols[(rnd() * cols.length) | 0]
      p.rect(x, y0 + 30 - h, w, h, c)
      p.rect(x, y0 + 30 - h + 3, w, 1, C.gold2)
      p.rect(x, y0 + 30 - 5, w, 1, C.gold1)
      x += w + (rnd() < 0.2 ? 2 : 0)
    }
    p.rect(0, y0 + 30, 64, 2, C.oak2)
  }
}

function paintCoin(p: Painter, rim: RGB, face: RGB, mark: RGB, hi: RGB) {
  p.fill(rim)
  p.ring(16, 16, 12, 15.5, rim)
  p.disc(16, 16, 12, face)
  p.ring(16, 16, 10, 11, mark)
  p.disc(16, 16, 4, mark); p.disc(16, 16, 2, face)
  p.set(10, 9, hi); p.set(11, 9, hi); p.set(10, 10, hi)
}

function paintBrass(p: Painter, s: number) {
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const g = (y / s) * 3 + Math.sin(x * 0.6) * 0.4 + rnd() * 0.5
    p.set(x, y, g < 0.9 ? C.gold3 : g < 1.9 ? C.gold2 : g < 2.8 ? C.gold1 : C.gold0)
  }
  for (let i = 0; i < 8; i++) p.set(rnd() * s, rnd() * s, C.amb6)
}

const PROP_JOBS: [T, (p: Painter) => void][] = [
  [T.OAK_TOP, (p) => paintPlanks(p, [C.oak0, C.oak1, C.oak2, C.oak3], false)],
  [T.OAK_DARK, (p) => paintPlanks(p, [C.ink2, C.oak0, C.oak1, C.oak2], true)],
  [T.VELVET_VIO, (p) => paintVelvet(p, C.vio1, C.vio2, C.vio3, C.gold1, C.gold3)],
  [T.VELVET_WINE, (p) => paintVelvet(p, C.wine0, C.wine1, C.wine2, C.gold1, C.gold3)],
  [T.STONE, (p) => paintStoneBlocks(p, 16, 8, [C.vio2, C.vio3, C.vio4], C.vio1, false)],
  [T.WALL, (p) => paintStoneBlocks(p, 32, 16, [C.vio1, C.vio2, C.vio3], C.ink2, true)],
  [T.FLOOR, (p) => paintPlanks(p, [C.ink2, C.oak0, C.oak0, C.oak1], false)],
  [T.BRASS, (p) => paintBrass(p, 64)],
  [T.ROBE_CAPTIVE, (p) => paintCloth(p, [C.vio1, C.vio2, C.vio3], null)],
  [T.ROBE_READER, (p) => paintCloth(p, [C.ink2, C.wine0, C.wine1], C.gold2)],
  [T.FACE, paintFace],
  [T.HAIR, (p) => { p.fill(C.ink2); for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) if ((x * 3 + (y >> 2)) % 5 === 0) p.set(x, y, C.vio1) }],
  [T.CURTAIN, (p) => paintCloth(p, [C.wine0, C.wine1, C.wine2], C.gold1)],
  [T.BOOKS, paintBooks],
  [T.CEILING, (p) => paintPlanks(p, [C.ink, C.ink2, C.vio0, C.oak0], true)],
  [T.WHEEL, paintWheel],
  [T.READER_FACE, paintReaderFace],
  [T.SKIN, (p) => { p.fill(C.amb2); p.noise([C.amb1, C.amb3], 0.15) }],
  [T.WOOD_PALE, (p) => paintPlanks(p, [C.oak1, C.oak2, C.oak3, C.bone1], true)],
  [T.CHAIN, (p) => { p.fill(C.ink2); for (let y = 0; y < 64; y += 8) { p.ring(32, y + 4, 2, 4, C.bone1); p.set(30, y + 2, C.bone3) } }],
  [T.COIN_GOLD, (p) => paintCoin(p, C.gold1, C.amb5, C.gold2, C.bone4)],
  [T.COIN_BLACK, (p) => paintCoin(p, C.vio3, C.ink2, C.wine4, C.vio5)],
  [T.BEAD, (p) => { p.fill(C.bone2); p.noise([C.bone1, C.bone3], 0.3); p.rect(0, 14, 32, 4, C.bone1) }],
  [T.WAX, (p) => { p.fill(C.bone3); p.noise([C.bone2], 0.3); for (let x = 0; x < 32; x += 5) p.rect(x, 0, 2, 4 + (x % 7), C.bone4) }],
  [T.FLAME, (p) => { p.fill(C.amb5); p.disc(16, 18, 9, C.amb6); p.disc(16, 20, 4, C.bone4) }],
  [T.IRON, (p) => { p.fill(C.vio1); p.noise([C.ink2, C.vio2], 0.4) }],
  [T.CORD, (p) => { p.fill(C.ink2); for (let y = 0; y < 32; y += 3) p.rect(0, y, 32, 1, C.oak0) }],
  [T.GLASS, (p) => { p.fill(C.amb6); p.noise([C.amb5, C.bone4], 0.35) }],
]

// ── card art ──
function sym(p: Painter, s: Symbol, cx: number, cy: number) {
  switch (s) {
    case 'sun':
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2, r1 = i % 2 ? 13 : 15
        p.line(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, C.amb4)
      }
      p.disc(cx, cy, 8, C.amb5); p.disc(cx, cy, 5, C.amb6); p.set(cx - 2, cy - 1, C.amb2); p.set(cx + 2, cy - 1, C.amb2)
      break
    case 'star':
      p.poly([cx, cy - 14, cx + 4, cy - 4, cx + 14, cy - 3, cx + 6, cy + 4, cx + 9, cy + 14, cx, cy + 8, cx - 9, cy + 14, cx - 6, cy + 4, cx - 14, cy - 3, cx - 4, cy - 4], C.vio5)
      p.poly([cx, cy - 8, cx + 3, cy - 2, cx + 8, cy - 1, cx + 4, cy + 3, cx + 5, cy + 8, cx, cy + 5, cx - 5, cy + 8, cx - 4, cy + 3, cx - 8, cy - 1, cx - 3, cy - 2], C.bone4)
      break
    case 'hearts': {
      const heart = (x: number, y: number, c: RGB, c2: RGB) => {
        p.disc(x - 3, y - 2, 3.4, c); p.disc(x + 3, y - 2, 3.4, c); p.poly([x - 6.5, y - 1, x + 6.5, y - 1, x, y + 7], c); p.set(x - 4, y - 3, c2)
      }
      heart(cx - 5, cy - 3, C.wine4, C.bone4); heart(cx + 5, cy + 3, C.wine5, C.bone4)
      p.line(cx - 13, cy + 10, cx + 13, cy - 10, C.amb5)
      break
    }
    case 'crown':
      p.poly([cx - 12, cy + 8, cx - 12, cy - 6, cx - 6, cy + 1, cx, cy - 10, cx + 6, cy + 1, cx + 12, cy - 6, cx + 12, cy + 8], C.amb5)
      p.rect(cx - 12, cy + 6, 25, 3, C.amb4)
      p.disc(cx, cy - 10, 2, C.wine4); p.disc(cx - 12, cy - 6, 1.5, C.moss3); p.disc(cx + 12, cy - 6, 1.5, C.moss3); p.disc(cx, cy + 2, 2, C.wine5)
      break
    case 'wand':
      p.line(cx - 10, cy + 12, cx + 8, cy - 8, C.oak3); p.line(cx - 9, cy + 12, cx + 9, cy - 8, C.oak3); p.line(cx - 10, cy + 13, cx + 8, cy - 7, C.oak2)
      p.disc(cx + 9, cy - 9, 4, C.amb6)
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.78; p.line(cx + 9, cy - 9, cx + 9 + Math.cos(a) * 8, cy - 9 + Math.sin(a) * 8, C.amb4) }
      break
    case 'tower':
      p.rect(cx - 6, cy - 6, 12, 20, C.bone1); p.rect(cx - 8, cy - 9, 16, 4, C.bone2)
      p.rect(cx - 2, cy + 6, 4, 8, C.ink); p.rect(cx - 4, cy - 2, 2, 3, C.amb5); p.rect(cx + 2, cy - 2, 2, 3, C.amb5)
      p.line(cx + 2, cy - 16, cx - 3, cy - 9, C.amb6); p.line(cx - 3, cy - 9, cx + 4, cy - 7, C.amb6); p.line(cx + 4, cy - 7, cx - 1, cy + 1, C.amb6)
      p.disc(cx - 9, cy - 11, 2, C.wine5); p.disc(cx + 10, cy - 4, 1.5, C.wine5)
      break
    case 'skull':
      p.disc(cx, cy - 3, 10, C.bone4); p.rect(cx - 6, cy + 4, 12, 7, C.bone3)
      p.disc(cx - 4, cy - 3, 3, C.ink); p.disc(cx + 4, cy - 3, 3, C.ink)
      p.poly([cx, cy + 1, cx - 2, cy + 5, cx + 2, cy + 5], C.ink)
      for (let x = -5; x <= 5; x += 2) p.rect(cx + x, cy + 8, 1, 3, C.ink)
      break
    case 'horned':
      p.poly([cx - 9, cy - 4, cx - 14, cy - 15, cx - 5, cy - 8], C.bone3); p.poly([cx + 9, cy - 4, cx + 14, cy - 15, cx + 5, cy - 8], C.bone3)
      p.disc(cx, cy + 1, 9, C.wine3); p.poly([cx - 6, cy + 7, cx + 6, cy + 7, cx, cy + 15], C.wine3)
      p.rect(cx - 6, cy - 2, 4, 2, C.amb6); p.rect(cx + 2, cy - 2, 4, 2, C.amb6)
      p.rect(cx - 4, cy + 5, 8, 1, C.ink)
      break
    case 'hanged':
      p.rect(cx - 12, cy - 15, 24, 2, C.oak3); p.line(cx, cy - 13, cx, cy - 9, C.bone2)
      p.rect(cx - 2, cy - 9, 4, 10, C.vio5); p.line(cx - 2, cy - 9, cx - 5, cy - 4, C.vio5)
      p.rect(cx - 4, cy + 1, 8, 9, C.wine4); p.disc(cx, cy + 12, 3, C.bone3)
      p.line(cx - 4, cy + 3, cx - 7, cy + 8, C.bone2); p.line(cx + 3, cy + 3, cx + 6, cy + 8, C.bone2)
      break
    case 'moon':
      p.disc(cx, cy, 11, C.bone3); p.disc(cx + 6, cy - 3, 10, C.ink2)
      p.set(cx - 6, cy - 2, C.vio1); p.set(cx - 7, cy + 3, C.vio1)
      p.disc(cx + 8, cy + 8, 1, C.bone4); p.disc(cx + 11, cy - 11, 1, C.bone4)
      break
    case 'cup':
      p.poly([cx - 9, cy - 8, cx + 9, cy - 8, cx + 5, cy + 3, cx - 5, cy + 3], C.gold3)
      p.rect(cx - 1, cy + 3, 3, 6, C.gold2); p.rect(cx - 6, cy + 9, 13, 2, C.gold2); p.rect(cx - 8, cy - 8, 17, 2, C.bone4)
      break
    case 'rod':
      p.rect(cx - 1, cy - 13, 3, 26, C.oak3); p.rect(cx + 2, cy - 6, 3, 2, C.moss3); p.rect(cx - 4, cy + 3, 3, 2, C.moss3)
      break
    case 'sword':
      p.rect(cx - 1, cy - 14, 3, 20, C.bone3); p.rect(cx - 6, cy + 6, 13, 2, C.gold2); p.rect(cx - 1, cy + 8, 3, 5, C.oak2)
      break
    case 'coin':
      p.disc(cx, cy, 10, C.gold3); p.ring(cx, cy, 7, 8, C.gold1)
      p.poly([cx, cy - 5, cx + 5, cy + 4, cx - 5, cy + 4], C.gold1); p.poly([cx, cy - 2, cx + 2.5, cy + 2.5, cx - 2.5, cy + 2.5], C.gold3)
      break
  }
}

function paintCardBack(p: Painter) {
  p.fill(C.vio1)
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if ((x + y) % 6 === 0 || (x - y + 600) % 6 === 0) p.set(x, y, C.vio2)
  p.frame(0, 0, p.w, p.h, C.ink); p.frame(2, 2, p.w - 4, p.h - 4, C.gold2); p.frame(4, 4, p.w - 8, p.h - 8, C.gold1)
  const cx = 32, cy = 56
  p.disc(cx, cy, 15, C.vio0)
  p.poly([cx - 14, cy, cx, cy - 8, cx + 14, cy, cx, cy + 8], C.gold3)
  p.poly([cx - 11, cy, cx, cy - 6, cx + 11, cy, cx, cy + 6], C.bone3)
  p.disc(cx, cy, 4, C.gold2); p.disc(cx, cy, 2, C.ink); p.set(cx - 1, cy - 1, C.bone4)
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; p.line(cx + Math.cos(a) * 17, cy + Math.sin(a) * 17, cx + Math.cos(a) * 21, cy + Math.sin(a) * 21, C.gold2) }
  for (const [x, y] of [[10, 10], [53, 10], [10, 101], [53, 101]]) p.poly([x, y - 3, x + 3, y, x, y + 3, x - 3, y], C.gold3)
}

function paintCardFace(p: Painter, idx: number, ctx: CanvasRenderingContext2D) {
  const def = CARD_DEFS[idx]
  const boon = def.kind === 'boon', bane = def.kind === 'bane'
  p.fill(C.bone3)
  p.noise([C.bone2], 0.12)
  p.frame(0, 0, 64, 112, C.ink)
  p.frame(2, 2, 60, 108, boon ? C.gold2 : bane ? C.wine3 : C.bone0)
  // art panel
  const panel = boon ? C.vio1 : bane ? C.wine0 : C.bone2
  p.rect(6, 12, 52, 64, panel)
  p.frame(5, 11, 54, 66, boon ? C.gold3 : bane ? C.wine4 : C.bone1)
  if (boon || bane) for (let i = 0; i < 20; i++) p.set(7 + rnd() * 50, 13 + rnd() * 62, boon ? C.vio3 : C.wine2)
  sym(p, def.symbol, 32, 43)
  // pips: gold for boons, red for banes, equal to |value|
  const n = Math.abs(def.value)
  for (let i = 0; i < n; i++) {
    const x = 32 + (i - (n - 1) / 2) * 11
    if (boon) { p.disc(x, 85, 3.5, C.gold1); p.disc(x, 85, 2.5, C.amb5); p.set(x - 1, 84, C.bone4) }
    else { p.poly([x, 81, x + 4, 85, x, 89, x - 4, 85], C.wine1); p.poly([x, 82, x + 3, 85, x, 88, x - 3, 85], C.wine4) }
  }
  if (!boon && !bane) { p.rect(16, 84, 32, 1, C.bone1) }
  // numeral strip on top
  p.rect(6, 4, 52, 6, boon ? C.gold1 : bane ? C.wine1 : C.bone1)
  return () => {
    // caption text via the shared pixel font (needs the canvas, drawn after putImageData)
    const ox = (CARD_DEFS[idx].tile % CARD_COLS) * CARD.texW, oy = Math.floor(CARD_DEFS[idx].tile / CARD_COLS) * CARD.texH
    const name = def.name.replace('THE ', '')
    const w = textWidth(name, 'small')
    drawText(ctx, name, ox + Math.round(32 - w / 2), oy + 96, '#261d33', 'small')
    const tag = boon ? '+' + def.value : bane ? String(def.value) : 'ACE'
    const tw = textWidth(tag, 'small')
    drawText(ctx, tag, ox + Math.round(32 - tw / 2), oy + 5, boon ? '#f5d08a' : bane ? '#f4ead2' : '#3b2c4f', 'small')
  }
}

// ── public API ──
export interface Textures {
  prop: THREE.CanvasTexture
  cards: THREE.CanvasTexture
  blob: THREE.CanvasTexture
  /** Runs bake jobs for up to `budgetMs`. Returns true once everything is baked. */
  bake(budgetMs: number): boolean
  ready: boolean
}

function makeTex(canvas: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(canvas)
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.flipY = false
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export function createTextures(): Textures {
  const propCanvas = document.createElement('canvas')
  propCanvas.width = propCanvas.height = ATLAS_SIZE
  const pctx = propCanvas.getContext('2d', { willReadFrequently: true })!
  pctx.fillStyle = '#4a3760'; pctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
  const pimg = pctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE)

  const cardCanvas = document.createElement('canvas')
  cardCanvas.width = CARD_ATLAS_W; cardCanvas.height = CARD_ATLAS_H
  const cctx = cardCanvas.getContext('2d', { willReadFrequently: true })!
  cctx.fillStyle = '#3b2c4f'; cctx.fillRect(0, 0, CARD_ATLAS_W, CARD_ATLAS_H)
  const cimg = cctx.getImageData(0, 0, CARD_ATLAS_W, CARD_ATLAS_H)

  const blobCanvas = document.createElement('canvas')
  blobCanvas.width = blobCanvas.height = 32
  const bctx = blobCanvas.getContext('2d')!
  const bimg = bctx.createImageData(32, 32)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5) / 16
    const a = d >= 1 ? 0 : Math.round((1 - d * d) * 4) * 40 // banded alpha for the pixel look
    const i = (y * 32 + x) * 4
    bimg.data[i] = 28; bimg.data[i + 1] = 22; bimg.data[i + 2] = 38; bimg.data[i + 3] = a
  }
  bctx.putImageData(bimg, 0, 0)

  const prop = makeTex(propCanvas), cards = makeTex(cardCanvas), blob = makeTex(blobCanvas)

  const post: (() => void)[] = []
  const jobs: (() => void)[] = []
  for (const [tile, fn] of PROP_JOBS) {
    jobs.push(() => {
      srand(tile * 977 + 13)
      const [x, y, s] = tileOrigin(tile)
      fn(new Painter(pimg, x, y, s, s))
    })
  }
  jobs.push(() => {
    srand(4242)
    paintCardBack(new Painter(cimg, 0, 0, CARD.texW, CARD.texH))
  })
  CARD_DEFS.forEach((def, i) => {
    jobs.push(() => {
      srand(def.tile * 131 + 7)
      const x = (def.tile % CARD_COLS) * CARD.texW, y = Math.floor(def.tile / CARD_COLS) * CARD.texH
      post.push(paintCardFace(new Painter(cimg, x, y, CARD.texW, CARD.texH), i, cctx))
    })
  })

  let next = 0
  const tex: Textures = {
    prop, cards, blob, ready: false,
    bake(budgetMs: number) {
      if (tex.ready) return true
      const t0 = performance.now()
      let propDirty = false, cardDirty = false
      while (next < jobs.length && performance.now() - t0 < budgetMs) {
        if (next < PROP_JOBS.length) propDirty = true; else cardDirty = true
        jobs[next++]()
      }
      if (propDirty) { pctx.putImageData(pimg, 0, 0); prop.needsUpdate = true }
      if (cardDirty) {
        cctx.putImageData(cimg, 0, 0)
        for (const f of post) f()
        cards.needsUpdate = true
      }
      if (next >= jobs.length) tex.ready = true
      return tex.ready
    },
  }
  return tex
}
