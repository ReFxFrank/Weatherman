import type { GeoJSONSource, Map as MapLibreMap, PointLike } from 'maplibre-gl'
import type { QuakePayload, QuakeSelection } from './types'

/**
 * The earthquake globe's native layer stack (bottom → top):
 *
 * - Ripple: an expanding stroked ring on quakes from the last hour, animated
 *   as a synchronized "sonar ping" by the rAF in EmberMap (setQuakeRipplePhase)
 *   — the just-happened emphasis.
 * - Glow: a blurred, magnitude-scaled, magnitude-colored disc — the splat-like
 *   light so a great quake reads as a bloom from orbit.
 * - Core dot: a small solid centre with a dark halo for legibility.
 * - Label: "M6.4" for the rare significant events (M ≥ 6), like the hurricane
 *   heads — sparse, high-signal.
 *
 * All native MapLibre layers (a few hundred points of JSON — the columnar
 * binary splat format exists for the hundreds-of-thousands-of-points feeds,
 * same call as severe/hurricanes), anchored beneath the EONET reticle layer.
 */

const SRC_QUAKES = 'eq-quakes'

export const QUAKE_LAYER_IDS = ['eq-ripple', 'eq-glow', 'eq-dot', 'eq-label'] as const

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Quakes younger than this get a ripple. USGS all_day spans 24 h, so only
 *  the freshest handful ping — recency, not the whole field. */
const RIPPLE_MAX_AGE_MIN = 60

/** Magnitude → color: the classic seismic ramp (micro-slate → green → yellow
 *  → orange → rose → magenta → near-white for a great quake). Distinct from
 *  the other globes' palettes within any single view. */
const MAG_STOPS: Array<[number, [number, number, number]]> = [
  [0, [100, 116, 139]],
  [2.5, [74, 222, 128]],
  [4, [250, 204, 21]],
  [5, [251, 146, 60]],
  [6, [244, 63, 94]],
  [7, [232, 121, 249]],
  [8, [250, 232, 255]],
]

/** JS interpolator over MAG_STOPS (for the legend swatches). */
export function quakeColor(mag: number): [number, number, number] {
  const stops = MAG_STOPS
  if (mag <= stops[0][0]) return stops[0][1]
  if (mag >= stops[stops.length - 1][0]) return stops[stops.length - 1][1]
  for (let i = 1; i < stops.length; i++) {
    if (mag <= stops[i][0]) {
      const [m0, c0] = stops[i - 1]
      const [m1, c1] = stops[i]
      const t = (mag - m0) / (m1 - m0)
      return [
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
      ]
    }
  }
  return stops[stops.length - 1][1]
}

/** MapLibre color-interpolate over the same stops. */
const COLOR_EXPR = [
  'interpolate',
  ['linear'],
  ['get', 'mag'],
  ...MAG_STOPS.flatMap(([m, [r, g, b]]) => [m, `rgb(${r},${g},${b})`]),
] as never

/** Magnitude → base pixel radius (energy grows ~31× per unit, so the curve
 *  climbs fast). Scaled and zoom-adjusted per layer. */
const MAG_RADIUS = [
  'interpolate',
  ['linear'],
  ['get', 'mag'],
  0, 2, 2.5, 3.5, 4, 7, 5, 11, 6, 18, 7, 28, 8, 42,
]

/**
 * Full circle-radius expression: MAG_RADIUS × scale, grown a little with zoom.
 * MapLibre allows only ONE zoom-based interpolate per property and it must be
 * the outermost expression — so any per-feature factor (`extra`, e.g. the
 * selection emphasis) is folded INTO the stop outputs, never wrapped around
 * the whole thing (that raised "Only one zoom-based interpolate…").
 */
const radiusExpr = (scale: number, extra?: unknown) => {
  const at = (z: number) => {
    const base = ['*', MAG_RADIUS, scale * z]
    return extra === undefined ? base : ['*', base, extra]
  }
  return ['interpolate', ['linear'], ['zoom'], 1, at(1), 6, at(1.7)] as never
}

function quakesFc(payload: QuakePayload, nowMs: number): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: payload.quakes.map((q) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [q.lon, q.lat] },
      properties: {
        id: q.id,
        mag: q.mag,
        magLabel: `M${q.mag.toFixed(1)}`,
        ageMin: q.time > 0 ? (nowMs - q.time) / 60_000 : 1e9,
      },
    })),
  }
}

let lastKey = ''

