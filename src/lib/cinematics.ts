import type { Map as MapLibreMap } from 'maplibre-gl'

/**
 * Cinematic camera work (§5.7): the ease-in-from-orbit entrance and the idle
 * auto-rotation that pauses on interaction and resumes after a few quiet
 * seconds. Both respect prefers-reduced-motion.
 */

export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * Where the camera lands by default: a fixed home view framing North America
 * (owner preference — this used to be the hardest-burning longitude band,
 * which parked the camera over whatever continent led the fire count).
 * Deep links (?lat/lon/z) still override the landing spot entirely.
 */
export const HOME_VIEW = { lon: -98, lat: 36 }

export const ENTRANCE_START = { longitude: -40, latitude: 8, zoom: 0.45 }
export const ENTRANCE_MS = 5200

/** Ease from high orbit down onto the target. Returns a cancel function. */
export function flyEntrance(map: MapLibreMap, target: { lon: number; lat: number }): () => void {
  map.easeTo({
    center: [target.lon, target.lat],
    zoom: 1.95,
    duration: ENTRANCE_MS,
    easing: easeOutCubic,
    essential: false, // user input (or reduced-motion) interrupts it
  })
  return () => map.stop()
}

export interface RotationOpts {
  /** degrees of longitude per second at idle */
  degPerSec?: number
  /** ms of quiet before rotation resumes */
  idleAfterMs?: number
  /** don't rotate when zoomed in past this */
  maxZoom?: number
}

/**
 * Idle auto-rotation. Any pointer/wheel/touch/key interaction pauses it
 * instantly; it resumes after `idleAfterMs` of quiet. Disabled on coarse
 * pointers (mobile) and under prefers-reduced-motion.
 */
export function startIdleRotation(map: MapLibreMap, opts: RotationOpts = {}): () => void {
  const { degPerSec = 2.2, idleAfterMs = 5000, maxZoom = 4.2 } = opts
  if (reducedMotion() || matchMedia('(pointer: coarse)').matches) return () => {}

  let lastInteraction = Date.now()
  let pointerDown = false
  let raf = 0
  let lastFrame = 0

  const poke = () => {
    lastInteraction = Date.now()
  }
  const down = () => {
    pointerDown = true
    poke()
  }
  const up = () => {
    pointerDown = false
    poke()
  }

  const el = map.getCanvasContainer()
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointerup', up)
  el.addEventListener('wheel', poke, { passive: true })
  el.addEventListener('touchstart', down, { passive: true })
  el.addEventListener('touchend', up, { passive: true })
  window.addEventListener('keydown', poke)

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = lastFrame ? Math.min(now - lastFrame, 100) : 0
    lastFrame = now
    if (dt === 0) return
    if (pointerDown || document.hidden) return
    if (Date.now() - lastInteraction < idleAfterMs) return
    if (map.isMoving() && !rotating) return // a user/ease animation is in flight
    if (map.getZoom() > maxZoom) return
    // Spinning a flat map reads as a glitch, not a globe — only rotate the globe.
    if (map.getProjection()?.type !== 'globe') return
    rotating = true
    const c = map.getCenter()
    c.lng += (degPerSec * dt) / 1000
    map.jumpTo({ center: c })
    rotating = false
  }
  let rotating = false
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('wheel', poke)
    el.removeEventListener('touchstart', down)
    el.removeEventListener('touchend', up)
    window.removeEventListener('keydown', poke)
  }
}
