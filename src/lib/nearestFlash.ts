import type { LightningData, LightningMeta } from './types'

/**
 * CPU flash picking, mirroring nearestHotspot.ts: nearest rendered flash
 * within a screen-pixel radius. Searches the RENDERED (quality-decimated)
 * set — what you click is what's glowing — and honors the age-window cap so
 * filtered-out history can't be selected.
 *
 * Age math matches lightningLayers.ts exactly: live payloads slide with the
 * wall clock; baked payloads are frozen at the bake instant.
 */

/**
 * The GPU trail cutoff as a max age-at-fetch (minutes): a flash is visible
 * when (fetchSec - tsSec)/60 <= this. THE shared window predicate — used by
 * picking AND selection validation (App.validFlash) so a selected flash can
 * never outlive what's glowing (the "filters exist twice" gotcha class).
 */
export function flashAgeAtFetchMax(
  meta: LightningMeta,
  nowSec: number,
  windowMin: number | null,
): number {
  const fetchSec = Math.floor(Date.parse(meta.fetchedAt) / 1000) || nowSec
  const elapsedMin = meta.mode === 'live' ? Math.max(0, (nowSec - fetchSec) / 60) : 0
  const windowLimit = Math.min(meta.windowMin || 60, windowMin ?? Number.POSITIVE_INFINITY)
  return windowLimit - elapsedMin
}

export function findNearestFlash(
  data: LightningData,
  click: { lng: number; lat: number },
  zoom: number,
  nowSec: number,
  /** user age-window cap in minutes (store.lightningWindowMin), null = full */
  windowMin: number | null,
  pickRadiusPx = 14,
): number | null {
  const { positions, tsSec, count, meta } = data
  const fetchSec = Math.floor(Date.parse(meta.fetchedAt) / 1000) || nowSec
  const ageAtFetchMax = flashAgeAtFetchMax(meta, nowSec, windowMin)

  const degPerPx = 360 / (512 * Math.pow(2, zoom))
  const maxDeg = pickRadiusPx * degPerPx
  const maxDegSq = maxDeg * maxDeg
  const cosLat = Math.max(0.087, Math.cos((click.lat * Math.PI) / 180))

  let best = -1
  let bestDistSq = maxDegSq
  for (let i = 0; i < count; i++) {
    const dLat = positions[i * 2 + 1] - click.lat
    if (dLat > maxDeg || dLat < -maxDeg) continue
    let dLon = positions[i * 2] - click.lng
    if (dLon > 180) dLon -= 360
    else if (dLon < -180) dLon += 360
    dLon *= cosLat
    const distSq = dLat * dLat + dLon * dLon
    if (distSq >= bestDistSq) continue
    if ((fetchSec - tsSec[i]) / 60 > ageAtFetchMax) continue
    best = i
    bestDistSq = distSq
  }
  return best === -1 ? null : best
}
