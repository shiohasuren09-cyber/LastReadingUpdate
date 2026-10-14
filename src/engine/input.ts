// ── engine/input.ts — unified pointer + keyboard snapshot ──
// Read `inputRef.current` INSIDE your game loop each frame; spread `handlers`
// onto the game's root container element. Single-pointer by design: the first
// active pointer wins. Games needing simultaneous move+action zones (virtual
// joystick + buttons) should write their own zoned handlers instead — see the
// game-kit mobile-game-controls reference. Keys hold `e.code` values
// ('ArrowLeft', 'KeyW', 'Space'), which are keyboard-layout independent.
// Foundation helper with no game shape; delete if unused.
import { useEffect, useRef } from 'react'
import type * as React from 'react'

export type InputState = {
  pointer: { x: number; y: number; down: boolean }
  keys: Set<string>
}

export type InputHandlers = {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
}

export function useInput(): {
  inputRef: React.MutableRefObject<InputState>
  handlers: InputHandlers
} {
  const inputRef = useRef<InputState>({
    pointer: { x: 0, y: 0, down: false },
    keys: new Set<string>(),
  })
  const activePointer = useRef<number | null>(null)

  useEffect(() => {
    const down = (e: KeyboardEvent) => inputRef.current.keys.add(e.code)
    const up = (e: KeyboardEvent) => inputRef.current.keys.delete(e.code)
    const blur = () => inputRef.current.keys.clear() // alt-tab must not leave stuck keys
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const setPos = (e: React.PointerEvent<HTMLElement>) => {
    // currentTarget, NOT target: child elements (HUD) would break coordinates.
    const r = e.currentTarget.getBoundingClientRect()
    inputRef.current.pointer.x = e.clientX - r.left
    inputRef.current.pointer.y = e.clientY - r.top
  }
  const release = (e: React.PointerEvent<HTMLElement>) => {
    if (activePointer.current !== e.pointerId) return
    activePointer.current = null
    inputRef.current.pointer.down = false
  }

  const handlers: InputHandlers = {
    onPointerDown: (e) => {
      if (activePointer.current !== null) return
      activePointer.current = e.pointerId
      e.currentTarget.setPointerCapture?.(e.pointerId) // keep drags outside the element
      setPos(e) // a tap must land at its own coordinates, not the previous move's
      inputRef.current.pointer.down = true
    },
    onPointerMove: (e) => {
      if (activePointer.current !== null && activePointer.current !== e.pointerId) return
      setPos(e)
    },
    onPointerUp: release,
    onPointerCancel: release,
  }
  return { inputRef, handlers }
}
