// Player preferences, persisted to localStorage under 'lastReadingV1'.
import { CAMERA } from './config'

const KEY = 'lastReadingV1'

interface Prefs {
  sensitivity?: number
  /** How many times each hint type has been followed correctly. */
  hints?: Record<string, number>
}

function load(): Prefs {
  try {
    const s = localStorage.getItem(KEY)
    return s ? (JSON.parse(s) as Prefs) : {}
  } catch {
    return {}
  }
}

function save(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...load(), ...p }))
  } catch {}
}

export function loadSensitivity(): number {
  return load().sensitivity ?? CAMERA.dragDegPerPxDefault
}

export function saveSensitivity(v: number) {
  save({ sensitivity: v })
}

export type HintKind = 'deck' | 'place'

export function hintFollowCount(kind: HintKind): number {
  return load().hints?.[kind] ?? 0
}

export function recordHintFollow(kind: HintKind) {
  const hints = { ...(load().hints ?? {}) }
  hints[kind] = (hints[kind] ?? 0) + 1
  save({ hints })
}

/** A hint type retires after 3 correct follows. */
export function hintRetired(kind: HintKind): boolean {
  return hintFollowCount(kind) >= 3
}
