import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { DecodedFire } from './types'
import { passesFireFilters } from './stats'
import { TERMINATOR_ANCHOR } from './terminator'

/**
 * Country-level fire-count choropleth (Phase 5). Natural Earth 110m borders
 * (world-atlas TopoJSON, public domain) are lazy-loaded on first toggle;
 * counts are a CPU pass with a 5° grid index + ray-cast point-in-polygon.
 * Rendered as a maplibre fill layer beneath the terminator and fire layers.
 */

const SOURCE_ID = 'ember-choropleth'
const LAYER_ID = 'ember-choropleth-fill'
const CELL = 5 // degrees

interface CountryIndex {
  features: GeoJSON.Feature[]
  /** per-country [minLon, minLat, maxLon, maxLat] */
  bboxes: number[][]
  /** grid cell key → candidate country indices */
  grid: globalThis.Map<string, number[]>
}

let indexPromise: Promise<CountryIndex> | null = null

function ringsOf(geom: GeoJSON.Geometry): number[][][][] {
  if (geom.type === 'Polygon') return [(geom as GeoJSON.Polygon).coordinates as unknown as number[][][]] as never
  if (geom.type === 'MultiPolygon') return (geom as GeoJSON.MultiPolygon).coordinates as unknown as number[][][][]
  return []
}

/** even-odd test across every ring (outer + holes) of every polygon */
function pointInCountry(geom: GeoJSON.Geometry, lon: number, lat: number): boolean {
  let inside = false
  for (const poly of ringsOf(geom)) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0]
        const yi = ring[i][1]
        const xj = ring[j][0]
        const yj = ring[j][1]
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside
        }
      }
    }
  }
  return inside
}

async function loadIndex(): Promise<CountryIndex> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const [{ feature }, world] = await Promise.all([
        import('topojson-client'),
        import('world-atlas/countries-110m.json'),
      ])
      const topo = world.default as unknown as Parameters<typeof feature>[0]
      const countries = (topo as unknown as { objects: { countries: Parameters<typeof feature>[1] } })
        .objects.countries
      const fc = feature(topo, countries) as unknown as GeoJSON.FeatureCollection
      const features = fc.features
      const bboxes: number[][] = []
      const grid = new globalThis.Map<string, number[]>()
      features.forEach((f, idx) => {
        let minLon = 180
        let maxLon = -180
        let minLat = 90
        let maxLat = -90
        for (const poly of ringsOf(f.geometry)) {
          for (const [lon, lat] of poly[0]) {
            if (lon < minLon) minLon = lon
            if (lon > maxLon) maxLon = lon
            if (lat < minLat) minLat = lat
            if (lat > maxLat) maxLat = lat
          }
        }
        bboxes.push([minLon, minLat, maxLon, maxLat])
        for (let cx = Math.floor(minLon / CELL); cx <= Math.floor(maxLon / CELL); cx++) {
          for (let cy = Math.floor(minLat / CELL); cy <= Math.floor(maxLat / CELL); cy++) {
            const key = `${cx}:${cy}`
            const list = grid.get(key)
            if (list) list.push(idx)
            else grid.set(key, [idx])
          }
        }
      })
      return { features, bboxes, grid }
    })()
  }
  return indexPromise
}

/** Count filtered detections per country → FeatureCollection with `count`. */
export async function computeChoropleth(
  data: DecodedFire,
  filters: { frpMin: number; confMin: number; dayNight: 'all' | 'day' | 'night' },
  timeRange: [number, number],
): Promise<GeoJSON.FeatureCollection> {
  const { features, bboxes, grid } = await loadIndex()
  const counts = new Uint32Array(features.length)
  const fetchSec = Math.floor(Date.parse(data.meta.fetchedAt) / 1000)

  for (let i = 0; i < data.count; i++) {
    if (!passesFireFilters(data, i, filters, timeRange, fetchSec)) continue
    const lon = data.positions[i * 2]
    const lat = data.positions[i * 2 + 1]
    const candidates = grid.get(`${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`)
    if (!candidates) continue
    for (const c of candidates) {
      const b = bboxes[c]
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue
      if (pointInCountry(features[c].geometry, lon, lat)) {
        counts[c]++
        break
      }
    }
  }

  return {
    type: 'FeatureCollection',
    features: features
      .map((f, idx) => ({
        ...f,
        properties: { ...f.properties, count: counts[idx] },
      }))
      .filter((f) => (f.properties as { count: number }).count > 0),
  }
}

/** Idempotent native-layer sync, anchored beneath the terminator bands. */
export function syncChoroplethLayer(
  map: MapLibreMap,
  fc: GeoJSON.FeatureCollection | null,
  visible: boolean,
) {
  try {
    const data = fc ?? { type: 'FeatureCollection' as const, features: [] }
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: 'geojson', data })
    } else {
      ;(map.getSource(SOURCE_ID) as GeoJSONSource).setData(data)
    }
    if (!map.getLayer(LAYER_ID)) {
      const anchor = map.getLayer(TERMINATOR_ANCHOR) ? TERMINATOR_ANCHOR : undefined
      map.addLayer(
        {
          id: LAYER_ID,
          type: 'fill',
          source: SOURCE_ID,
          paint: {
            'fill-color': [
              'step',
              ['get', 'count'],
              'rgba(0,0,0,0)',
              1, 'rgba(127,29,29,0.20)',
              100, 'rgba(220,38,38,0.24)',
              1000, 'rgba(245,158,11,0.26)',
              10000, 'rgba(253,224,71,0.30)',
            ] as never,
            'fill-outline-color': 'rgba(245,158,11,0.25)',
          },
        },
        anchor,
      )
    }
    map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none')
  } catch {
    // style mid-swap; the style.load handler re-syncs
  }
}
