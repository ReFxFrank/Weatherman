import type { GeoJSONSource, Map as MapLibreMap, PointLike } from 'maplibre-gl'
import type { ActiveStorm, ForecastPointProps, GlobalStorm, HurricanePayload, HurricaneSelection } from './types'

/**
 * The hurricanes globe's native layer stack (bottom → top):
 *
 * - Forecast cone: translucent violet fill + line. The cone is the probable
 *   path of the storm CENTER (NHC: ~2/3 of historical track errors), NOT the
 *   extent of impacts — the legend says so explicitly.
 * - Past track: solid line, colored per-segment by Saffir-Simpson `ss`.
 * - EONET global tracks: thin sky-blue history lines for storms outside
 *   NHC's basins (W Pacific typhoons etc.), split at the antimeridian.
 * - Forecast track: dashed line + per-tau forecast points colored by
 *   predicted category (`ssnum`, with TD/TS split on 34 kt `maxwind`).
 * - Storm heads: glow + dot at each current position (NHC positions from
 *   CurrentStorms, EONET last-track-point for global storms) + always-on
 *   name·intensity labels.
 *
 * All native MapLibre layers (a handful of polygons/lines/points — same
 * rationale as the severe stack), anchored beneath the EONET reticle layer
 * so cross-globe ordering stays deterministic.
 */

const SRC_CONES = 'hur-cones'
const SRC_TRACKS = 'hur-tracks'
const SRC_POINTS = 'hur-points'
const SRC_PAST = 'hur-past'
const SRC_GLOBAL = 'hur-global'
const SRC_HEADS = 'hur-heads'

export const HURRICANE_LAYER_IDS = [
  'hur-cone-fill',
  'hur-cone-line',
  'hur-past-line',
  'hur-global-line',
  'hur-track-line',
  'hur-points-dot',
  'hur-head-glow',
  'hur-head-dot',
  'hur-head-label',
] as const

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Saffir-Simpson category colors (C1–C5) + sub-hurricane tiers. */
export const CAT = {
  td: '#94a3b8',
  ts: '#2dd4bf',
  c1: '#fbbf24',
  c2: '#fb923c',
  c3: '#f87171',
  c4: '#e879f9',
  c5: '#f0abfc',
}

/** kt → category color (Saffir-Simpson wind boundaries). */
export function intensityColor(kt: number): string {
  if (kt < 34) return CAT.td
  if (kt < 64) return CAT.ts
  if (kt < 83) return CAT.c1
  if (kt < 96) return CAT.c2
  if (kt < 113) return CAT.c3
  if (kt < 137) return CAT.c4
  return CAT.c5
}

/** ssnum/ss (1–5) → color, sub-hurricane fallback per `fallback`. */
const ssMatch = (prop: string, fallback: string) =>
  [
    'match',
    ['coalesce', ['get', prop], 0],
    1,
    CAT.c1,
    2,
    CAT.c2,
    3,
    CAT.c3,
    4,
    CAT.c4,
    5,
    CAT.c5,
    fallback,
  ] as never

/** Forecast points: category when ssnum ≥ 1, else TD/TS split on 34 kt. */
const POINT_COLOR = [
  'case',
  ['>=', ['coalesce', ['get', 'ssnum'], 0], 1],
  ssMatch('ssnum', CAT.ts),
  ['>=', ['coalesce', ['get', 'maxwind'], 0], 34],
  CAT.ts,
  CAT.td,
] as never

function headsFc(storms: ActiveStorm[], global: GlobalStorm[]): GeoJSON.FeatureCollection {
  // selKey: stable click/highlight key — NHC id for NHC storms, EONET title
  // for global storms (EONET events carry no id in the payload)
  const features: GeoJSON.Feature[] = storms.map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: {
      kind: 'nhc',
      selKey: s.id,
      color: intensityColor(s.intensityKt),
      label: `${s.name.toUpperCase()} · ${s.intensityKt}KT`,
    },
  }))
  for (const g of global) {
    const last = g.track[g.track.length - 1]
    if (!last) continue
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [last[0], last[1]] },
      properties: { kind: 'global', selKey: g.title, color: '#7dd3fc', label: g.title.toUpperCase() },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** EONET history lines, split where a segment jumps across the antimeridian. */
