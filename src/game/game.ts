// Presentation + input for LAST READING. The rules live in Match (match.ts);
// this file animates what Match reports, drives the tutorial on a phantom
// table, and never lets a subsystem failure block a state change.
import * as THREE from 'three'
import { CAMERA, CARD_DEFS, LIGHTS, LIGHT_UNIT, MAX_DECK, PERF, PICK, POST, RULES, TABLE, TAP, type CardDef } from './config'
import { LAYER_FOCUS, LAYER_HOVER, LAYER_RIM, type CardObj, type Target, type TargetId, type World } from './scene'
import { resumeAudio, sfx, suspendAudio, unlockAudio } from './audio'
import { PERF_WINDOW, type Rig } from './rig'
import { Picker } from './pick'
import { hintRetired, loadSensitivity, recordHintFollow, type HintKind } from './prefs'
import { Subtitles } from './subtitles'
import { assertAllLines, LINES, revealLine } from './lines'
import { unlockVoice, type LineId } from './voice'
import { scaleTilt, type Owner } from './rules'
import { Match, type MatchEvent, type MatchState } from './match'
import { DEMO_HAND, DEMO_SCRIPT, demoApply, demoInit, type DemoState } from './demo'
import './selfTest'

export type Screen = 'TITLE' | 'TUTORIAL' | 'MATCH'

interface Pointer {
  id: number; touch: boolean
  x: number; y: number; downX: number; downY: number; downT: number
  moved: number; pressed: Target | null
}

/** Fire-and-forget with a hard 3s cap: used for anything async outside the loop. */
function ff(p: Promise<unknown> | void, label: string) {
  if (!p) return
  const timeout = new Promise((r) => setTimeout(r, 3000))
  void Promise.race([p, timeout]).catch((e) => console.error(`last-reading: ${label}`, e))
}

const TUTORIAL_KEY = 'lastReadingV1.tutorialSeen'

export interface Game {
  screen: Screen
  match: Match
  t: number
  targetFps: number
  sensitivity: number
  update(dt: number): void
  onPointer(type: 'down' | 'move' | 'up' | 'cancel', e: PointerEvent): void
  onPointerLeave(): void
  onKey(code: string, down: boolean): void
  onVisibility(hidden: boolean): void
  onBlur(): void
  /** Camera look only (used by the harness/smoke). */
  yaw: number; pitch: number
}

