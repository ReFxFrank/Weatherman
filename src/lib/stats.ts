import type { DecodedFire } from './types'
import { REGION_NAMES, regionOf } from './regions'

/**
 * CPU-side aggregate stats for the right-hand panel (§5.4).
 *
 * A point counts iff it passes the SAME predicate the GPU DataFilterExtension
 * applies in fireLayers.ts: frp ≥ frpMin, conf ≥ confMin, day/night match, and
 * ageDays within [timeRange[0], timeRange[1]] — so the headline number always
 * agrees with what is glowing on the map.
 */

export interface FireStats {
  /** detections passing all active filters, worldwide */
  shownTotal: number
  /** passing detections inside the current viewport bounds (null = unknown) */
  inView: number | null
  /** per-continent counts, sorted desc, zero buckets omitted; -1 bucket = 'Other' */
  byRegion: Array<{ name: string; count: number }>
  /** the five highest-FRP passing detections */
  topFrp: Array<{ index: number; frp: number; lon: number; lat: number }>
}

const TOP_N = 5

/**
 * The shared filter predicate (mirrors the GPU DataFilterExtension ranges).
 * computeFireStats keeps its own inlined copy for the hot loop — keep the two
 * in sync when filter semantics change.
 */
export function passesFireFilters(
  data: DecodedFire,
  i: number,
  filters: { frpMin: number; confMin: number; dayNight: 'all' | 'day' | 'night' },
  timeRange: [number, number],
  fetchSec: number,
): boolean {
  if (data.frp[i] < filters.frpMin) return false
  if (data.conf[i] < filters.confMin) return false
  if (filters.dayNight !== 'all' && data.night[i] !== (filters.dayNight === 'night' ? 1 : 0)) return false
  const age = (fetchSec - data.tsSec[i]) / 86400
  return age >= timeRange[0] && age <= timeRange[1]
}

export function computeFireStats(
  // runs on the FULL decoded payload, not the decimated render set — counts
  // and top-5 indices must reflect the truth, not the quality tier
  data: DecodedFire,
  filters: { frpMin: number; confMin: number; dayNight: 'all' | 'day' | 'night' },
  timeRange: [number, number],
  bounds: { west: number; south: number; east: number; north: number } | null,
): FireStats {
  const { count, positions, frp, tsSec, conf, night, meta } = data
  const fetchSec = Date.parse(meta.fetchedAt) / 1000
  const [ageNewest, ageOldest] = timeRange
  /** -1 = accept both, else the required night[] value */
  const wantNight = filters.dayNight === 'all' ? -1 : filters.dayNight === 'night' ? 1 : 0
  /** a viewport spanning the antimeridian reports west > east */
  const crossesAntimeridian = bounds !== null && bounds.west > bounds.east

  // region buckets: one per continent plus a trailing 'Other' (-1) slot
  const regionCounts = new Array<number>(REGION_NAMES.length + 1).fill(0)

  let shownTotal = 0
  let inView = 0
  /** indices of the top-FRP points so far, sorted descending by frp */
  const top: number[] = []

  for (let i = 0; i < count; i++) {
    const f = frp[i]
    if (f < filters.frpMin) continue
    if (conf[i] < filters.confMin) continue
    if (wantNight >= 0 && night[i] !== wantNight) continue
    const ageDays = (fetchSec - tsSec[i]) / 86400
    if (ageDays < ageNewest || ageDays > ageOldest) continue

    shownTotal++
    const lon = positions[i * 2]
    const lat = positions[i * 2 + 1]

    const r = regionOf(lon, lat)
    regionCounts[r === -1 ? REGION_NAMES.length : r]++

    if (bounds !== null && lat >= bounds.south && lat <= bounds.north) {
      const inLon = crossesAntimeridian
        ? lon >= bounds.west || lon <= bounds.east
        : lon >= bounds.west && lon <= bounds.east
      if (inLon) inView++
    }

    // tiny insertion pass — never sorts the full array
    if (top.length < TOP_N || f > frp[top[top.length - 1]]) {
      let k = top.length < TOP_N ? top.length : TOP_N - 1
      while (k > 0 && f > frp[top[k - 1]]) k--
      top.splice(k, 0, i)
      if (top.length > TOP_N) top.pop()
    }
  }

  const byRegion = regionCounts
    .map((c, r) => ({ name: r === REGION_NAMES.length ? 'Other' : REGION_NAMES[r], count: c }))
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count)

  const topFrp = top.map((i) => ({
    index: i,
    frp: frp[i],
    lon: positions[i * 2],
    lat: positions[i * 2 + 1],
  }))

  return { shownTotal, inView: bounds === null ? null : inView, byRegion, topFrp }
}