function globalTracksFc(global: GlobalStorm[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (const g of global) {
    const runs: Array<Array<[number, number]>> = []
    let run: Array<[number, number]> = []
    for (const [lon, lat] of g.track) {
      if (run.length && Math.abs(lon - run[run.length - 1][0]) > 180) {
        // interpolate the crossing point onto ±180 so the dateline segment
        // draws on both sides instead of leaving a gap (review finding)
        const [lon1, lat1] = run[run.length - 1]
        const bound = lon1 > 0 ? 180 : -180
        const lonUnwrapped = lon + (lon1 > 0 ? 360 : -360)
        const t = (bound - lon1) / (lonUnwrapped - lon1)
        const latX = lat1 + t * (lat - lat1)
        run.push([bound, latX])
        runs.push(run)
        run = [[-bound, latX]]
      }
      run.push([lon, lat])
    }
    runs.push(run)
    for (const r of runs) {
      if (r.length < 2) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r },
        properties: { title: g.title },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

let lastKey = ''

export function syncHurricaneLayers(
  map: MapLibreMap,
  payload: HurricanePayload | null,
  {
    beforeId,
    visible,
    selectedKey = null,
  }: { beforeId?: string; visible: boolean; selectedKey?: string | null },
): void {
  try {
    // Same conventions as the severe stack: fetchedAt keys setData, data
    // thunks defer FeatureCollection building until a key change needs it.
    const key = payload ? payload.fetchedAt : 'empty'
    const ensureSource = (id: string, data: () => GeoJSON.FeatureCollection) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: data() })
      else if (key !== lastKey) (map.getSource(id) as GeoJSONSource).setData(data())
    }
    ensureSource(SRC_CONES, () => payload?.cones ?? EMPTY_FC)
    ensureSource(SRC_TRACKS, () => payload?.tracks ?? EMPTY_FC)
    ensureSource(SRC_POINTS, () => payload?.points ?? EMPTY_FC)
    ensureSource(SRC_PAST, () => payload?.pastTracks ?? EMPTY_FC)
    ensureSource(SRC_GLOBAL, () => (payload ? globalTracksFc(payload.global) : EMPTY_FC))
    ensureSource(SRC_HEADS, () => (payload ? headsFc(payload.storms, payload.global) : EMPTY_FC))
    lastKey = key

    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined
    const addOnce = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
      if (!map.getLayer((layer as { id: string }).id)) map.addLayer(layer, before)
    }

    addOnce({
      id: 'hur-cone-fill',
      type: 'fill',
      source: SRC_CONES,
      paint: { 'fill-color': '#a78bfa', 'fill-opacity': 0.08 },
    })
    addOnce({
      id: 'hur-cone-line',
      type: 'line',
      source: SRC_CONES,
      paint: { 'line-color': '#c4b5fd', 'line-opacity': 0.55, 'line-width': 1.2 },
    })
    addOnce({
      id: 'hur-past-line',
      type: 'line',
      source: SRC_PAST,
      paint: {
        'line-color': ssMatch('ss', CAT.td),
        'line-opacity': 0.55,
        'line-width': 1.4,
      },
    })
    addOnce({
      id: 'hur-global-line',
      type: 'line',
      source: SRC_GLOBAL,
      paint: { 'line-color': '#7dd3fc', 'line-opacity': 0.45, 'line-width': 1.1 },
    })
    addOnce({
      id: 'hur-track-line',
      type: 'line',
      source: SRC_TRACKS,
      paint: {
        'line-color': '#e9d5ff',
        'line-opacity': 0.85,
        'line-width': 1.6,
        'line-dasharray': [2, 2],
      },
    })
    addOnce({
      id: 'hur-points-dot',
      type: 'circle',
      source: SRC_POINTS,
      paint: {
        'circle-color': POINT_COLOR,
        'circle-opacity': 0.95,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 2.4, 6, 4.5] as never,
        'circle-stroke-color': 'rgba(2, 6, 23, 0.85)',
        'circle-stroke-width': 1,
      },
    })
    addOnce({
      id: 'hur-head-glow',
      type: 'circle',
      source: SRC_HEADS,
      filter: ['==', ['get', 'kind'], 'nhc'] as never,
      paint: {
        'circle-color': ['get', 'color'] as never,
        'circle-opacity': 0.45,
        'circle-blur': 1,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 9, 6, 16] as never,
      },
    })
    addOnce({
      id: 'hur-head-dot',
      type: 'circle',
      source: SRC_HEADS,
      paint: {
        'circle-color': ['get', 'color'] as never,
        'circle-opacity': 1,
        'circle-radius': ['case', ['==', ['get', 'kind'], 'nhc'], 4.5, 3] as never,
        'circle-stroke-color': 'rgba(232, 247, 255, 0.9)',
        'circle-stroke-width': 1.2,
      },
    })
    addOnce({
      id: 'hur-head-label',
      type: 'symbol',
      source: SRC_HEADS,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Montserrat Regular'],
        'text-size': 10.5,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-max-width': 14,
      },
      paint: {
        'text-color': 'rgba(233, 213, 255, 0.95)',
        'text-halo-color': 'rgba(4, 10, 22, 0.95)',
        'text-halo-width': 1.4,
      },
    })

    // selected storm head: enlarged dot + brighter glow (same expression
    // idiom as the EONET selected-reticle emphasis)
    const isSel = ['==', ['coalesce', ['get', 'selKey'], ''], selectedKey ?? ' ']
    map.setPaintProperty('hur-head-dot', 'circle-radius', [
      'case',
      isSel,
      7,
      ['case', ['==', ['get', 'kind'], 'nhc'], 4.5, 3],
    ] as never)
    map.setPaintProperty('hur-head-glow', 'circle-opacity', ['case', isSel, 0.75, 0.45] as never)

    for (const id of HURRICANE_LAYER_IDS) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  } catch {
    // best-effort during style swaps; the next sync pass recreates everything
  }
}