const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1)
const PRESS_LIFT = 0.004
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export function createGame(rig: Rig, world: World): Game {
  assertAllLines()
  const picker = new Picker(rig, world.targets)
  const subs = new Subtitles(rig.host)
  let ptr: Pointer | null = null
  const mouse = { inside: false, x: 0, y: 0 }
  // One subsystem flag each: a thrown error disables that subsystem only.
  const alive = { audio: true, narration: true, subtitles: true, highlight: true, post: true }
  const guard = (k: keyof typeof alive, fn: () => void) => {
    if (!alive[k]) return
    try { fn() } catch (e) { alive[k] = false; console.error(`last-reading: ${k} disabled`, e) }
  }

  // ── view state ──
  let yaw = 0, pitch = CAMERA.restPitch, tYaw = 0, tPitch = CAMERA.restPitch
  let fade = 0, focus = 0
  let inputLocked = false
  let idleT = 0, decisionT = 0, lastHintT = -99
  let startT = -1
  const fps: number[] = []

  // ── animation sequences (presentation only; Match never waits on these) ──
  type Seq = () => boolean
  const seq: Seq[] = []
  const run = (fn: Seq) => seq.push(fn)
  const after = (dur: number, then: () => void) => {
    const t0 = g.t
    run(() => { if (g.t - t0 < dur) return false; try { then() } catch (e) { console.error('last-reading: seq', e) } return true })
  }

  // ── cards on the table ──
  let held: CardObj | null = null
  const placed: CardObj[] = []
  let deckCount = 0
  /** Bumped on every layoutDeck so stale round-end sweep seqs stop touching cards. */
  let layoutGen = 0

  const keys = new Set<string>()
  const roundRecord: Owner[] = []
  let ffSpeed = 1
  let demo: DemoState | null = null
  let demoBeat = 0, demoBeatT = 0, demoBusy = false, demoSkip = false
  let demoHand: THREE.Vector3 | null = null
  const demoCards: CardObj[] = []

  // Cached bead rest positions — InstancedMesh matrices get corrupted once we
  // scale an instance to 0, so we never re-read them after the first layout.
  const beadRest: THREE.Vector3[][] = world.beadMeshes.map((im) => {
    const arr: THREE.Vector3[] = []
    for (let i = 0; i < MAX_DECK; i++) {
      const cur = new THREE.Matrix4(); im.getMatrixAt(i, cur)
      arr.push(new THREE.Vector3().setFromMatrixPosition(cur))
    }
    return arr
  })

  const match = new Match({ onEvent: onMatchEvent })

  const g: Game = {
    screen: 'TITLE', match, t: 0, targetFps: PERF.activeFps, sensitivity: loadSensitivity(),
    update, onPointer, onPointerLeave() { mouse.inside = false }, onKey, onVisibility,
    onBlur() { releaseInput() },
    get yaw() { return yaw }, get pitch() { return pitch },
  }
  rig.setClear(LIGHTS.clear)
  const syncSubs = () => {
    const st = rig.canvas.style
    const cssW = parseFloat(st.width) || rig.w
    const cssH = parseFloat(st.height) || rig.h
    const cssL = parseFloat(st.left) || 0
    const cssT = parseFloat(st.top) || 0
    subs.syncBox(cssL, cssT, cssW, cssH, rig.w, rig.h)
  }
  syncSubs(); rig.onResize = syncSubs
  // One more sync after the first layout (rig.resize runs in the constructor).
  queueMicrotask(syncSubs)
  resetTable()
  return g

  // ═══════════════════════════════════════════════════════════════ frame ════

  function update(dt: number) {
    dt = Math.min(dt, 0.05)
    g.t += dt

    // texture baking during the title; after 1.5s continue with placeholders
    if (!rig.tex.ready) {
      if (startT < 0) startT = g.t
      guard('post', () => { rig.tex.bake(PERF.bakeBudgetMs) })
      if (!rig.tex.ready && g.t - startT > 1.5 && g.screen !== 'TITLE') {
        console.warn('last-reading: textures not baked in 1.5s, continuing with placeholders')
        rig.tex.ready = true
      }
    }

    // perf tier
    fps.push(dt); if (fps.length > PERF_WINDOW * 60) fps.shift()
    const avg = fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length)
    if (g.screen !== 'TITLE' && avg > PERF.slowFrameMs / 1000 && fps.length > 30 && rig.stepDown()) fps.length = 0
    g.targetFps = g.t - idleT > PERF.idleSec && seq.length === 0 ? PERF.idleFps : PERF.activeFps

    // camera
    camera(dt)

    // Hold player/AI actions until the Reader finishes the current line.
    // Look, ambient, and in-flight animations keep running.
    const readerBusy = (() => { try { return subs.busy() } catch { return false } })()
    const wasActable = match.actable
    match.setActable(!readerBusy)
    // Idle-hint clock starts only once the player can act again.
    if (!wasActable && match.actable && (match.state === 'TURN_IDLE' || match.state === 'HOLDING')) {
      decisionT = g.t
    }

    // engine (never throws; internally capped)
    if (g.screen === 'MATCH') match.update(dt)

    // presentation sequences (capped)
    let n = 0
    while (seq.length && n++ < 64) { if (!seq[0]()) break; seq.shift() }

    guard('highlight', () => { updateTargets(); picker.update(); hover(); cues() })
    if (g.screen === 'MATCH') maybeHint()
    if (g.screen === 'TUTORIAL') tutorialTick(dt)

    // ambient
    world.lamp.rotation.z = Math.sin(g.t * Math.PI * 2 / LIGHTS.lamp.swingPeriod) * LIGHTS.lamp.swingDeg * (Math.PI / 180)
    const dn = world.dust.count || 0
    for (let i = 0; i < dn; i++) {
      const ph = (i / dn + g.t * 0.05) % 1, a = ph * Math.PI * 6 + i * 7.3, r = 0.3 + Math.sin(ph * Math.PI * 4 + i) * 0.15
      P.set(Math.cos(a) * r, 2.5 - ph * 2.2, Math.sin(a) * r)
      const s = 0.6 + Math.sin(ph * Math.PI + i * 2) * 0.4
      world.dust.setMatrixAt(i, M.compose(P, Q.set(0, 0, 0, 1), S.set(s, s, s)))
    }
    if (dn) world.dust.instanceMatrix.needsUpdate = true
    world.flames.forEach((f, i) => { f.scale.setScalar(0.9 + Math.sin(g.t * 8 + i * 1.7) * 0.15); f.visible = g.screen !== 'TITLE' })

    // Keep the subtitle overlay locked to the pixel canvas every frame —
    // a late resize or first-layout race must not leave it at 0×0 CSS.
    syncSubs()
    guard('post', () => rig.render(g.t, focus, POST.gainDefault * (1 - fade), g.screen !== 'TITLE'))
    guard('subtitles', () => subs.draw(g.t))
  }

  function camera(dt: number) {
    const k = CAMERA.keyDegPerSec * dt * (Math.PI / 180)
    if (keys.has('ArrowLeft') || keys.has('KeyA')) tYaw -= k
    if (keys.has('ArrowRight') || keys.has('KeyD')) tYaw += k
    if (keys.has('ArrowUp')) tPitch -= k
    if (keys.has('ArrowDown')) tPitch += k
    tYaw = clamp(tYaw, -CAMERA.yawLimit, CAMERA.yawLimit)
    tPitch = clamp(tPitch, CAMERA.pitchMin, CAMERA.pitchMax)
    yaw += (tYaw - yaw) * CAMERA.damping
    pitch += (tPitch - pitch) * CAMERA.damping
    rig.camera.rotation.set(pitch, yaw, 0)
  }

  // ═══════════════════════════════════════════════════════════════ input ════

  function releaseInput() {
    inputLocked = false
    if (ptr?.pressed) press(ptr.pressed, false)
    ptr = null
  }

  function onPointer(type: 'down' | 'move' | 'up' | 'cancel', e: PointerEvent) {
    idleT = g.t
    const touch = e.pointerType !== 'mouse'
    if (!touch) { mouse.inside = true; mouse.x = e.clientX; mouse.y = e.clientY }
    try {
      if (type === 'down') {
        guard('audio', () => { unlockAudio(); unlockVoice() })
        if (ptr) return
        ptr = { id: e.pointerId, touch, x: e.clientX, y: e.clientY, downX: e.clientX, downY: e.clientY, downT: g.t, moved: 0, pressed: null }
        if (touch) { const t = pickValid(e.clientX, e.clientY, true); if (t) { ptr.pressed = t; press(t, true) } }
        return
      }
      if (!ptr || ptr.id !== e.pointerId) return
      if (type === 'move') {
        const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y
        ptr.x = e.clientX; ptr.y = e.clientY
        ptr.moved = Math.max(ptr.moved, Math.hypot(e.clientX - ptr.downX, e.clientY - ptr.downY))
        const s = g.sensitivity * (Math.PI / 180)
        tYaw = clamp(tYaw + dx * s, -CAMERA.yawLimit, CAMERA.yawLimit)
        tPitch = clamp(tPitch - dy * s, CAMERA.pitchMin, CAMERA.pitchMax)
        if (ptr.pressed && ptr.moved > TAP.maxMovePx) { press(ptr.pressed, false); ptr.pressed = null }
        return
      }
      if (type === 'cancel') { releaseInput(); return }
      // up
      if (ptr.pressed) press(ptr.pressed, false)
      const isTap = ptr.moved <= TAP.maxMovePx && g.t - ptr.downT <= TAP.maxMs / 1000
      const up = ptr; ptr = null
      if (isTap) tap(up.x, up.y, up.touch)
    } finally {
      if (type === 'up' || type === 'cancel') inputLocked = false
    }
  }

  function press(t: Target, on: boolean) {
    t.rim.position.y += on ? PRESS_LIFT : -PRESS_LIFT
    if (on) { t.rim.layers.enable(LAYER_HOVER); guard('audio', () => sfx.tick()) } else t.rim.layers.disable(LAYER_HOVER)
  }

  function pickValid(cx: number, cy: number, touch: boolean) {
    updateTargets(); picker.update()
    return picker.pick(cx, cy, touch)
  }

  function tap(cx: number, cy: number, touch: boolean) {
    if (inputLocked) return
    inputLocked = true
    try {
      if (g.screen === 'TITLE') { startPressed(); return }
      if (g.screen === 'TUTORIAL') { tutorialSkipBeat(); return }
      // MATCH
      if (seq.length && match.state !== 'TURN_IDLE' && match.state !== 'HOLDING') { ffSpeed = PICK.ffSpeed; return }
      const t = pickValid(cx, cy, touch)
      if (!t) return
      // No deck/mat/help taps until the Reader finishes speaking.
      if (subs.busy()) return
      if (t.id === 'deck') { if (match.takeCard()) recordHintFollow('deck') }
      else if (t.id === 'mat_me') { if (match.placeCard('me')) recordHintFollow('place') }
      else if (t.id === 'mat_her') { if (match.placeCard('her')) recordHintFollow('place') }
      else if (t.id.startsWith('help_')) say(t.id as LineId)
    } finally {
      inputLocked = false
    }
  }

  function onKey(code: string, down: boolean) {
    if (down) keys.add(code); else keys.delete(code)
    idleT = g.t
    if (down && (code === 'Escape' || code === 'Backspace') && g.screen === 'TUTORIAL') endTutorial(false)
  }

  function onVisibility(hidden: boolean) {
    releaseInput()
    guard('audio', () => { if (hidden) suspendAudio(); else resumeAudio() })
  }

  // ═══════════════════════════════════════════════════════════════ title ════

  function startPressed() {
    guard('audio', () => sfx.sweep())
    const seen = (() => { try { return localStorage.getItem(TUTORIAL_KEY) === '1' } catch { return false } })()
    if (!seen) startTutorial()
    else startMatch()
  }

  function startMatch() {
    g.screen = 'MATCH'
    resetTable()
    match.startMatch()
  }

  function backToTitle() {
    g.screen = 'TITLE'
    fade = 0; focus = 0
    rig.camera.position.set(CAMERA.pos[0], CAMERA.pos[1], CAMERA.pos[2])
    rig.camera.rotation.set(0, 0, 0)
    yaw = 0; pitch = CAMERA.restPitch; tYaw = 0; tPitch = CAMERA.restPitch
    world.doorPivot.rotation.y = 0; world.doorLight.intensity = 0
    world.trapdoor.position.set(0, 0.025, 1.9); world.trapdoor.rotation.z = 0
    resetTable()
    guard('subtitles', () => subs.clear())
  }

  // ═══════════════════════════════════════════════════════════ table view ════

  function resetTable() {
    held = null; placed.length = 0; deckCount = 0
    for (const c of world.cards) { c.group.visible = false; c.group.rotation.set(0, 0, 0); world.setCardFace(c, -1) }
    setBeads(0, 0)
    applyScale(0, false, false)
    candles(0, [])
    world.captiveHead.rotation.y = 0
    world.captiveHead.position.set(0, 1.46, -1.4)
  }

  function layoutDeck(n: number) {
    // Invalidate any in-flight sweep seqs from the previous round so they
    // cannot hide cards we just laid out for the new deck.
    layoutGen++
    held = null
    placed.length = 0
    deckCount = n
    for (let i = 0; i < MAX_DECK; i++) {
      const c = world.cards[i]
      world.setCardFace(c, -1)
      c.group.rotation.set(0, 0, 0)
      c.group.visible = i < n
      c.group.position.set(TABLE.deck[0], TABLE.deck[1] + 0.002 + i * 0.003, TABLE.deck[2])
    }
  }

  /** Top of the visual deck — identical for every card (always the back). */
  function topCard(): CardObj | null {
    if (deckCount <= 0) return null
    return world.cards[deckCount - 1]
  }

  function setBeads(left: number, total: number) {
    const show = Math.min(left, total, MAX_DECK)
    for (let rail = 0; rail < world.beadMeshes.length; rail++) {
      const im = world.beadMeshes[rail]
      for (let i = 0; i < MAX_DECK; i++) {
        const pos = beadRest[rail][i]
        if (i < show) M.compose(pos, Q.set(0, 0, 0, 1), S.set(1, 1, 1))
        else M.compose(pos, Q.set(0, 0, 0, 1), S.set(0, 0, 0))
        im.setMatrixAt(i, M)
      }
      im.count = MAX_DECK
      im.instanceMatrix.needsUpdate = true
    }
  }

  function applyScale(deg: number, myGlow: boolean, herGlow: boolean) {
    world.beam.rotation.z = deg * (Math.PI / 180)
    const arm = 0.16, ty = Math.sin(Math.abs(deg) * (Math.PI / 180)) * arm
    world.panNear.position.set(TABLE.scale[0], TABLE.scale[1] + 0.27 - arm + (deg > 0 ? -ty : ty), TABLE.scale[2] + arm)
    world.panFar.position.set(TABLE.scale[0], TABLE.scale[1] + 0.27 - arm + (deg > 0 ? ty : -ty), TABLE.scale[2] - arm)
    world.panNear.rotation.z = world.panFar.rotation.z = -world.beam.rotation.z
    const gold = new THREE.Color('#e8b25a'), soft = new THREE.Color('#c4a858')
    const setE = (o: THREE.Object3D, on: boolean, c: THREE.Color, k: number) => {
      const m = ((o as THREE.Mesh).material ?? ((o.children[0] as THREE.Mesh)?.material)) as THREE.MeshLambertMaterial | undefined
      if (!m) return
      if (on) { m.emissive.copy(c); m.emissiveIntensity = k } else { m.emissive.set(0, 0, 0); m.emissiveIntensity = 0 }
    }
    setE(world.panNear, myGlow, gold, 0.6); setE(world.panFar, herGlow, gold, 0.6)
    setE(world.myMat, myGlow, soft, 0.3); setE(world.farMat, herGlow, soft, 0.3)
  }

  function candles(currentRound: number, record: Owner[]) {
    for (let i = 0; i < 3; i++) {
      const f = world.roundFlames[i], w = world.smokeWisps[i]
      if (i < record.length) { f.visible = record[i] === 'me'; f.scale.setScalar(1.1); w.visible = !f.visible }
      else { f.visible = i === currentRound - 1; f.scale.setScalar(1.5); w.visible = false }
    }
  }

  // ═══════════════════════════════════════════════════════ match events ════
  // Every handler is presentation only. Match proceeds on its own clock; we
  // call match.done() early when our animation finishes so it needn't wait.

  function onMatchEvent(e: MatchEvent) {
    switch (e.type) {
      case 'round_start':
        layoutDeck(e.cards); setBeads(e.cards, e.cards); applyScale(0, false, false)
        candles(e.roundN, roundRecord)
        break
      case 'goal':
        say(e.roundN === 1 ? 'goal1' : e.roundN === 2 ? 'goal2' : 'goal3')
        break
      case 'state':
        onState(e.from, e.to)
        break
      case 'draw': {
        const c = topCard(); if (!c) break
        deckCount--
        held = c
        setBeads(e.cardsLeft, match.beads.cardsTotal)
        guard('audio', () => sfx.draw())
        const mine = e.by === 'me'
        const t0 = g.t, p0 = c.group.position.clone()
        const p1 = mine ? new THREE.Vector3(0, 0.97, 0.9) : new THREE.Vector3(0, 0.87, -0.42)
        const gen = layoutGen
        run(() => {
          if (gen !== layoutGen) return true
          const k = Math.min((g.t - t0) / 0.3, 1), f = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
          c.group.position.lerpVectors(p0, p1, f)
          c.group.rotation.x = mine ? f * (-Math.PI / 6) : 0
          return k >= 1
        })
        decisionT = g.t
        break
      }
      case 'place': {
        const c = held; if (!c) break
        held = null; placed.push(c)
        guard('audio', () => sfx.place())
        const [mx, , mz] = e.target === 'me' ? TABLE.myMat : TABLE.farMat
        const t0 = g.t, p0 = c.group.position.clone(), r0 = c.group.rotation.x
        const p1 = new THREE.Vector3(mx + (placed.length - 1) * 0.012, TABLE.surfaceY + 0.004 + placed.length * 0.0025, mz)
        const gen = layoutGen
        run(() => {
          if (gen !== layoutGen) return true
          const k = Math.min((g.t - t0) / 0.3, 1)
          c.group.position.lerpVectors(p0, p1, k); c.group.rotation.x = r0 * (1 - k)
          if (k >= 1) match.done()
          return k >= 1
        })
        break
      }
      case 'reveal_mid': {
        // the only place identity is ever applied to a mesh
        const c = placed[placed.length - 1]; if (!c) break
        world.setCardFace(c, CARD_DEFS.indexOf(e.def))
        // Reader announces the card and its value after the flip mid-point.
        say('reveal', revealLine(e.def, e.target))
        break
      }
      case 'resolve': {
        guard('audio', () => { if (e.def.kind === 'blank') sfx.blank(); else if (e.def.kind === 'boon') sfx.boon(0); else sfx.bane(0) })
        const t = scaleTilt(e.score)
        applyScale(t.beamDeg, t.myGlow, t.herGlow)
        if (Math.abs(t.beamDeg) > 2) guard('audio', () => sfx.creak())
        if (e.again) guard('audio', () => sfx.extraTurn())
        after(0.5, () => match.done())
        break
      }
      case 'round_end': {
        roundRecord.push(e.winner)
        candles(match.roundN, roundRecord)
        say(e.tie ? 'round_end_tie' : e.winner === 'me' ? 'round_end_win' : 'round_end_lose')
        const b0 = world.beam.rotation.z, drop = (e.winner === 'me' ? Math.max(e.score.myScore - e.score.herScore, 1) : Math.min(e.score.myScore - e.score.herScore, -1)) * 8
        const t0 = g.t
        const genAtEnd = layoutGen
        run(() => { const k = Math.min((g.t - t0) / RULES.panDropSec, 1); world.beam.rotation.z = b0 + (clamp(drop, -28, 28) * Math.PI / 180 - b0) * k; return k >= 1 })
        after(RULES.panDropSec * 0.6, () => guard('audio', () => sfx.bell(e.winner !== 'me')))
        if (e.winner === 'me') yankCaptive()
        after(RULES.panDropSec + RULES.roundEndPause, () => {
          // If the next round already laid out a fresh deck, skip the sweep.
          if (layoutGen !== genAtEnd) { match.done(); return }
          guard('audio', () => sfx.sweep())
          const t1 = g.t, dir = e.winner === 'me' ? -1 : 1
          const sweeping = world.cards.filter((c) => c.group.visible)
          for (const c of sweeping) {
            const p0 = c.group.position.clone()
            const gen = layoutGen
            run(() => {
              if (gen !== layoutGen) return true
              const k = Math.min((g.t - t1) / RULES.cardSweepSec, 1)
              c.group.position.set(p0.x + dir * k * 1.6, p0.y - k * 0.35, p0.z - dir * k * 1.6)
              c.group.rotation.z = k * dir * 0.9
              if (k >= 1) c.group.visible = false
              return k >= 1
            })
          }
          after(RULES.cardSweepSec + 0.2, () => match.done())
        })
        break
      }
      case 'match_end':
        if (e.winner === 'me') winEnding(); else loseEnding()
        break
      case 'watchdog':
        // presentation fell behind; drop pending animation so the table matches the engine
        seq.length = 0
        break
      case 'illegal':
        break
    }
  }

  function onState(_from: MatchState, to: MatchState) {
    if (to === 'TURN_IDLE') {
      // Idle-hint clock starts when the player can actually act (after speech).
      decisionT = g.t
      ffSpeed = 1
    }
    if (to === 'TENSION') guard('audio', () => sfx.tension())
    if (to === 'REVEAL') {
      const c = placed[placed.length - 1]
      if (c) {
        guard('audio', () => sfx.flip())
        const t0 = g.t, gen = layoutGen
        run(() => {
          if (gen !== layoutGen) { match.done(); return true }
          const k = Math.min((g.t - t0) / 0.3, 1)
          c.group.rotation.y = k * Math.PI
          if (k >= 1) match.done()
          return k >= 1
        })
      } else {
        match.done()
      }
    }
    if (to === 'IDLE' && g.screen === 'MATCH') { roundRecord.length = 0; backToTitle() }
  }

  function yankCaptive() {
    const t0 = g.t
    guard('audio', () => sfx.creak())
    run(() => {
      const k = Math.min((g.t - t0) / 1.0, 1), pull = Math.min(k / 0.3, 1)
      const jit = k > 0.3 && k < 0.8 ? Math.sin((g.t - t0) * 30) * 0.02 * (1 - (k - 0.3) / 0.5) : 0
      world.captiveHead.position.set(jit, 1.46, -1.4 - pull * 0.22)
      return k >= 1
    })
  }

  function winEnding() {
    say('match_win')
    guard('audio', () => { sfx.bell(); sfx.door() })
    const t0 = g.t
    run(() => { const k = Math.min((g.t - t0) / RULES.doorOpenSec, 1); world.doorPivot.rotation.y = -k * 1.9; world.doorLight.intensity = k * 2.2 * LIGHT_UNIT; return k >= 1 })
    after(RULES.doorOpenSec + RULES.doorHoldSec, () => {
      const t1 = g.t
      run(() => { const k = Math.min((g.t - t1) / 1.4, 1); world.doorLight.intensity = (1 - k) * 2.2 * LIGHT_UNIT; fade = k; return k >= 1 })
      after(1.4, () => match.done())
    })
  }

  function loseEnding() {
    say('match_lose')
    guard('audio', () => sfx.snap())
    after(0.5, () => {
      guard('audio', () => sfx.fall())
      const t0 = g.t, y0 = rig.camera.position.y
      run(() => { const k = Math.min((g.t - t0) / 0.7, 1), f = k * k; world.trapdoor.position.y = 0.025 - f * 1.2; world.trapdoor.rotation.z = f * 0.35; rig.camera.position.y = y0 - f * 1.5; rig.camera.rotation.z = f * 0.25; return k >= 1 })
      after(0.7, () => {
        const t1 = g.t
        run(() => { const k = Math.min((g.t - t1) / 0.35, 1); fade = k; return k >= 1 })
        after(0.35 + RULES.fallBlackSec, () => match.done())
      })
    })
  }

  // ═══════════════════════════════════════════════════ cues / hints / help ════

  function updateTargets() {
    const myTurn = g.screen === 'MATCH' && match.turn === 'me'
    const canAct = match.actable // false while the Reader is speaking
    for (const t of world.targets) {
      switch (t.id) {
        case 'deck': t.valid = canAct && myTurn && match.state === 'TURN_IDLE'; break
        case 'mat_me': case 'mat_her': t.valid = canAct && myTurn && match.state === 'HOLDING'; break
        default: t.valid = canAct && g.screen === 'MATCH' // help objects also wait for the Reader
      }
    }
  }

  function hover() {
    const was = picker.hover
    const can = mouse.inside && !ptr && world.targets.some((t) => t.valid)
    picker.setHover(can ? picker.pick(mouse.x, mouse.y, false) : null)
    if (was !== picker.hover) { if (was) was.rim.layers.disable(LAYER_HOVER); if (picker.hover) picker.hover.rim.layers.enable(LAYER_HOVER) }
  }

  function cues() {
    const myTurn = g.screen === 'MATCH' && match.turn === 'me' && match.actable
    const showDeck = myTurn && match.state === 'TURN_IDLE'
    const showMats = myTurn && match.state === 'HOLDING'
    world.deckGlow.visible = showDeck; world.myMatGlow.visible = world.farMatGlow.visible = showMats
    const pulse = 0.45 + Math.sin(g.t * 3) * 0.15
    for (const m of [world.deckGlow, world.myMatGlow, world.farMatGlow]) (m.material as THREE.MeshBasicMaterial).opacity = pulse
    const hand = world.pointHand
    hand.visible = showDeck || showMats || demoHand !== null
    if (demoHand) { hand.position.copy(demoHand); hand.rotation.set(0.6, 0, 0); return }
    const bob = Math.sin(g.t * 4) * 0.02
    if (showDeck) { hand.position.set(TABLE.deck[0], 1.05 + bob, TABLE.deck[2]); hand.rotation.set(0.6, 0, 0) }
    else if (showMats) { hand.position.set(0.15, 1.1 + bob, 0); hand.rotation.set(0.3, 0, 0) }
  }

  function maybeHint() {
    if (match.turn !== 'me' || (match.state !== 'TURN_IDLE' && match.state !== 'HOLDING')) return
    if (subs.busy() || !match.actable) return
    if (g.t - decisionT < 5 || g.t - lastHintT < 10) return
    const kind: HintKind = match.state === 'HOLDING' ? 'place' : 'deck'
    if (hintRetired(kind)) return
    lastHintT = g.t
    say(kind === 'place' ? 'hint_place' : 'hint_deck')
  }

  function say(id: LineId, override?: string) {
    guard('narration', () => {
      const text = override ?? LINES[id as Exclude<LineId, 'custom'>]
      if (!text) return
      ff(undefined, 'say')
      subs.say(id, text, g.t) // speak() inside is wall-clock; it never blocks
    })
  }

  // ═══════════════════════════════════════════════════════════ tutorial ════
  // Phantom table: DemoState only; the live Match stays IDLE throughout.

  function startTutorial() {
    g.screen = 'TUTORIAL'
    demo = demoInit(); demoBeat = 0; demoBeatT = 0; demoBusy = false; demoSkip = false
    layoutDeck(DEMO_HAND.length); setBeads(DEMO_HAND.length, DEMO_HAND.length); applyScale(0, false, false)
    demoCards.length = 0
    candles(1, [])
  }

  function endTutorial(completed: boolean) {
    if (completed) { try { localStorage.setItem(TUTORIAL_KEY, '1') } catch {} }
    demo = null; demoHand = null; focus = 0
    for (const o of [world.deckHit, world.myMat, world.farMat, world.beam, world.rack, world.doorPivot, world.trapdoor, ...world.roundFlames]) o.traverse((c) => c.layers.disable(LAYER_FOCUS))
    seq.length = 0
    guard('subtitles', () => subs.clear())
    if (completed) startMatch(); else backToTitle()
  }

  function tutorialSkipBeat() { if (demo) demoSkip = true }

  function tutorialTick(dt: number) {
    if (!demo) return
    demoBeatT += dt
    if (demoBusy) return
    const beat = DEMO_SCRIPT[demoBeat]
    if (!beat) { endTutorial(true); return }
    // run the beat once, then wait for its hold + voice
    demoBusy = true
    const hl: Record<string, THREE.Object3D[]> = {
      deck: [world.deckHit], mat_me: [world.myMat], mat_her: [world.farMat], scale: [world.beam, world.panNear, world.panFar],
      beads: [world.rack, ...world.beadMeshes], candles: world.roundFlames, door: [world.doorPivot], trap: [world.trapdoor],
    }
    for (const list of Object.values(hl)) for (const o of list) o.traverse((c) => c.layers.disable(LAYER_FOCUS))
    focus = beat.hl && beat.hl.length ? 1 : 0
    for (const k of beat.hl ?? []) for (const o of hl[k] ?? []) o.traverse((c) => c.layers.enable(LAYER_FOCUS))
    if (beat.line) say(beat.line)
    let dur = (beat.line ? Math.max(1.2, (LINES[beat.line as Exclude<LineId, 'custom'>] ?? '').length / 16) : 0) + (beat.hold ?? 0.3)

    if (beat.draw) {
      const idx = demoCards.length
      const c = world.cards[deckCount - 1]; deckCount--
      demoCards.push(c)
      demo = { ...demo, card: idx, holder: beat.draw, cardsLeft: demo.cardsLeft - 1, revealed: false }
      setBeads(demo.cardsLeft, DEMO_HAND.length)
      demoHand = new THREE.Vector3(TABLE.deck[0], 1.05, TABLE.deck[2])
      guard('audio', () => sfx.draw())
      const t0 = g.t, p0 = c.group.position.clone(), p1 = beat.draw === 'me' ? new THREE.Vector3(0, 0.97, 0.9) : new THREE.Vector3(0, 0.87, -0.42)
      run(() => { const k = Math.min((g.t - t0) / 0.35, 1); c.group.position.lerpVectors(p0, p1, k); return k >= 1 })
      dur += 0.35
    }
    if (beat.place && demo.card >= 0) {
      const c = demoCards[demo.card]
      demo = { ...demo, target: beat.place }
      const [mx, , mz] = beat.place === 'me' ? TABLE.myMat : TABLE.farMat
      demoHand = new THREE.Vector3(mx, 1.0, mz)
      after(0.35, () => {
        guard('audio', () => sfx.place())
        const t0 = g.t, p0 = c.group.position.clone(), p1 = new THREE.Vector3(mx + demo!.card * 0.012, TABLE.surfaceY + 0.004 + demo!.card * 0.0025, mz)
        run(() => { const k = Math.min((g.t - t0) / 0.3, 1); c.group.position.lerpVectors(p0, p1, k); c.group.rotation.x = 0; return k >= 1 })
      })
      dur += 0.7
    }
    if (beat.reveal && demo.card >= 0) {
      const c = demoCards[demo.card]
      const kind = DEMO_HAND[demo.card]
      const face = CARD_DEFS.findIndex((d) => d.kind === kind)
      const startAt = (beat.draw ? 0.35 : 0) + (beat.place ? 0.7 : 0)
      after(startAt, () => {
        guard('audio', () => sfx.tension())
        after(RULES.tensionSec, () => {
          guard('audio', () => sfx.flip())
          const t0 = g.t; let mid = false
          run(() => {
            const k = Math.min((g.t - t0) / 0.3, 1)
            c.group.rotation.y = k * Math.PI
            if (!mid && k >= 0.5) { mid = true; world.setCardFace(c, face) } // face only at the midpoint
            return k >= 1
          })
          after(0.3, () => {
            demo = demoApply(demo!)
            guard('audio', () => { if (kind === 'blank') sfx.blank(); else if (kind === 'boon') sfx.boon(0); else sfx.bane(0) })
            const t = scaleTilt({ myScore: demo.a, herScore: demo.b })
            applyScale(t.beamDeg, t.myGlow, t.herGlow)
            demoHand = null
          })
        })
      })
      dur += startAt + RULES.tensionSec + 0.6
    }
    // end of beat: wait dur (tap skips), with a watchdog
    const t0 = g.t
    run(() => {
      const elapsed = g.t - t0
      if (elapsed < dur && !demoSkip) return false
      demoSkip = false
      if (elapsed > dur * 2 + 1) console.warn('last-reading: tutorial beat watchdog')
      demoBusy = false; demoBeat++; demoBeatT = 0
      return true
    })
  }
}

export type { CardDef }
