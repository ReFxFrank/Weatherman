import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { FlightRoute } from './types'

/**
 * The selected aircraft's SCHEDULED route (origin → destination), from adsbdb.
 * Drawn as a great-circle arc + airport endpoints, above the trail and beneath
 * the plane glyphs. This is the scheduled path from a route database, NOT the
 * ADS-B-broadcast track — labeled that way in the card/legend.
 */

const SRC_LINE = 'fr-route-src'
const SRC_AP = 'fr-airport-src'

export const ROUTE_LAYER_IDS = ['fr-route', 'fr-airport-dot', 'fr-airport-label'] as const

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI

/** Great-circle interpolation between two lon/lat points (n segments). */
function greatCircle(lon1: number, lat1: number, lon2: number, lat2: number, n = 96): Array<[number, number]> {
  const φ1 = toRad(lat1)
  const λ1 = toRad(lon1)
  const φ2 = toRad(lat2)
  const λ2 = toRad(lon2)
  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2),
      ),
    )
  if (d === 0) return [[lon1, lat1]]
  const out: Array<[number, number]> = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2)
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2)
    const z = A * Math.sin(φ1) + B * Math.sin(φ2)
    out.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.hypot(x, y)))])
  }
  return out
}

/** Split the arc where consecutive points cross the antimeridian, so the line
 *  doesn't draw a wrap-around chord across the globe. */
function routeLineFc(route: FlightRoute | null): GeoJSON.FeatureCollection {
  if (!route) return EMPTY_FC
  const pts = greatCircle(route.origin.lon, route.origin.lat, route.destination.lon, route.destination.lat)
  const runs: Array<Array<[number, number]>> = []
  let run: Array<[number, number]> = []
  for (const p of pts) {
    if (run.length && Math.abs(p[0] - run[run.length - 1][0]) > 180) {
      runs.push(run)
      run = []
    }
    run.push(p)
  }
  runs.push(run)
  return {
    type: 'FeatureCollection',
    features: runs
      .filter((r) => r.length >= 2)
      .map((r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r }, properties: {} })),
  }
}

function airportFc(route: FlightRoute | null): GeoJSON.FeatureCollection {
  if (!route) return EMPTY_FC
  return {
    type: 'FeatureCollection',
    features: [route.origin, route.destination].map((a) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      properties: { code: a.iata || a.icao },
    })),
  }
}

let lastKey = ''

export function syncRouteLayers(
  map: MapLibreMap,
  route: FlightRoute | null,
  { beforeId, visible }: { beforeId?: string; visible: boolean },
): void {
  try {
    // key on coordinates (always present + unique), NOT the ICAO codes, which
    // can both be empty ("-" collides across different routes → a stale arc
    // survives a cached plane-to-plane switch; review finding)
    const key = route
      ? `${route.origin.lon},${route.origin.lat}-${route.destination.lon},${route.destination.lat}`
      : 'empty'
    const ensure = (id: string, data: () => GeoJSON.FeatureCollection) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: data() })
      else if (key !== lastKey) (map.getSource(id) as GeoJSONSource).setData(data())
    }
    ensure(SRC_LINE, () => routeLineFc(route))
    ensure(SRC_AP, () => airportFc(route))
    lastKey = key

    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined
    const addOnce = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
      if (!map.getLayer((layer as { id: string }).id)) map.addLayer(layer, before)
    }

    addOnce({
      id: 'fr-route',
      type: 'line',
      source: SRC_LINE,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': '#a5b4fc',
        'line-opacity': 0.7,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 2] as never,
        'line-dasharray': [2, 2],
      },
    })
    addOnce({
      id: 'fr-airport-dot',
      type: 'circle',
      source: SRC_AP,
      paint: {
        'circle-color': '#e0e7ff',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 8, 4.5] as never,
        'circle-stroke-color': '#6366f1',
        'circle-stroke-width': 1.5,
      },
    })
    addOnce({
      id: 'fr-airport-label',
      type: 'symbol',
      source: SRC_AP,
      layout: {
        'text-field': ['get', 'code'],
        'text-font': ['Montserrat Regular'],
        'text-size': 10,
        'text-offset': [0, -1.2],
        'text-anchor': 'bottom',
      },
      paint: {
        'text-color': 'rgba(224, 231, 255, 0.95)',
        'text-halo-color': 'rgba(4, 10, 22, 0.95)',
        'text-halo-width': 1.4,
      },
    })

    for (const id of ROUTE_LAYER_IDS) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  } catch {
    // best-effort during style swaps; the next sync pass recreates everything
  }
}