export function syncQuakeLayers(
  map: MapLibreMap,
  payload: QuakePayload | null,
  {
    beforeId,
    visible,
    selectedId = null,
  }: { beforeId?: string; visible: boolean; selectedId?: string | null },
): void {
  try {
    // fetchedAt keys setData; the data thunk defers FeatureCollection building
    // (and the age computation) until a key change needs it (severe/hurricane
    // convention). Date.now() at build → ripple ages are current-ish (payload
    // refreshes every 60 s, the ripple window is 60 min).
    const key = payload ? payload.fetchedAt : 'empty'
    const ensureSource = (id: string, data: () => GeoJSON.FeatureCollection) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: data() })
      else if (key !== lastKey) (map.getSource(id) as GeoJSONSource).setData(data())
    }
    ensureSource(SRC_QUAKES, () => (payload ? quakesFc(payload, Date.now()) : EMPTY_FC))
    lastKey = key

    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined
    const addOnce = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
      if (!map.getLayer((layer as { id: string }).id)) map.addLayer(layer, before)
    }

    // Ripple ring — only recent quakes; radius/opacity are driven each frame by
    // setQuakeRipplePhase (starts as a resting ring until the rAF ticks).
    addOnce({
      id: 'eq-ripple',
      type: 'circle',
      source: SRC_QUAKES,
      filter: ['<', ['get', 'ageMin'], RIPPLE_MAX_AGE_MIN] as never,
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': COLOR_EXPR,
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.5,
        'circle-radius': radiusExpr(1),
      },
    })
    addOnce({
      id: 'eq-glow',
      type: 'circle',
      source: SRC_QUAKES,
      paint: {
        'circle-color': COLOR_EXPR,
        'circle-opacity': 0.28,
        'circle-blur': 1,
        'circle-radius': radiusExpr(1),
      },
    })
    addOnce({
      id: 'eq-dot',
      type: 'circle',
      source: SRC_QUAKES,
      paint: {
        'circle-color': COLOR_EXPR,
        'circle-opacity': 0.95,
        'circle-radius': radiusExpr(0.4),
        'circle-stroke-color': 'rgba(2, 6, 23, 0.85)',
        'circle-stroke-width': 0.8,
      },
    })
    addOnce({
      id: 'eq-label',
      type: 'symbol',
      source: SRC_QUAKES,
      filter: ['>=', ['get', 'mag'], 6] as never,
      layout: {
        'text-field': ['get', 'magLabel'],
        'text-font': ['Montserrat Regular'],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
      },
      paint: {
        'text-color': 'rgba(250, 232, 255, 0.95)',
        'text-halo-color': 'rgba(4, 10, 22, 0.95)',
        'text-halo-width': 1.4,
      },
    })

    // selected quake: brighter, enlarged core (same idiom as the hurricane
    // head / EONET reticle emphasis). The 1.9× is folded into the radius
    // stop outputs, keeping a single top-level zoom interpolate.
    const isSel = ['==', ['coalesce', ['get', 'id'], ''], selectedId ?? ' ']
    map.setPaintProperty('eq-dot', 'circle-radius', radiusExpr(0.4, ['case', isSel, 1.9, 1]))
    map.setPaintProperty('eq-dot', 'circle-stroke-color', [
      'case',
      isSel,
      'rgba(248, 250, 252, 0.95)',
      'rgba(2, 6, 23, 0.85)',
    ] as never)
    map.setPaintProperty('eq-glow', 'circle-opacity', ['case', isSel, 0.5, 0.28] as never)

    for (const id of QUAKE_LAYER_IDS) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  } catch {
    // best-effort during style swaps; the next sync pass recreates everything
  }
}

/** How far a ripple expands past its resting radius, and its period. */
const RIPPLE_EXPAND = 2.6
const RIPPLE_PERIOD_MS = 2600

/** Drive the sonar-ping ripple from the EmberMap rAF: one global phase [0,1),
 *  so all recent quakes ping in sync. Cheap (two paint-prop sets), guarded so
 *  a style mid-swap (no layer yet) is a no-op until the next resync. */
export function setQuakeRipplePhase(map: MapLibreMap, nowMs: number): void {
  if (!map.getLayer('eq-ripple')) return
  const phase = (nowMs / RIPPLE_PERIOD_MS) % 1
  try {
    map.setPaintProperty('eq-ripple', 'circle-radius', [
      'interpolate',
      ['linear'],
      ['zoom'],
      1, ['*', MAG_RADIUS, 1 + phase * RIPPLE_EXPAND],
      6, ['*', MAG_RADIUS, (1 + phase * RIPPLE_EXPAND) * 1.7],
    ] as never)
    map.setPaintProperty('eq-ripple', 'circle-stroke-opacity', 0.6 * (1 - phase))
  } catch {
    // layer vanished mid-swap; resync recreates it
  }
}

/** Withdraw the ripple: on a USGS outage the payload is frozen, so the "struck
 *  in the last hour" ping would keep asserting recency it can no longer
 *  verify. The quakes still render (labeled stale by the chip); only the
 *  misleading animation stops. */
export function hideQuakeRipple(map: MapLibreMap): void {
  if (!map.getLayer('eq-ripple')) return
  try {
    map.setPaintProperty('eq-ripple', 'circle-stroke-opacity', 0)
  } catch {
    // layer vanished mid-swap; resync recreates it
  }
}

/** Clickable layers (the two circle layers — never the symbol label, whose
 *  queryRenderedFeatures can throw mid-glyph-load). pickQuakeFeature resolves
 *  ties by magnitude, not layer order, so this list is just the query scope. */
export const QUAKE_CLICK_LAYERS = ['eq-dot', 'eq-glow'] as const

const CLICK_PAD_PX = 6

/** Resolve a map click on the quake globe to a selection (detail card). When
 *  the pad covers several quakes, take the strongest (largest magnitude) —
 *  the one the eye is drawn to. */
export function pickQuakeFeature(
  map: MapLibreMap,
  point: { x: number; y: number },
): QuakeSelection | null {
  let feats: ReturnType<MapLibreMap['queryRenderedFeatures']>
  try {
    const box: [PointLike, PointLike] = [
      [point.x - CLICK_PAD_PX, point.y - CLICK_PAD_PX],
      [point.x + CLICK_PAD_PX, point.y + CLICK_PAD_PX],
    ]
    feats = map.queryRenderedFeatures(box, {
      layers: QUAKE_CLICK_LAYERS.filter((l) => map.getLayer(l)),
    })
  } catch {
    return null // style mid-swap
  }
  let best: { id: string; mag: number } | null = null
  for (const f of feats) {
    const p = f.properties as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id : null
    const mag = typeof p.mag === 'number' ? p.mag : -Infinity
    if (id && (!best || mag > best.mag)) best = { id, mag }
  }
  return best ? { id: best.id } : null
}
