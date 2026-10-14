import { useEffect, useRef } from 'react'
import { createTextures } from './game/textures'
import { buildWorld } from './game/scene'
import { Rig } from './game/rig'
import { createGame } from './game/game'

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const tex = createTextures()
    const world = buildWorld(tex)
    const rig = new Rig(host, world, tex)
    const game = createGame(rig, world)
    ;(window as unknown as { __game: unknown }).__game = game

    let last = performance.now()
    let handle = 0
    let raf = 0
    let alive = true
    const loop = (now: number) => {
      if (!alive) return
      // Schedule the next frame FIRST: a thrown update can never stop the chain.
      const delay = Math.max(0, 1000 / Math.max(1, game.targetFps) - 16)
      handle = window.setTimeout(() => { raf = requestAnimationFrame(loop) }, delay)
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      try { game.update(dt) } catch (err) { console.error('last-reading: frame error', err) }
    }
    raf = requestAnimationFrame(loop)

    // All four phases go through one handler: the game decides what is a tap
    // and what is a look, and needs move events from touch as well as mouse.
    const onPointer = (e: PointerEvent) => {
      const type = e.type === 'pointerdown' ? 'down'
        : e.type === 'pointermove' ? 'move'
        : e.type === 'pointerup' ? 'up' : 'cancel'
      if (type === 'down') host.setPointerCapture(e.pointerId)
      game.onPointer(type, e)
    }
    host.addEventListener('pointerdown', onPointer)
    host.addEventListener('pointermove', onPointer)
    host.addEventListener('pointerup', onPointer)
    host.addEventListener('pointercancel', onPointer)
    const onLeave = () => game.onPointerLeave()
    host.addEventListener('pointerleave', onLeave)

    const onKey = (e: KeyboardEvent) => game.onKey(e.code, e.type === 'keydown')
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)

    const onVis = () => game.onVisibility(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    const onBlur = () => game.onBlur()
    window.addEventListener('blur', onBlur)

    return () => {
      alive = false
      clearTimeout(handle)
      cancelAnimationFrame(raf)
      window.removeEventListener('blur', onBlur)
      host.removeEventListener('pointerdown', onPointer)
      host.removeEventListener('pointermove', onPointer)
      host.removeEventListener('pointerup', onPointer)
      host.removeEventListener('pointercancel', onPointer)
      host.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      document.removeEventListener('visibilitychange', onVis)
      rig.dispose()
    }
  }, [])

  return (
    <div
      ref={hostRef}
      style={{
        position: 'relative',
        width: '100vw',
        height: '100dvh',
        overflow: 'hidden',
        touchAction: 'none',
        background: '#0b0d12',
      }}
    />
  )
}