/** Clickable layers, in claim-priority order: storm heads (current position,
 *  richest card) beat forecast points. Labels select their storm too. Also
 *  used for the pointer-cursor hover affordance. */
export const HURRICANE_CLICK_LAYERS = [
  'hur-head-dot',
  'hur-head-glow',
  'hur-head-label',
  'hur-points-dot',
] as const

const CLICK_PAD_PX = 6

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Resolve a map click on the hurricanes globe to a selection (detail card). */
export function pickHurricaneFeature(
  map: MapLibreMap,
  point: { x: number; y: number },
): HurricaneSelection | null {
  let feats: ReturnType<MapLibreMap['queryRenderedFeatures']>
  try {
    const box: [PointLike, PointLike] = [
      [point.x - CLICK_PAD_PX, point.y - CLICK_PAD_PX],
      [point.x + CLICK_PAD_PX, point.y + CLICK_PAD_PX],
    ]
    feats = map.queryRenderedFeatures(box, {
      layers: HURRICANE_CLICK_LAYERS.filter((l) => map.getLayer(l)),
    })
  } catch {
    return null // style mid-swap
  }
  for (const layerId of HURRICANE_CLICK_LAYERS) {
    const f = feats.find((x) => x.layer.id === layerId)
    if (!f) continue
    const p = f.properties as Record<string, unknown>
    if (layerId.startsWith('hur-head')) {
      const selKey = str(p.selKey)
      if (!selKey) return null
      return p.kind === 'nhc' ? { type: 'storm', id: selKey } : { type: 'global', title: selKey }
    }
    const props: ForecastPointProps = {
      stormname: str(p.stormname),
      datelbl: str(p.datelbl),
      validtime: str(p.validtime),
      tau: num(p.tau),
      maxwind: num(p.maxwind),
      gust: num(p.gust),
      mslp: num(p.mslp),
      ssnum: num(p.ssnum),
      advisnum: typeof p.advisnum === 'number' ? String(p.advisnum) : str(p.advisnum),
      basin: str(p.basin),
    }
    return { type: 'forecast', props }
  }
  return null
}
