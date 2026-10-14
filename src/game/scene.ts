// World assembly: room, table, captives, lamp rig and every gameplay prop.
// Static decor is merged per material; gameplay objects stay separate so they
// can move, be raycast, and be drawn into the rim mask (layer 1).
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CARD, CARD_DEFS, LIGHT_UNIT, LIGHTS, TABLE, DEG, MAX_DECK } from './config'
import { atlasBasic, atlasLambert, pinUv, scaleUv, setTile } from './materials'
import { T, cardRect, tileRect, type Textures } from './textures'

export const LAYER_RIM = 1
export const LAYER_FOCUS = 2
export const LAYER_HOVER = 3

const up = (_x: number, y: number) => y > 0.5
const down = (_x: number, y: number) => y < -0.5
const side = (_x: number, y: number) => Math.abs(y) < 0.5

/** Non-indexed copy with tile stamped and transform baked. */
function part(geo: THREE.BufferGeometry, tile: T, m?: THREE.Matrix4, uvScale?: [number, number]) {
  let g = geo.index ? geo.toNonIndexed() : geo
  geo.dispose()
  if (uvScale) scaleUv(g, uvScale[0], uvScale[1])
  setTile(g, tileRect(tile))
  if (m) g.applyMatrix4(m)
  g = g as THREE.BufferGeometry
  return g
}
function retile(g: THREE.BufferGeometry, tile: T, filter: (x: number, y: number, z: number) => boolean) {
  return setTile(g, tileRect(tile), filter)
}
function invert(g: THREE.BufferGeometry) {
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, tr = g.attributes.tileRect
  for (let i = 0; i < pos.count; i += 3) {
    for (const a of [pos, nor, uv, tr]) {
      if (!a) continue
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.getComponent(i + 1, k)
        a.setComponent(i + 1, k, a.getComponent(i + 2, k))
        a.setComponent(i + 2, k, t)
      }
    }
  }
  for (let i = 0; i < nor.count; i++) nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i))
  return g
}
const M = new THREE.Matrix4()
const Q = new THREE.Quaternion()
const E = new THREE.Euler()
const S = new THREE.Vector3()
const P = new THREE.Vector3()
function tr(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return M.compose(P.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz)).clone()
}
function box(w: number, h: number, d: number) { return new THREE.BoxGeometry(w, h, d) }
function cyl(rt: number, rb: number, h: number, seg: number, open = false) { return new THREE.CylinderGeometry(rt, rb, h, seg, 1, open) }

export interface CardObj {
  def: number // index into CARD_DEFS (-1 = back only)
  group: THREE.Group
  mesh: THREE.Mesh
  geo: THREE.BufferGeometry
}

export interface World {
  scene: THREE.Scene
  lamp: THREE.Group
  lampLight: THREE.SpotLight
  lampTarget: THREE.Object3D
  bulb: THREE.Mesh
  deckHit: THREE.Mesh
  myMat: THREE.Mesh
  farMat: THREE.Mesh
  /** Soft glow discs under deck / mats (turn cues). */
  deckGlow: THREE.Mesh
  myMatGlow: THREE.Mesh
  farMatGlow: THREE.Mesh
  /** Reader's gloved pointing hand (turn cue). */
  pointHand: THREE.Group
  beam: THREE.Group
  panNear: THREE.Group
  panFar: THREE.Group
  rack: THREE.Mesh
  beadMeshes: THREE.InstancedMesh[]  // [gold, black, white]
  /** Iron door pivot — rotate .y to swing open. */
  doorPivot: THREE.Group
  /** Pale light behind the door, intensity 0 until it opens. */
  doorLight: THREE.DirectionalLight
  /** Floor plank under my chair that drops on a match loss. */
  trapdoor: THREE.Mesh
  /** Right-wall round-marker flames: [round1, round2, round3]. */
  roundFlames: THREE.Mesh[]
  /** Smoke wisps for lost rounds. */
  smokeWisps: THREE.Mesh[]
  dust: THREE.InstancedMesh
  captiveHead: THREE.Group
  captiveHand: THREE.Group
  readerHead: THREE.Mesh
  flames: THREE.Mesh[]
  blobs: THREE.Mesh[]
  cards: CardObj[]
  /** Assign the card's face tile. Call only at the flip midpoint — never before. */
  setCardFace(c: CardObj, def: number): void
  targets: Target[]
  rimObjects: THREE.Object3D[]
}

