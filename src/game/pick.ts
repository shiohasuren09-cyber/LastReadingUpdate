// Forgiving screen-space picking.
//
// Raycasting a 0.07m card edge from 1.4m away is a pixel-hunt, so instead every
// valid target is projected to CSS pixels each frame and the pointer picks the
// nearest one within a radius (28px mouse / 40px touch). The invisible proxies
// still exist: they let a pointer that lands *on* a target's body win over a
// nearer-by-centre neighbour, and they are auto-grown so no target's projected
// rect is smaller than 48×48 CSS px.
import * as THREE from 'three'
import { PICK } from './config'
import type { Target } from './scene'
import type { Rig } from './rig'

const v = new THREE.Vector3()
const box = new THREE.Box3()
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()

export interface Projected {
  target: Target
  /** Centre in CSS px relative to the canvas. */
  x: number
  y: number
  /** Projected half-extents in CSS px. */
  hw: number
  hh: number
  behind: boolean
}

/** Projects a world point to CSS px within the canvas rect. Returns depth sign. */
function project(rig: Rig, p: THREE.Vector3, cssW: number, cssH: number, out: { x: number; y: number }) {
  v.copy(p).project(rig.camera)
  out.x = (v.x * 0.5 + 0.5) * cssW
  out.y = (-v.y * 0.5 + 0.5) * cssH
  return v.z
}

export class Picker {
  projected: Projected[] = []
  hover: Target | null = null
  private cssW = 1
  private cssH = 1
  private tmp = { x: 0, y: 0 }

  constructor(private rig: Rig, private targets: Target[]) {
    for (const t of targets) this.projected.push({ target: t, x: 0, y: 0, hw: 0, hh: 0, behind: true })
  }

  /** Canvas size in CSS px — the unit every radius in this file is expressed in. */
  private measure() {
    const r = this.rig.canvas.getBoundingClientRect()
    this.cssW = r.width || 1
    this.cssH = r.height || 1
    return r
  }

  /**
   * Re-projects every target and grows the `grow` proxies so their projected
   * rect clears PICK.minProxySize. Call once per frame before picking.
   */
  update() {
    this.measure()
    const cam = this.rig.camera
    cam.updateMatrixWorld()
    for (const pr of this.projected) {
      const t = pr.target
      const z = project(this.rig, t.anchor, this.cssW, this.cssH, this.tmp)
      pr.x = this.tmp.x
      pr.y = this.tmp.y
      pr.behind = z > 1 || z < -1
      if (!t.valid || pr.behind) { pr.hw = pr.hh = 0; continue }

      // Projected rect of the proxy's world AABB, measured at base scale so the
      // growth factor is recomputed from scratch instead of compounding.
      if (t.grow) t.proxy.scale.setScalar(1)
      t.proxy.updateMatrixWorld()
      box.setFromObject(t.proxy)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
        project(this.rig, v, this.cssW, this.cssH, this.tmp)
        minX = Math.min(minX, this.tmp.x); maxX = Math.max(maxX, this.tmp.x)
        minY = Math.min(minY, this.tmp.y); maxY = Math.max(maxY, this.tmp.y)
      }
      let w = maxX - minX, h = maxY - minY
      if (t.grow && w > 0.01 && h > 0.01) {
        const k = Math.min(Math.max(PICK.minProxySize / w, PICK.minProxySize / h, 1), 4)
        if (k > 1) {
          t.proxy.scale.setScalar(k)
          t.proxy.updateMatrixWorld()
          w *= k; h *= k
        }
      }
      pr.hw = w / 2
      pr.hh = h / 2
    }
  }

  /**
   * Nearest valid target to a client point, or null. A pointer inside a
   * target's projected rect (or hitting its proxy) wins outright; otherwise
   * the nearest centre within `radius` CSS px wins.
   */
  pick(clientX: number, clientY: number, touch: boolean): Target | null {
    const r = this.measure()
    const x = clientX - r.left, y = clientY - r.top
    const radius = touch ? PICK.touchRadiusPx : PICK.mouseRadiusPx

    let best: Target | null = null
    let bestD = Infinity
    let inside: Target | null = null
    let insideD = Infinity

    for (const pr of this.projected) {
      if (!pr.target.valid || pr.behind) continue
      const dx = x - pr.x, dy = y - pr.y
      const d = Math.hypot(dx, dy)
      if (Math.abs(dx) <= pr.hw && Math.abs(dy) <= pr.hh) {
        if (d < insideD) { insideD = d; inside = pr.target }
      }
      if (d <= radius && d < bestD) { bestD = d; best = pr.target }
    }
    if (inside) return inside

    // A ray hit still counts even when the centre is far away (grazing angles
    // make the near half of the table project very wide and very flat).
    if (!best && Math.abs(x / this.cssW * 2 - 1) <= 1) {
      ndc.set((x / this.cssW) * 2 - 1, -(y / this.cssH) * 2 + 1)
      raycaster.setFromCamera(ndc, this.rig.camera)
      let nearest = Infinity
      for (const t of this.targets) {
        if (!t.valid) continue
        const hit = raycaster.intersectObject(t.proxy, false)[0]
        if (hit && hit.distance < nearest) { nearest = hit.distance; best = t }
      }
    }
    return best
  }

  /** Mouse-only hover; returns true when it changed. */
  setHover(t: Target | null) {
    if (this.hover === t) return false
    this.hover = t
    return true
  }
}
