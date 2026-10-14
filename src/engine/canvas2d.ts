// ── engine/canvas2d.ts — device-pixel-ratio aware canvas sizing ──
// Returns a ref holding the canvas size in CSS pixels; after this hook runs,
// draw in CSS pixel coordinates (the context transform maps to physical px).
// CAUTION: ctx.setTransform(...) in your own code WIPES the ratio transform.
// For a camera, compose on top instead:
//   ctx.save(); ctx.translate(-cam.x, -cam.y); /* draw world */ ctx.restore()
// Foundation helper with no game shape; delete if unused.
import { useEffect, useRef } from 'react'
import type * as React from 'react'

export function useCanvas2d(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
): React.MutableRefObject<{ w: number; h: number }> {
  const sizeRef = useRef({ w: 0, h: 0 })
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 3)
      const { width: cssW, height: cssH } = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(cssW * ratio))
      canvas.height = Math.max(1, Math.round(cssH * ratio))
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      sizeRef.current = { w: cssW, h: cssH }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [canvasRef])
  return sizeRef
}
