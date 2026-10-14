// All tunables for LAST READING live here.

export const DEG = Math.PI / 180

// Render tiers: low-res target, independent of devicePixelRatio.
export type Tier = 'high' | 'medium' | 'low'
export const TIERS: Record<Tier, { w: number; h: number; shadow: number }> = {
  high: { w: 480, h: 270, shadow: 512 },
  medium: { w: 400, h: 225, shadow: 256 },
  low: { w: 320, h: 180, shadow: 0 }, // 0 = baked blob shadows, no shadow map
}
export const PERF = {
  windowSec: 2,
  slowFrameMs: 20,
  idleSec: 10, // after this long without input/animation, cap to 30fps
  activeFps: 60,
  idleFps: 30,
  bakeBudgetMs: 8,
}

// Seated first-person camera.
export const CAMERA = {
  pos: [0, 1.15, 1.45] as const,
  baseFov: 50, // vertical FOV
  minHalfHFov: 35, // horizontal FOV stays at least 70° (35° half-angle)
  maxFov: 84,
  yawLimit: 90 * DEG,
  pitchMin: -30 * DEG,
  pitchMax: 20 * DEG,
  restPitch: -14 * DEG,
  damping: 0.12, // per frame at 60fps
  dragDegPerPxDefault: 0.15,
  dragDegPerPxMin: 0.05,
  dragDegPerPxMax: 0.30,
  keyDegPerSec: 90,
}
export const TAP = { maxMovePx: 10, maxMs: 350 }
export const PICK = {
  mouseRadiusPx: 28,
  touchRadiusPx: 40,
  minProxySize: 48, // CSS px
  ffSpeed: 3,
}

// Light rig. three's physically based lights divide diffuse by PI, so the
// brief's relative strengths are scaled by LIGHT_UNIT to read as written.
export const LIGHT_UNIT = Math.PI * 0.62
export const LIGHTS = {
  ambient: { color: '#f2dcc0', intensity: 0.38 },
  lamp: { color: '#ffcf8a', intensity: 1.6, coneDeg: 70, penumbra: 0.25, swingDeg: 8, swingPeriod: 6 },
  fill: { color: '#9aa2e0', intensity: 0.5 }, // cool, from the left
  kicker: { color: '#ffb070', intensity: 0.4 }, // warm, from the right
  fog: { color: '#2f2440', near: 3.2, far: 8.5 },
  clear: '#2a2028',
}

// Post pass.
export const POST = {
  vignette: 0.12,
  grain: 0.03,
  ditherSpread: 0.085,
  gainMin: 0.8,
  gainMax: 1.4,
  gainDefault: 1.0,
  focusDim: 0.5,
}

// Fixed 40-colour dark warm palette (raised darks, ink #1c1626).
export const PALETTE: string[] = [
  // ink & bruised violet
  '#1c1626', '#261d33', '#2f2440', '#3b2c4f', '#4a3760', '#5d4673', '#735a8a', '#8f78a3',
  // wine red
  '#3a1a24', '#50202e', '#6b2a38', '#8a3442', '#a8474e', '#c4625e',
  // candle amber
  '#4a2c1c', '#6b3f22', '#8f5628', '#b0702e', '#d08f3c', '#e8b25a', '#f5d08a',
  // tarnished gold
  '#5c4a24', '#7d6630', '#a08440', '#c4a858',
  // bone white
  '#6e6250', '#9a8a70', '#c2b292', '#e0d4b4', '#f4ead2',
  // moss green
  '#263224', '#34442c', '#4a5a36', '#66753f', '#8a9450',
  // oak browns & warm grey
  '#3a2a22', '#5a3e2c', '#7a5636', '#9a7044', '#2a2028',
]

// Table layout (world units = metres). No item trays.
export const TABLE = {
  radius: 1.2,
  topY: 0.76,
  surfaceY: 0.77,
  myMat:  [0,     0.77,  0.45] as const,
  farMat: [0,     0.77, -0.45] as const,
  matW: 0.5,
  matD: 0.26,
  deck:  [-0.25, 0.77,  0]    as const,
  scale: [ 0.35, 0.77,  0]    as const,
  rack:  [-0.8,  0.77,  0]    as const,
}

export const CARD = {
  w: 0.09,
  d: 0.15,
  t: 0.002,
  texW: 64,
  texH: 112,
}

export type CardKind = 'boon' | 'bane' | 'blank'
export type Symbol =
  | 'sun' | 'star' | 'hearts' | 'crown' | 'wand'
  | 'tower' | 'skull' | 'horned' | 'hanged' | 'moon'
  | 'cup' | 'rod' | 'sword' | 'coin'
export interface CardDef {
  name: string
  kind: CardKind
  value: 1 | -1 | 0
  symbol: Symbol
  tile: number // index in the card atlas (0 = back)
}

export const CARD_DEFS: CardDef[] = [
  { name: 'THE SUN',        kind: 'boon',  value:  1, symbol: 'sun',    tile:  1 },
  { name: 'THE STAR',       kind: 'boon',  value:  1, symbol: 'star',   tile:  2 },
  { name: 'THE LOVERS',     kind: 'boon',  value:  1, symbol: 'hearts', tile:  3 },
  { name: 'THE EMPRESS',    kind: 'boon',  value:  1, symbol: 'crown',  tile:  4 },
  { name: 'THE MAGICIAN',   kind: 'boon',  value:  1, symbol: 'wand',   tile:  5 },
  { name: 'THE TOWER',      kind: 'bane',  value: -1, symbol: 'tower',  tile:  6 },
  { name: 'DEATH',          kind: 'bane',  value: -1, symbol: 'skull',  tile:  7 },
  { name: 'THE DEVIL',      kind: 'bane',  value: -1, symbol: 'horned', tile:  8 },
  { name: 'THE HANGED MAN', kind: 'bane',  value: -1, symbol: 'hanged', tile:  9 },
  { name: 'THE MOON',       kind: 'bane',  value: -1, symbol: 'moon',   tile: 10 },
  { name: 'ACE OF CUPS',    kind: 'blank', value:  0, symbol: 'cup',    tile: 11 },
  { name: 'ACE OF WANDS',   kind: 'blank', value:  0, symbol: 'rod',    tile: 12 },
  { name: 'ACE OF SWORDS',  kind: 'blank', value:  0, symbol: 'sword',  tile: 13 },
  { name: 'ACE OF COINS',   kind: 'blank', value:  0, symbol: 'coin',   tile: 14 },
]

// Biggest round is 11 cards.
export const MAX_DECK = 11

export const RULES = {
  roundsToWin:      2,
  scaleDegPerPoint: 8,
  scaleClampDeg:    28,
  tensionSec:       0.5,
  panDropSec:       0.9,
  cardSweepSec:     0.7,
  doorOpenSec:      1.6,
  doorHoldSec:      1.6,
  fallBlackSec:     1.2,
  roundEndPause:    0.9,
  // AI timing
  aiThinkMin:       0.6,
  aiThinkMax:       1.2,
  aiThinkRound1Max: 1.6,
  // Watchdog: every non-interactive state must resolve within this many seconds
  // beyond its expected duration.
  watchdogSlack:    1.0,
}

export const HINTS = {
  drawIdleSec:  5,
  placeIdleSec: 5,
}
