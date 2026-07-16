import type { DecodedFire } from './types'
import { passesFireFilters } from './stats'

/**
 * CSV / GeoJSON export of the current view (Phase 5): the detections that are
 * actually visible — active filters + time window + viewport bounds — from
 * the full decoded payload.
 */

const MAX_ROWS = 250_000
const CONF_LABEL = ['low', 'nominal', 'high']

export interface ExportResult {
  count: number
  truncated: boolean
}

export function exportView(
  format: 'csv' | 'geojson',
  data: DecodedFire,
  filters: { frpMin: number; confMin: number; dayNight: 'all' | 'day' | 'night' },
  timeRange: [number, number],
  bounds: { west: number; south: number; east: number; north: number } | null,
): ExportResult {
  const fetchSec = Math.floor(Date.parse(data.meta.fetchedAt) / 1000)
  const crosses = bounds !== null && bounds.west > bounds.east

  const indices: number[] = []
  let truncated = false
  for (let i = 0; i < data.count; i++) {
    if (!passesFireFilters(data, i, filters, timeRange, fetchSec)) continue
    if (bounds) {
      const lat = data.positions[i * 2 + 1]
      if (lat < bounds.south || lat > bounds.north) continue
      const lon = data.positions[i * 2]
      const inLon = crosses ? lon >= bounds.west || lon <= bounds.east : lon >= bounds.west && lon <= bounds.east
      if (!inLon) continue
    }
    if (indices.length >= MAX_ROWS) {
      truncated = true
      break
    }
    indices.push(i)
  }

  const iso = (i: number) => new Date(data.tsSec[i] * 1000).toISOString()
  let blob: Blob
  if (format === 'csv') {
    const lines = ['latitude,longitude,acq_datetime_utc,frp_mw,brightness_k,confidence,daynight,source']
    for (const i of indices) {
      lines.push(
        `${data.positions[i * 2 + 1]},${data.positions[i * 2]},${iso(i)},${data.frp[i]},` +
          `${data.bright[i]},${CONF_LABEL[data.conf[i]] ?? 'nominal'},${data.night[i] ? 'N' : 'D'},${data.meta.source}`,
      )
    }
    blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  } else {
    const features = indices.map((i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [data.positions[i * 2], data.positions[i * 2 + 1]],
      },
      properties: {
        acq_datetime_utc: iso(i),
        frp_mw: data.frp[i],
        brightness_k: data.bright[i],
        confidence: CONF_LABEL[data.conf[i]] ?? 'nominal',
        daynight: data.night[i] ? 'N' : 'D',
        source: data.meta.source,
      },
    }))
    blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features })], {
      type: 'application/geo+json',
    })
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', 'T')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `ember_${data.meta.source}_${stamp}Z.${format === 'csv' ? 'csv' : 'geojson'}`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)

  return { count: indices.length, truncated }
}
