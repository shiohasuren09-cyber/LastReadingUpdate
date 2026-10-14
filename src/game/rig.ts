// Render pipeline: low-res scene target → rim/focus/hover mask → post pass to
// the pixelated canvas. Owns tiers, resize, and WebGL context loss recovery.
import * as THREE from 'three'
import { CAMERA, DEG, PERF, TIERS, type Tier } from './config'
import { createPost, type Post } from './post'
import { LAYER_FOCUS, LAYER_HOVER, LAYER_RIM, type World } from './scene'
import type { Textures } from './textures'

const MASK_VERT = `
#include <common>
#include <skinning_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
}`
const MASK_FRAG = `
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`

export class Rig {
  renderer: THREE.WebGLRenderer
  canvas: HTMLCanvasElement
  camera: THREE.PerspectiveCamera
  tier: Tier
  w = 480
  h = 270
  portrait = false
  sceneRT!: THREE.WebGLRenderTarget
  maskRT!: THREE.WebGLRenderTarget
  post: Post
  sub: HTMLCanvasElement
  subCtx: CanvasRenderingContext2D
  subTex: THREE.CanvasTexture
  maskMat: THREE.ShaderMaterial
  lost = false
  onResize: (() => void) | null = null

  constructor(public host: HTMLElement, public world: World, public tex: Textures) {
    this.canvas = document.createElement('canvas')
    const st = this.canvas.style
    st.position = 'absolute'
    st.imageRendering = 'pixelated'
    st.cursor = 'none'
    st.touchAction = 'none'
    host.appendChild(this.canvas)

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', alpha: false })
    this.renderer.setPixelRatio(1)
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.shadowMap.autoUpdate = false

    const nav = navigator as Navigator & { deviceMemory?: number }
    const weak = (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4
    this.tier = weak ? 'medium' : 'high'

    this.camera = new THREE.PerspectiveCamera(CAMERA.baseFov, 16 / 9, 0.05, 12)
    this.camera.position.set(CAMERA.pos[0], CAMERA.pos[1], CAMERA.pos[2])
    this.camera.rotation.order = 'YXZ'

    this.sub = document.createElement('canvas')
    this.subCtx = this.sub.getContext('2d')!
    this.subTex = new THREE.CanvasTexture(this.sub)
    this.subTex.magFilter = this.subTex.minFilter = THREE.NearestFilter
    this.subTex.generateMipmaps = false

    this.post = createPost(this.subTex)
    this.maskMat = new THREE.ShaderMaterial({
      vertexShader: MASK_VERT, fragmentShader: MASK_FRAG,
      uniforms: { uColor: { value: new THREE.Color(1, 0, 0) } },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    })

    this.makeTargets()
    this.applyShadowTier()
    this.resize()

    this.canvas.addEventListener('webglcontextlost', this.onLost, false)
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false)
    window.addEventListener('resize', this.resize)
  }

