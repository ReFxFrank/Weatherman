import type { Map as MapLibreMap } from 'maplibre-gl'

/**
 * Cinematic camera work (§5.7): the ease-in-from-orbit entrance and the idle
 * auto-rotation that pauses on interaction and resumes after a few quiet
 * seconds. Both respect prefers-reduced-motion.
 */

export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/** Where the camera should land: the longitude band burning hardest right now. */
export function fireCenter(positions: Float32Array, frp: Float32Array): { lon: number; lat: number } {
  const BINS = 24
  const weight = new Float64Array(BINS)
  const latSum = new Float64Array(BINS)
  const n = frp.length
  for (let i = 0; i < n; i++) {
    const lon = positions[i * 2]
    const lat = positions[i * 2 + 1]
    const bin = Math.min(BINS - 1, Math.max(0, Math.floor(((lon + 180) / 360) * BINS)))
    const w = Math.min(frp[i], 200) + 1
    weight[bin] += w
    latSum[bin] += lat * w
  }
  let best = 0
  for (let b = 1; b < BINS; b++) if (weight[b] > weight[best]) best = b
  const lon = -180 + (best + 0.5) * (360 / BINS)
  const lat = weight[best] > 0 ? latSum[best] / weight[best] : 10
  // Keep the globe pleasantly tilted rather than staring at a pole.
  return { lon, lat: Math.min(35, Math.max(-30, lat)) }
}

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
