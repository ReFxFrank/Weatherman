import type { GeoJSONSource, Map as MapLibreMap, PointLike } from 'maplibre-gl'
import type { SevereAlertProps, SeverePayload, SevereSelection } from './types'

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
        // lat/lon ride in properties too: queryRenderedFeatures returns
        // tile-quantized geometry, and the detail card must show the
        // report's exact reported position, not a few-km-off rounding
        properties: { rtype, mag: r.mag, location: r.location, state: r.state, time: r.time, lat: r.lat, lon: r.lon },
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

/** Clickable layers, in claim-priority order: reports (small, drawn on top)
 *  beat warnings beat watches — a report dot inside a warning polygon must
 *  select the report. Also used for the pointer-cursor hover affordance. */
export const SEVERE_CLICK_LAYERS = [
  'svr-reports-dot',
  'svr-reports-glow',
  'svr-warn-fill',
  'svr-watch-fill',
] as const

const CLICK_PAD_PX = 6

/** Resolve a map click on the severe globe to a selection (detail card).
 *  Queries with a small pixel pad so the tiny report dots are tappable. */
export function pickSevereFeature(
  map: MapLibreMap,
  point: { x: number; y: number },
): SevereSelection | null {
  let feats: ReturnType<MapLibreMap['queryRenderedFeatures']>
  try {
    const box: [PointLike, PointLike] = [
      [point.x - CLICK_PAD_PX, point.y - CLICK_PAD_PX],
      [point.x + CLICK_PAD_PX, point.y + CLICK_PAD_PX],
    ]
    feats = map.queryRenderedFeatures(box, {
      layers: SEVERE_CLICK_LAYERS.filter((l) => map.getLayer(l)),
    })
  } catch {
    return null // style mid-swap
  }
  for (const layerId of SEVERE_CLICK_LAYERS) {
    const f = feats.find((x) => x.layer.id === layerId)
    if (!f) continue
    const p = f.properties as Record<string, unknown>
    if (layerId.startsWith('svr-reports')) {
      const lat = Number(p.lat)
      const lon = Number(p.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
      return {
        type: 'report',
        rtype: p.rtype as 'torn' | 'wind' | 'hail',
        report: {
          time: String(p.time ?? ''),
          mag: String(p.mag ?? ''),
          location: String(p.location ?? ''),
          state: String(p.state ?? ''),
          lat,
          lon,
        },
      }
    }
    return {
      type: 'alert',
      props: {
        kind: p.kind as SevereAlertProps['kind'],
        event: String(p.event ?? ''),
        severity: typeof p.severity === 'string' ? p.severity : null,
        headline: typeof p.headline === 'string' ? p.headline : null,
        areaDesc: String(p.areaDesc ?? ''),
        onset: typeof p.onset === 'string' ? p.onset : null,
        expires: typeof p.expires === 'string' ? p.expires : null,
      },
    }
  }
  return null
}