  private makeTargets() {
    const opts = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false }
    this.sceneRT = new THREE.WebGLRenderTarget(this.w, this.h, { ...opts, type: THREE.HalfFloatType, depthBuffer: true })
    this.maskRT = new THREE.WebGLRenderTarget(this.w, this.h, { ...opts, depthBuffer: false })
    this.post.setTargets(this.sceneRT.texture, this.maskRT.texture, this.w, this.h)
  }

  applyShadowTier() {
    const size = TIERS[this.tier].shadow
    const light = this.world.lampLight
    const on = size > 0
    if (this.renderer.shadowMap.enabled !== on) {
      this.renderer.shadowMap.enabled = on
      this.world.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined
        if (m) m.needsUpdate = true
      })
    }
    light.castShadow = on
    if (on && light.shadow.mapSize.x !== size) {
      light.shadow.mapSize.set(size, size)
      light.shadow.map?.dispose()
      light.shadow.map = null
    }
    for (const b of this.world.blobs) b.visible = !on
  }

  stepDown(): boolean {
    if (this.tier === 'low') return false
    this.tier = this.tier === 'high' ? 'medium' : 'low'
    this.applyShadowTier()
    this.resize()
    return true
  }

  resize = () => {
    const vw = window.innerWidth, vh = window.innerHeight
    this.portrait = vh > vw
    const t = TIERS[this.tier]
    const w = this.portrait ? t.h : t.w, h = this.portrait ? t.w : t.h
    if (w !== this.w || h !== this.h) {
      this.w = w; this.h = h
      this.sceneRT.setSize(w, h)
      this.maskRT.setSize(w, h)
      this.post.setTargets(this.sceneRT.texture, this.maskRT.texture, w, h)
    }
    this.renderer.setSize(w, h, false)
    if (this.sub.width !== w || this.sub.height !== h) {
      this.sub.width = w; this.sub.height = h
      this.subTex.dispose()
      this.subTex.needsUpdate = true
    }
    // Integer fit when it fills most of the screen, otherwise a fractional
    // fit so small phones don't end up with a postage stamp.
    const fit = Math.min(vw / w, vh / h)
    const k = Math.floor(fit) >= 1 && Math.floor(fit) / fit >= 0.8 ? Math.floor(fit) : fit
    const cw = Math.round(w * k), ch = Math.round(h * k)
    const st = this.canvas.style
    st.width = cw + 'px'; st.height = ch + 'px'
    st.left = Math.round((vw - cw) / 2) + 'px'; st.top = Math.round((vh - ch) / 2) + 'px'

    const aspect = w / h
    this.camera.aspect = aspect
    const needV = 2 * Math.atan(Math.tan(CAMERA.minHalfHFov * DEG) / aspect) / DEG
    this.camera.fov = Math.min(CAMERA.maxFov, Math.max(CAMERA.baseFov, needV))
    this.camera.updateProjectionMatrix()
    this.onResize?.()
  }

  /** Converts a client point to NDC; returns false when outside the picture. */
  toNdc(cx: number, cy: number, out: THREE.Vector2) {
    const r = this.canvas.getBoundingClientRect()
    out.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1)
    return Math.abs(out.x) <= 1 && Math.abs(out.y) <= 1
  }
  /** Converts a client point to low-res pixel coordinates. */
  toPx(cx: number, cy: number, out: THREE.Vector2) {
    const r = this.canvas.getBoundingClientRect()
    out.set(((cx - r.left) / r.width) * this.w, ((cy - r.top) / r.height) * this.h)
  }

  render(time: number, focus: number, gain: number, showMask: boolean) {
    if (this.lost) return
    const r = this.renderer, cam = this.camera, scene = this.world.scene
    const u = this.post.material.uniforms
    if (r.shadowMap.enabled) r.shadowMap.needsUpdate = true

    r.setRenderTarget(this.sceneRT)
    cam.layers.set(0)
    r.clear()
    r.render(scene, cam)

    if (showMask) {
      r.shadowMap.needsUpdate = false
      r.setRenderTarget(this.maskRT)
      r.setClearColor(0x000000, 1)
      r.clear()
      scene.overrideMaterial = this.maskMat
      const fog = scene.fog
      scene.fog = null
      const col = this.maskMat.uniforms.uColor.value as THREE.Color
      col.setRGB(1, 0, 0); cam.layers.set(LAYER_RIM); r.render(scene, cam)
      if (focus > 0) { col.setRGB(0, 1, 0); cam.layers.set(LAYER_FOCUS); r.render(scene, cam) }
      col.setRGB(0, 0, 1); cam.layers.set(LAYER_HOVER); r.render(scene, cam)
      scene.overrideMaterial = null
      scene.fog = fog
      cam.layers.set(0)
      r.setClearColor(this.clearColor, 1)
    }
    u.uTime.value = time
    u.uFocus.value = focus
    u.uGain.value = gain
    u.uMaskOn.value = showMask ? 1 : 0
    r.setRenderTarget(null)
    r.render(this.post.scene, this.post.camera)
  }

  clearColor = new THREE.Color()
  setClear(hex: string) {
    this.clearColor.set(hex)
    this.renderer.setClearColor(this.clearColor, 1)
  }

  private onLost = (e: Event) => {
    e.preventDefault()
    this.lost = true
  }
  private onRestored = () => {
    // three re-initialises its GL state; rebuild our targets and re-upload
    // every texture/material so nothing references dead GL objects.
    this.sceneRT.dispose()
    this.maskRT.dispose()
    this.makeTargets()
    this.tex.prop.needsUpdate = true
    this.tex.cards.needsUpdate = true
    this.tex.blob.needsUpdate = true
    this.subTex.needsUpdate = true
    const light = this.world.lampLight
    light.shadow.map?.dispose()
    light.shadow.map = null
    this.world.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined
      if (m) m.needsUpdate = true
    })
    this.post.material.needsUpdate = true
    this.maskMat.needsUpdate = true
    this.renderer.setClearColor(this.clearColor, 1)
    this.lost = false
  }

  dispose() {
    window.removeEventListener('resize', this.resize)
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.sceneRT.dispose()
    this.maskRT.dispose()
    this.renderer.dispose()
    this.canvas.remove()
  }
}

export const PERF_WINDOW = PERF.windowSec