export type TargetId =
  | 'deck' | 'mat_me' | 'mat_her'
  | 'help_scale' | 'help_beads' | 'help_candles' | 'help_door' | 'help_trap'
export interface Target {
  id: TargetId
  anchor: THREE.Vector3
  proxy: THREE.Mesh
  grow: boolean
  rim: THREE.Object3D
  valid: boolean
}

export function buildWorld(tex: Textures): World {
  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(LIGHTS.fog.color, LIGHTS.fog.near, LIGHTS.fog.far)

  const lit = atlasLambert(tex.prop, 0, 'prop')
  const lift = atlasLambert(tex.prop, 0.25, 'prop')
  const cardMat = atlasLambert(tex.cards, 0.25, 'card')
  const glow = atlasBasic(tex.prop, 'glow')

  // ── static decor (one merged mesh) ──
  const decor: THREE.BufferGeometry[] = []
  const R = 3.3, H = 3.0
  decor.push(part(new THREE.CircleGeometry(R, 20), T.FLOOR, tr(0, 0, 0, -Math.PI / 2), [7, 7]))
  decor.push(part(new THREE.CircleGeometry(R, 20), T.CEILING, tr(0, H, 0, Math.PI / 2), [5, 5]))
  decor.push(invert(part(cyl(R, R, H, 20, true), T.WALL, tr(0, H / 2, 0), [10, 2.5])))
  // curtain folds behind the captive
  for (let i = 0; i < 9; i++) {
    const a = (-0.42 + i * 0.105) + Math.PI / 2
    const x = Math.cos(a) * (R - 0.25), z = -Math.sin(a) * (R - 0.25)
    decor.push(part(box(0.36, 2.7, 0.06), T.CURTAIN, tr(x, 1.4, z, 0, a - Math.PI / 2, 0), [1, 3]))
  }
  // bookshelf on the left, wheel of fortune on the right
  const shelf = part(box(1.2, 1.6, 0.35), T.OAK_DARK, tr(-2.75, 0.8, -1.2, 0, Math.PI / 2 - 0.41, 0))
  decor.push(shelf)
  const books = part(new THREE.PlaneGeometry(1.1, 1.5), T.BOOKS, tr(-2.585, 0.82, -1.128, 0, Math.PI / 2 - 0.41, 0), [1, 2])
  decor.push(books)
  decor.push(part(new THREE.PlaneGeometry(0.9, 0.9), T.WHEEL, tr(1.95, 1.85, -2.5, 0, -0.65, 0)))
  // table: top, apron, pedestal, feet
  const top = part(cyl(TABLE.radius, TABLE.radius, 0.05, 28), T.OAK_TOP, tr(0, TABLE.topY - 0.025, 0), [3, 3])
  decor.push(top)
  decor.push(part(cyl(TABLE.radius - 0.04, TABLE.radius - 0.1, 0.07, 28, true), T.OAK_DARK, tr(0, TABLE.topY - 0.085, 0), [10, 1]))
  decor.push(part(cyl(0.12, 0.16, 0.66, 8), T.OAK_DARK, tr(0, 0.36, 0)))
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4
    decor.push(part(box(0.12, 0.06, 0.6), T.OAK_DARK, tr(Math.cos(a) * 0.3, 0.03, Math.sin(a) * 0.3, 0, -a + Math.PI / 2, 0)))
  }
  // captive's chair
  decor.push(part(box(0.56, 1.2, 0.06), T.OAK_DARK, tr(0, 1.0, -1.58)))
  decor.push(part(box(0.06, 1.4, 0.06), T.OAK_DARK, tr(-0.3, 0.9, -1.58)))
  decor.push(part(box(0.06, 1.4, 0.06), T.OAK_DARK, tr(0.3, 0.9, -1.58)))
  // captive body
  decor.push(part(box(0.44, 0.52, 0.26), T.ROBE_CAPTIVE, tr(0, 0.98, -1.38, 0.1, 0, 0)))
  decor.push(part(box(0.52, 0.1, 0.24), T.ROBE_CAPTIVE, tr(0, 1.22, -1.38, 0.1, 0, 0)))
  decor.push(part(box(0.1, 0.1, 0.12), T.SKIN, tr(0, 1.3, -1.4)))
  for (const sx of [-1, 1]) {
    decor.push(part(box(0.1, 0.3, 0.1), T.ROBE_CAPTIVE, tr(sx * 0.26, 1.05, -1.33, 0.35, 0, sx * 0.08)))
    decor.push(part(box(0.09, 0.08, 0.3), T.ROBE_CAPTIVE, tr(sx * 0.22, 0.83, -1.12, 0, sx * 0.18, 0)))
  }
  // my own shackled hands at the table edge, and the chain between them
  for (const sx of [-1, 1]) {
    decor.push(part(box(0.09, 0.06, 0.22), T.ROBE_CAPTIVE, tr(sx * 0.24, 0.8, 1.2, 0, -sx * 0.25, 0)))
    decor.push(part(box(0.08, 0.04, 0.09), T.SKIN, tr(sx * 0.2, 0.79, 1.06, 0, -sx * 0.25, 0)))
    decor.push(part(box(0.1, 0.07, 0.04), T.IRON, tr(sx * 0.215, 0.8, 1.12, 0, -sx * 0.25, 0)))
    decor.push(part(box(0.1, 0.07, 0.04), T.IRON, tr(sx * 0.205, 0.8, -1.02, 0, sx * 0.18, 0)))
  }
  decor.push(part(box(0.32, 0.012, 0.02), T.CHAIN, tr(0, 0.775, 1.1, 0, 0, 0), [3, 1]))
  decor.push(part(box(0.32, 0.012, 0.02), T.CHAIN, tr(0, 0.775, -1.0), [3, 1]))
  // the Reader: a robed figure standing at the far right
  decor.push(part(cyl(0.12, 0.34, 1.55, 7), T.ROBE_READER, tr(1.55, 0.78, -1.55), [2, 1]))
  decor.push(part(new THREE.ConeGeometry(0.17, 0.36, 7), T.ROBE_READER, tr(1.55, 1.72, -1.55)))
  for (const sx of [-1, 1]) decor.push(part(box(0.08, 0.5, 0.08), T.ROBE_READER, tr(1.55 + sx * 0.2, 1.2, -1.5, 0.3, 0, sx * 0.2)))
  // candles on the table rim
  const candles: [number, number, number][] = [[0.82, 0.08, 0.3], [0.9, 0.12, -0.12], [-0.62, 0.1, -0.7]]
  for (const [x, h, z] of candles) {
    decor.push(part(cyl(0.022, 0.025, h, 6), T.WAX, tr(x, TABLE.topY + h / 2, z)))
    decor.push(part(cyl(0.05, 0.05, 0.01, 8), T.BRASS, tr(x, TABLE.topY + 0.005, z)))
  }
  // round-marker sconces: three wall candles on the right wall (x ≈ +2.9),
  // brass brackets with wax pillars; the flames live in `roundFlames`.
  const sconceX = 2.95, sconceBase = [1.95, 1.45, 0.95]
  for (const sy of sconceBase) {
    decor.push(part(box(0.1, 0.02, 0.06), T.BRASS, tr(sconceX - 0.05, sy - 0.02, -0.1)))
    decor.push(part(cyl(0.02, 0.024, 0.1, 6), T.WAX, tr(sconceX - 0.14, sy + 0.06, -0.1, 0, 0, Math.PI / 2)))
  }
  // iron door in the right wall, hinged on its z- edge
  const door = new THREE.Group()
  door.position.set(2.97, 1.05, -1.9)
  const doorMesh = new THREE.Mesh(part(box(0.06, 2.1, 1.0), T.IRON, tr(0, 0, 0.5), [1, 2]), lit)
  doorMesh.castShadow = true
  door.add(doorMesh)
  const doorPivot = new THREE.Group()
  doorPivot.position.set(2.97, 1.05, -1.9)
  doorPivot.rotation.y = 0
  scene.add(doorPivot)
  doorPivot.add(door)
  // pale light behind the closed door
  const doorLight = new THREE.DirectionalLight('#f4ead2', 0)
  doorLight.position.set(4.5, 1.4, -1.9)
  scene.add(doorLight)
  // trapdoor under my chair (a floor plank that drops)
  const trapdoor = new THREE.Mesh(part(box(0.6, 0.05, 0.6), T.OAK_DARK, tr(0, 0, 0), [2, 2]), lit)
  trapdoor.position.set(0, 0.025, 1.9)
  scene.add(trapdoor)
  // lamp chain to the ceiling is part of the lamp group (it swings)
  const decorMesh = new THREE.Mesh(mergeGeometries(decor)!, lit)
  decorMesh.receiveShadow = true
  decorMesh.castShadow = true
  decorMesh.matrixAutoUpdate = false
  scene.add(decorMesh)

  // Reader's mask (separate so it can glint)
  const readerHead = new THREE.Mesh(
    part(box(0.18, 0.22, 0.16), T.READER_FACE, tr(0, 0, 0)),
    lit,
  )
  retile(readerHead.geometry, T.ROBE_READER, (x, y, z) => z < 0.5)
  readerHead.position.set(1.55, 1.62, -1.5)
  readerHead.rotation.y = -0.46
  scene.add(readerHead)

  // captive's head (turns to follow the play)
  const captiveHead = new THREE.Group()
  captiveHead.position.set(0, 1.46, -1.4)
  const headGeo = part(box(0.2, 0.24, 0.2), T.FACE, tr(0, 0, 0))
  retile(headGeo, T.HAIR, (x, y, z) => z < 0.5)
  captiveHead.add(new THREE.Mesh(headGeo, lit))
  const hairGeo = part(box(0.23, 0.08, 0.22), T.HAIR, tr(0, 0.12, -0.01))
  captiveHead.add(new THREE.Mesh(hairGeo, lit))
  captiveHead.children.forEach((c) => (c.castShadow = true))
  scene.add(captiveHead)

  // captive's reaching hand (moves when she plays)
  const captiveHand = new THREE.Group()
  captiveHand.add(new THREE.Mesh(part(box(0.08, 0.04, 0.09), T.SKIN, tr(0, 0, 0)), lit))
  captiveHand.position.set(0.2, 0.79, -0.98)
  captiveHand.children[0].castShadow = true
  scene.add(captiveHand)

  // ── lamp ──
  const lamp = new THREE.Group()
  lamp.position.set(0, 2.98, 0) // pivot at the ceiling hook
  const lampParts: THREE.BufferGeometry[] = []
  lampParts.push(part(box(0.012, 0.66, 0.012), T.CHAIN, tr(0, -0.33, 0), [1, 5]))
  const shade = part(cyl(0.06, 0.2, 0.16, 8, true), T.BRASS, tr(0, -0.74, 0))
  lampParts.push(shade, invert(part(cyl(0.06, 0.2, 0.16, 8, true), T.IRON, tr(0, -0.74, 0))))
  lampParts.push(part(cyl(0.065, 0.065, 0.03, 8), T.BRASS, tr(0, -0.66, 0)))
  const lampMesh = new THREE.Mesh(mergeGeometries(lampParts)!, lit)
  lamp.add(lampMesh)
  const bulb = new THREE.Mesh(part(new THREE.SphereGeometry(0.05, 8, 4), T.GLASS, tr(0, -0.81, 0)), glow)
  lamp.add(bulb)
  const lampLight = new THREE.SpotLight(LIGHTS.lamp.color, LIGHTS.lamp.intensity * LIGHT_UNIT, 0, (LIGHTS.lamp.coneDeg / 2) * DEG, LIGHTS.lamp.penumbra, 0)
  lampLight.position.set(0, -0.78, 0)
  lampLight.shadow.bias = -0.0015
  lampLight.shadow.normalBias = 0.01
  lampLight.shadow.camera.near = 0.3
  lampLight.shadow.camera.far = 3
  lamp.add(lampLight)
  const lampTarget = new THREE.Object3D()
  lampTarget.position.set(0, -3, 0)
  lamp.add(lampTarget)
  lampLight.target = lampTarget
  scene.add(lamp)

  scene.add(new THREE.AmbientLight(LIGHTS.ambient.color, LIGHTS.ambient.intensity * LIGHT_UNIT))
  const fill = new THREE.DirectionalLight(LIGHTS.fill.color, LIGHTS.fill.intensity * LIGHT_UNIT)
  fill.position.set(-3, 2.2, 0.6)
  scene.add(fill)
  const kick = new THREE.DirectionalLight(LIGHTS.kicker.color, LIGHTS.kicker.intensity * LIGHT_UNIT)
  kick.position.set(3, 1.6, -1.2)
  scene.add(kick)

  // candle flames (unlit glow)
  const flames: THREE.Mesh[] = []
  const flameGeo = part(new THREE.ConeGeometry(0.012, 0.035, 5), T.FLAME, tr(0, 0, 0))
  for (const [x, h, z] of candles) {
    const f = new THREE.Mesh(flameGeo, glow)
    f.position.set(x, TABLE.topY + h + 0.02, z)
    scene.add(f)
    flames.push(f)
  }

  // round-marker flames on the right-wall sconces
  const roundFlames: THREE.Mesh[] = []
  for (const sy of sconceBase) {
    const f = new THREE.Mesh(flameGeo, glow)
    f.position.set(sconceX - 0.22, sy + 0.06, -0.1)
    f.visible = false
    scene.add(f)
    roundFlames.push(f)
  }
  // smoke wisps for lost rounds: small bone-grey puffs above dead sconces
  const smokeWisps: THREE.Mesh[] = []
  for (const sy of sconceBase) {
    const w = new THREE.Mesh(part(new THREE.ConeGeometry(0.008, 0.05, 4), T.GLASS, tr(0, 0, 0)), glow)
    w.position.set(sconceX - 0.22, sy + 0.14, -0.1)
    w.visible = false
    scene.add(w)
    smokeWisps.push(w)
  }

  // ── gameplay props (lifted, rimmed) ──
  const rimObjects: THREE.Object3D[] = []
  const mark = (o: THREE.Object3D) => { o.traverse((c) => c.layers.enable(LAYER_RIM)); rimObjects.push(o); return o }
  mark(trapdoor)
  mark(doorPivot)

  // Mats: indigo (near/mine) and crimson (far/rival's), each with a distinct emblem.
  const matGeo = (tile: T) => {
    const g = part(box(TABLE.matW, 0.006, TABLE.matD), tile, tr(0, 0.003, 0))
    pinUv(g, 0.05, 0.05, side)
    return g
  }
  const myMat = new THREE.Mesh(matGeo(T.VELVET_VIO), lift)
  myMat.position.set(TABLE.myMat[0], TABLE.myMat[1] - 0.008, TABLE.myMat[2])
  myMat.receiveShadow = true
  myMat.userData.target = 'me'
  scene.add(mark(myMat))
  const farMat = new THREE.Mesh(matGeo(T.VELVET_WINE), lift)
  farMat.position.set(TABLE.farMat[0], TABLE.farMat[1] - 0.008, TABLE.farMat[2])
  farMat.receiveShadow = true
  farMat.userData.target = 'her'
  scene.add(mark(farMat))

  // Soft glow discs under deck / mats (turn cues). Unlit so they read through the dither.
  const glowDisc = (r: number, color: string) => {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(r, 16),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }),
    )
    m.rotation.x = -Math.PI / 2
    m.visible = false
    scene.add(m)
    return m
  }
  const deckGlow = glowDisc(0.14, '#e8b25a')
  deckGlow.position.set(TABLE.deck[0], TABLE.topY + 0.004, TABLE.deck[2])
  const myMatGlow = glowDisc(0.28, '#e8b25a')
  myMatGlow.position.set(TABLE.myMat[0], TABLE.topY + 0.004, TABLE.myMat[2])
  const farMatGlow = glowDisc(0.28, '#c4625e')
  farMatGlow.position.set(TABLE.farMat[0], TABLE.topY + 0.004, TABLE.farMat[2])

  // Reader's gloved pointing hand — floats above the cue target.
  const pointHand = new THREE.Group()
  const glove = new THREE.Mesh(part(box(0.06, 0.035, 0.1), T.ROBE_READER, tr(0, 0, 0)), lift)
  const finger = new THREE.Mesh(part(box(0.02, 0.02, 0.07), T.SKIN, tr(0, -0.01, 0.07)), lift)
  pointHand.add(glove, finger)
  pointHand.position.set(TABLE.deck[0], 1.05, TABLE.deck[2])
  pointHand.visible = false
  scene.add(pointHand)

  // deck dais (stone, hexagonal) — also the deck's hit target
  const daisGeo = part(cyl(0.075, 0.085, 0.03, 6), T.STONE, tr(0, 0.015, 0))
  const deckHit = new THREE.Mesh(daisGeo, lift)
  deckHit.position.set(TABLE.deck[0], TABLE.deck[1] - 0.01, TABLE.deck[2])
  deckHit.castShadow = deckHit.receiveShadow = true
  scene.add(mark(deckHit))

  // ── invisible hit proxies ──
  // Never rendered (material.visible = false) and never on a rim layer, so they
  // stay out of both the colour pass and the mask pass.
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false })
  const mkProxy = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, proxyMat)
    m.position.set(x, y, z)
    scene.add(m)
    return m
  }
  // The deck proxy is grown at runtime until its projected rect clears 48 CSS px.
  const deckProxy = mkProxy(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 8), TABLE.deck[0], TABLE.deck[1] + 0.04, TABLE.deck[2])
  // Each mat owns a whole half of the tabletop: near half is yours, far is hers.
  const halfDisc = (near: boolean) =>
    new THREE.CylinderGeometry(TABLE.radius, TABLE.radius, 0.12, 16, 1, false, near ? -Math.PI / 2 : Math.PI / 2, Math.PI)
  const myMatProxy = mkProxy(halfDisc(true), 0, TABLE.topY + 0.05, 0)
  const farMatProxy = mkProxy(halfDisc(false), 0, TABLE.topY + 0.05, 0)
  // Help-object proxies (scale, rack, candles, door, trapdoor)
  const helpScaleProxy = mkProxy(new THREE.BoxGeometry(0.2, 0.35, 0.2), TABLE.scale[0], TABLE.scale[1] + 0.2, TABLE.scale[2])
  const helpBeadsProxy = mkProxy(new THREE.BoxGeometry(0.28, 0.12, 0.28), TABLE.rack[0], TABLE.rack[1] + 0.06, TABLE.rack[2])
  const helpCandlesProxy = mkProxy(new THREE.BoxGeometry(0.25, 1.2, 0.2), 2.85, 1.5, -0.1)
  const helpDoorProxy = mkProxy(new THREE.BoxGeometry(0.2, 2.0, 1.0), 2.9, 1.05, -1.4)
  const helpTrapProxy = mkProxy(new THREE.BoxGeometry(0.6, 0.1, 0.6), 0, 0.05, 1.9)

  // brass balance scale
  const scaleParts: THREE.BufferGeometry[] = []
  scaleParts.push(part(cyl(0.06, 0.07, 0.025, 8), T.BRASS, tr(0, 0.0125, 0)))
  scaleParts.push(part(cyl(0.008, 0.012, 0.26, 6), T.BRASS, tr(0, 0.15, 0)))
  scaleParts.push(part(new THREE.ConeGeometry(0.018, 0.04, 6), T.BRASS, tr(0, 0.3, 0)))
  const scaleBase = new THREE.Mesh(mergeGeometries(scaleParts)!, lift)
  scaleBase.position.set(TABLE.scale[0], TABLE.scale[1] - 0.01, TABLE.scale[2])
  scaleBase.castShadow = true
  scene.add(mark(scaleBase))
  const beam = new THREE.Group()
  beam.position.set(TABLE.scale[0], TABLE.scale[1] + 0.27, TABLE.scale[2])
  const beamMesh = new THREE.Mesh(mergeGeometries([
    part(box(0.012, 0.012, 0.32), T.BRASS, tr(0, 0, 0)),
    part(new THREE.ConeGeometry(0.012, 0.05, 4), T.BRASS, tr(0, 0.035, 0)),
    part(new THREE.SphereGeometry(0.012, 6, 3), T.BRASS, tr(0, 0, 0.16)),
    part(new THREE.SphereGeometry(0.012, 6, 3), T.BRASS, tr(0, 0, -0.16)),
  ])!, lift)
  beamMesh.castShadow = true
  beam.add(beamMesh)
  scene.add(mark(beam))
  const panGeo = mergeGeometries([
    part(cyl(0.06, 0.04, 0.02, 10), T.BRASS, tr(0, -0.12, 0)),
    part(box(0.003, 0.12, 0.003), T.CORD, tr(0.035, -0.06, 0, 0, 0, 0.28)),
    part(box(0.003, 0.12, 0.003), T.CORD, tr(-0.035, -0.06, 0, 0, 0, -0.28)),
  ])!
  const mkPan = () => {
    const g = new THREE.Group()
    const m = new THREE.Mesh(panGeo, lift)
    m.castShadow = true
    g.add(m)
    scene.add(mark(g))
    return g
  }
  const panNear = mkPan(), panFar = mkPan()

  // bead rack: 3 rails (gold, black, white) — one bead slides away per card taken.
  const rackParts: THREE.BufferGeometry[] = []
  rackParts.push(part(box(0.26, 0.022, 0.24), T.WOOD_PALE, tr(0, 0.011, 0)))
  const railZ = [-0.07, 0, 0.07]
  for (const z of railZ) {
    rackParts.push(part(box(0.22, 0.005, 0.005), T.BRASS, tr(0, 0.044, z)))
    for (const x of [-0.1, 0.1]) rackParts.push(part(box(0.014, 0.048, 0.014), T.WOOD_PALE, tr(x, 0.035, z)))
  }
  const rack = new THREE.Mesh(mergeGeometries(rackParts)!, lift)
  rack.position.set(TABLE.rack[0], TABLE.rack[1] - 0.01, TABLE.rack[2])
  rack.castShadow = rack.receiveShadow = true
  scene.add(mark(rack))

  // Beads on the rails: MAX_DECK per rail × 3 rails. Rail 0 = gold, 1 = black, 2 = white.
  // The game hides the rightmost bead on each rail when a card is drawn.
  const beadGeoBase = new THREE.IcosahedronGeometry(0.014, 0)
  const beadMats = [
    atlasLambert(tex.prop, 0.35, 'bead-gold'),
    atlasLambert(tex.prop, 0.25, 'bead-black'),
    atlasLambert(tex.prop, 0.20, 'bead-white'),
  ]
  const beadTiles = [T.COIN_GOLD, T.COIN_BLACK, T.BEAD]
  const beadMeshes: THREE.InstancedMesh[] = []
  for (let rail = 0; rail < 3; rail++) {
    setTile(beadGeoBase, tileRect(beadTiles[rail]))
    const im = new THREE.InstancedMesh(beadGeoBase.clone(), beadMats[rail], MAX_DECK)
    im.castShadow = true
    im.frustumCulled = false
    for (let i = 0; i < MAX_DECK; i++) {
      const bx = -0.094 + i * (0.188 / (MAX_DECK - 1))
      P.set(TABLE.rack[0] + bx, TABLE.rack[1] + 0.044, TABLE.rack[2] + railZ[rail])
      M.compose(P, Q.set(0, 0, 0, 1), S.set(1, 1, 1))
      im.setMatrixAt(i, M)
    }
    im.instanceMatrix.needsUpdate = true
    scene.add(mark(im))
    beadMeshes.push(im)
  }

  // dust in the lamp cone
  const dustMat = new THREE.MeshBasicMaterial({ color: '#c2b292', fog: true })
  const dust = new THREE.InstancedMesh(new THREE.BoxGeometry(0.006, 0.006, 0.006), dustMat, 36)
  dust.count = 36
  dust.frustumCulled = false
  scene.add(dust)

  // baked blob shadows (low tier only)
  const blobMat = new THREE.MeshBasicMaterial({ map: tex.blob, transparent: true, depthWrite: false })
  const blobs: THREE.Mesh[] = []
  const blobAt = (x: number, z: number, s: number) => {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(s, s), blobMat)
    b.rotation.x = -Math.PI / 2
    b.position.set(x, TABLE.topY + 0.002, z)
    b.visible = false
    scene.add(b)
    blobs.push(b)
  }
  blobAt(TABLE.deck[0], TABLE.deck[2], 0.26)
  blobAt(TABLE.scale[0], TABLE.scale[2], 0.3)
  blobAt(TABLE.rack[0], TABLE.rack[2], 0.34)
  blobAt(0, -1.0, 0.6)

  // ── cards (pooled) ──
  const cards: CardObj[] = []
  // Every card starts as back-on-both-faces: nothing distinguishes a card
  // until setCardFace runs at the flip midpoint.
  const cardGeoBlank = () => {
    const g = part(box(CARD.w, CARD.t, CARD.d), T.FLOOR, tr(0, 0, 0))
    setTile(g, cardRect(0), up)
    setTile(g, cardRect(0), down)
    setTile(g, cardRect(0), side)
    pinUv(g, 0.5, 0.02, side)
    return g
  }
  for (let i = 0; i < MAX_DECK; i++) {
    const geo = cardGeoBlank()
    const mesh = new THREE.Mesh(geo, cardMat)
    mesh.castShadow = true
    const group = new THREE.Group()
    group.rotation.order = 'YXZ'
    group.add(mesh)
    scene.add(mark(group))
    cards.push({ def: -1, group, mesh, geo })
  }
  const setCardFace = (c: CardObj, def: number) => {
    c.def = def
    setTile(c.geo, cardRect(def < 0 ? 0 : CARD_DEFS[def].tile), up)
    ;(c.geo.attributes.tileRect as THREE.BufferAttribute).needsUpdate = true
  }

  const targets: Target[] = [
    { id: 'deck', anchor: new THREE.Vector3(TABLE.deck[0], TABLE.deck[1] + 0.04, TABLE.deck[2]), proxy: deckProxy, grow: true, rim: deckHit, valid: false },
    { id: 'mat_me', anchor: new THREE.Vector3(TABLE.myMat[0], TABLE.myMat[1], TABLE.myMat[2]), proxy: myMatProxy, grow: false, rim: myMat, valid: false },
    { id: 'mat_her', anchor: new THREE.Vector3(TABLE.farMat[0], TABLE.farMat[1], TABLE.farMat[2]), proxy: farMatProxy, grow: false, rim: farMat, valid: false },
    { id: 'help_scale', anchor: new THREE.Vector3(TABLE.scale[0], TABLE.scale[1] + 0.2, TABLE.scale[2]), proxy: helpScaleProxy, grow: true, rim: scaleBase, valid: false },
    { id: 'help_beads', anchor: new THREE.Vector3(TABLE.rack[0], TABLE.rack[1] + 0.06, TABLE.rack[2]), proxy: helpBeadsProxy, grow: true, rim: rack, valid: false },
    { id: 'help_candles', anchor: new THREE.Vector3(2.85, 1.5, -0.1), proxy: helpCandlesProxy, grow: true, rim: roundFlames[0] ?? scaleBase, valid: false },
    { id: 'help_door', anchor: new THREE.Vector3(2.9, 1.05, -1.4), proxy: helpDoorProxy, grow: true, rim: doorPivot, valid: false },
    { id: 'help_trap', anchor: new THREE.Vector3(0, 0.05, 1.9), proxy: helpTrapProxy, grow: true, rim: trapdoor, valid: false },
  ]

  return {
    scene, lamp, lampLight, lampTarget, bulb, deckHit, myMat, farMat,
    deckGlow, myMatGlow, farMatGlow, pointHand,
    beam, panNear, panFar, rack, beadMeshes,
    doorPivot, doorLight, trapdoor, roundFlames, smokeWisps,
    dust, captiveHead, captiveHand, readerHead, flames, blobs, cards,
    setCardFace, targets, rimObjects,
  }
}
