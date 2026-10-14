// ── engine/loop.ts — requestAnimationFrame game loop ──
// dt is in SECONDS, clamped to 1/30 so tab-switches never produce a huge step.
// Foundation helper with no game shape; delete if unused.
import { useEffect, useRef } from 'react'

export function useGameLoop(callback: (dt: number) => void, running = true): void {
  const cbRef = useRef(callback)
  cbRef.current = callback
  useEffect(() => {
    if (!running) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30)
      last = now
      cbRef.current(dt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running])
}
