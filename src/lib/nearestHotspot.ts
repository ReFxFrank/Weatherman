import type { DecodedFire } from './types'
import type { FireFilters } from './fireLayers'

/**
 * CPU hotspot picking: given a map click, find the nearest detection within a
 * screen-pixel radius, honoring the active GPU filters so users can't select
 * points they can't see. A linear scan over ~200k points is ~2ms — and unlike
 * deck picking it is guaranteed correct on the globe projection.
 */
export function findNearestHotspot(
  // searches the FULL decoded payload so selection indices match stats
  data: DecodedFire,
  click: { lng: number; lat: number },
  zoom: number,
  filters: FireFilters,
  timeRange: [number, number],
  pickRadiusPx = 14,
): number | null {
  const { positions, frp, conf, night, tsSec, count, meta } = data
  const fetchSec = Math.floor(Date.parse(meta.fetchedAt) / 1000)
  const wantNight = filters.dayNight === 'all' ? -1 : filters.dayNight === 'night' ? 1 : 0

  // Degrees per screen pixel at this zoom (equatorial); longitude distances
  // shrink by cos(lat), handled per-point below.
  const degPerPx = 360 / (512 * Math.pow(2, zoom))
  const maxDeg = pickRadiusPx * degPerPx
  const maxDegSq = maxDeg * maxDeg
  const cosLat = Math.max(0.087, Math.cos((click.lat * Math.PI) / 180)) // clamp near poles

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
    // same predicate as the GPU DataFilterExtension
    if (frp[i] < filters.frpMin) continue
    if (conf[i] < filters.confMin) continue
    if (wantNight !== -1 && night[i] !== wantNight) continue
    const age = (fetchSec - tsSec[i]) / 86400
    if (age < timeRange[0] || age > timeRange[1]) continue
    best = i
    bestDistSq = distSq
  }
  return best === -1 ? null : best
}
