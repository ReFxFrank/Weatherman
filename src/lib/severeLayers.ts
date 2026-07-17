import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { SeverePayload } from './types'

/**
 * The severe-weather globe's native layer stack (bottom → top):
 *
 * - SPC Day-1 categorical outlook: dim translucent risk shading, using the
 *   official SPC category colors shipped in the feed's own properties.
 * - Watches (tornado / severe thunderstorm): dashed outlines + faint fill —
 *   "conditions are favorable" areas, zone-based.
 * - Warnings: bright filled storm polygons — tornado red, severe amber —
 *   the "it is happening now" tier.
 * - SPC storm reports (today): small glowing points — tornado red, wind
 *   blue, hail white — ground truth of what already occurred.
 *
 * All native MapLibre layers (polygons + a few hundred points — deck splats
 * would be overkill), anchored beneath the EONET reticle layer like every
 * other native stack so ordering stays deterministic across globes.
 */

const SRC_OUTLOOK = 'svr-outlook'
const SRC_ALERTS = 'svr-alerts'
const SRC_REPORTS = 'svr-reports'

export const SEVERE_LAYER_IDS = [
  'svr-outlook-fill',
  'svr-outlook-line',
  'svr-watch-fill',
  'svr-watch-line',
  'svr-warn-fill',
  'svr-warn-line',
  'svr-reports-glow',
  'svr-reports-dot',
] as const

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

function reportsFc(p: SeverePayload): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const [rtype, list] of Object.entries(p.reports)) {
    for (const r of list) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: { rtype, mag: r.mag, location: r.location, state: r.state, time: r.time },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

const WATCH_FILTER = ['in', ['get', 'kind'], ['literal', ['tornado-watch', 'severe-watch']]]
const WARN_FILTER = ['in', ['get', 'kind'], ['literal', ['tornado-warning', 'severe-warning']]]
const TORNADO_RED = '#f87171'
const SEVERE_AMBER = '#fbbf24'
const kindColor = (tornado: string, severe: string) =>
  ['case', ['in', 'tornado', ['get', 'kind']], tornado, severe] as never

let lastKey = ''

export function syncSevereLayers(
  map: MapLibreMap,
  payload: SeverePayload | null,
  { beforeId, visible }: { beforeId?: string; visible: boolean },
): void {
  try {
    // renderKey re-keys between fetches when the client filters expired
    // alerts out; data thunks defer FeatureCollection building until a key
    // change actually needs it (review findings)
    const key = payload ? (payload.renderKey ?? payload.fetchedAt) : 'empty'
    const ensureSource = (id: string, data: () => GeoJSON.FeatureCollection) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: data() })
      else if (key !== lastKey) (map.getSource(id) as GeoJSONSource).setData(data())
    }
    ensureSource(SRC_OUTLOOK, () => payload?.outlook ?? EMPTY_FC)
    ensureSource(SRC_ALERTS, () => payload?.alerts ?? EMPTY_FC)
    ensureSource(SRC_REPORTS, () => (payload ? reportsFc(payload) : EMPTY_FC))
    lastKey = key

    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined
    const addOnce = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
      if (!map.getLayer((layer as { id: string }).id)) map.addLayer(layer, before)
    }

    addOnce({
      id: 'svr-outlook-fill',
      type: 'fill',
      source: SRC_OUTLOOK,
      paint: { 'fill-color': ['get', 'fill'] as never, 'fill-opacity': 0.12 },
    })
    addOnce({
      id: 'svr-outlook-line',
      type: 'line',
      source: SRC_OUTLOOK,
      paint: { 'line-color': ['get', 'stroke'] as never, 'line-opacity': 0.4, 'line-width': 1 },
    })
    addOnce({
      id: 'svr-watch-fill',
      type: 'fill',
      source: SRC_ALERTS,
      filter: WATCH_FILTER as never,
      paint: { 'fill-color': kindColor(TORNADO_RED, SEVERE_AMBER), 'fill-opacity': 0.06 },
    })
    addOnce({
      id: 'svr-watch-line',
      type: 'line',
      source: SRC_ALERTS,
      filter: WATCH_FILTER as never,
      paint: {
        'line-color': kindColor(TORNADO_RED, SEVERE_AMBER),
        'line-opacity': 0.75,
        'line-width': 1.4,
        'line-dasharray': [3, 2],
      },
    })
    addOnce({
      id: 'svr-warn-fill',
      type: 'fill',
      source: SRC_ALERTS,
      filter: WARN_FILTER as never,
      paint: {
        'fill-color': kindColor('#ef4444', '#f59e0b'),
        'fill-opacity': ['case', ['in', 'tornado', ['get', 'kind']], 0.32, 0.18] as never,
      },
    })
    addOnce({
      id: 'svr-warn-line',
      type: 'line',
      source: SRC_ALERTS,
      filter: WARN_FILTER as never,
      paint: {
        'line-color': kindColor('#ef4444', '#f59e0b'),
        'line-opacity': 0.95,
        'line-width': 2,
      },
    })
    const reportColor = [
      'match',
      ['get', 'rtype'],
      'torn',
      TORNADO_RED,
      'wind',
      '#60a5fa',
      '#e2e8f0',
    ] as never
    addOnce({
      id: 'svr-reports-glow',
      type: 'circle',
      source: SRC_REPORTS,
      paint: {
        'circle-color': reportColor,
        'circle-opacity': 0.35,
        'circle-blur': 1,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 5, 6, 10] as never,
      },
    })
    addOnce({
      id: 'svr-reports-dot',
      type: 'circle',
      source: SRC_REPORTS,
      paint: {
        'circle-color': reportColor,
        'circle-opacity': 0.9,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.6, 6, 3.5] as never,
      },
    })

    for (const id of SEVERE_LAYER_IDS) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  } catch {
    // best-effort during style swaps; the next sync pass recreates everything
  }
}
