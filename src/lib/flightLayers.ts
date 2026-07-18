import type { GeoJSONSource, Map as MapLibreMap, PointLike } from 'maplibre-gl'
import type { AircraftSelection, FlightsData } from './types'

/**
 * The flights globe's native layer stack (bottom → top):
 *
 * - flt-trail: the selected aircraft's flown path, accumulated client-side
 *   from successive snapshots and colored by altitude per segment (ADS-B
 *   carries no history, so the trail is what we've watched since selection).
 * - flt-plane: an SDF plane glyph per aircraft, rotated to its ground track
 *   and recolored by altitude (a warm→cool rainbow; grey on ground, red for
 *   an emergency). SDF so one icon tints per-feature.
 * - flt-label: a data block (callsign, then FL + speed when zoomed in),
 *   yielding to collision so a busy sky stays legible.
 *
 * Native MapLibre symbols (deck Icon/Text don't render under the globe
 * camera — see DECISIONS.md), anchored beneath the EONET reticle layer.
 * airplanes.live serves a ≤250 nm radius, so this is a regional, current-view
 * layer — blank space means no receiver coverage, not empty sky.
 */

const SRC = 'flt-aircraft'
const SRC_TRAIL = 'flt-trail-src'
const PLANE_IMAGE = 'ember-plane'

export const FLIGHT_LAYER_IDS = ['flt-trail', 'flt-plane', 'flt-label'] as const

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Altitude (ft) → color: an ADSBExchange-style warm→cool rainbow. */
const ALT_STOPS: Array<[number, [number, number, number]]> = [
  [0, [255, 99, 71]],
  [5000, [255, 165, 40]],
  [10000, [250, 224, 70]],
  [20000, [96, 214, 122]],
  [30000, [70, 200, 232]],
  [38000, [96, 150, 246]],
  [45000, [183, 148, 251]],
]

export function altColor(altFt: number | null, onGround: boolean, isEmergency = false): [number, number, number] {
  if (isEmergency) return [244, 63, 94]
  if (onGround) return [148, 163, 184]
  // airborne but no barometric altitude reported: a neutral slate-blue, NOT
  // the amber deck stop (which would imply ground level — review finding)
  if (altFt == null) return [100, 116, 139]
  const a = altFt
  const s = ALT_STOPS
  if (a <= s[0][0]) return s[0][1]
  if (a >= s[s.length - 1][0]) return s[s.length - 1][1]
  for (let i = 1; i < s.length; i++) {
    if (a <= s[i][0]) {
      const [a0, c0] = s[i - 1]
      const [a1, c1] = s[i]
      const t = (a - a0) / (a1 - a0)
      return [
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
      ]
    }
  }
  return s[s.length - 1][1]
}

const ALT_INTERP = [
  'interpolate',
  ['linear'],
  ['coalesce', ['get', 'altFt'], 0],
  ...ALT_STOPS.flatMap(([a, [r, g, b]]) => [a, `rgb(${r},${g},${b})`]),
]

/** emergency → red, ground → grey, airborne-no-altitude → neutral slate,
 *  else the altitude rainbow. */
const COLOR_EXPR = [
  'case',
  ['get', 'isEmergency'],
  'rgb(244,63,94)',
  ['get', 'onGround'],
  'rgb(148,163,184)',
  ['==', ['coalesce', ['get', 'altFt'], -1], -1],
  'rgb(100,116,139)',
  ALT_INTERP,
] as never

/** Top-down plane silhouette pointing up (north = track 0), as an SDF alpha
 *  mask so MapLibre can recolor it per-feature. Drawn at 2× for crispness. */
function planeImageData(): ImageData {
  const S = 64
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const ctx = c.getContext('2d')!
  ctx.translate(S / 2, S / 2)
  ctx.scale(S / 40, S / 40)
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  const pts: Array<[number, number]> = [
    [0, -16],
    [1.6, -7],
    [1.8, -3],
    [15, 4],
    [15, 6.5],
    [1.8, 3],
    [1.6, 9],
    [5.5, 13],
    [5.5, 15],
    [0, 12.5],
    [-5.5, 15],
    [-5.5, 13],
    [-1.6, 9],
    [-1.8, 3],
    [-15, 6.5],
    [-15, 4],
    [-1.8, -3],
    [-1.6, -7],
  ]
  ctx.moveTo(pts[0][0], pts[0][1])
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y)
  ctx.closePath()
  ctx.fill()
  return ctx.getImageData(0, 0, S, S)
}

/** Compact altitude/speed tag under the callsign (shown when zoomed in). */
function blockLabel(callsign: string, altFt: number | null, gsKt: number | null, onGround: boolean): string {
  const line1 = callsign
  const alt = onGround ? 'GND' : altFt != null ? `FL${Math.round(altFt / 100)}` : ''
  const spd = gsKt != null ? `${Math.round(gsKt)}kt` : ''
  const line2 = [alt, spd].filter(Boolean).join(' · ')
  return line2 ? `${line1}\n${line2}` : line1
}

function toFc(payload: FlightsData): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: payload.aircraft.map((a) => {
      const tag = a.flight || a.reg || a.hex.toUpperCase()
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: {
          hex: a.hex,
          track: a.track ?? 0,
          altFt: a.altFt,
          onGround: a.onGround,
          isEmergency: a.isEmergency,
          military: a.military,
          tag,
          block: blockLabel(tag, a.altFt, a.gsKt, a.onGround),
        },
      }
    }),
  }
}

/** Selected aircraft's accumulated path → per-segment lines (colored by the
 *  altitude at the older end), split at the antimeridian. */
function trailFc(points: Array<[number, number, number]> | null): GeoJSON.FeatureCollection {
  if (!points || points.length < 2) return EMPTY_FC
  const features: GeoJSON.Feature[] = []
  for (let i = 1; i < points.length; i++) {
    const [lon0, lat0, alt0] = points[i - 1]
    const [lon1, lat1] = points[i]
    if (Math.abs(lon1 - lon0) > 180) continue // dateline jump — skip the wrap chord
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[lon0, lat0], [lon1, lat1]] },
      properties: { altFt: alt0 },
    })
  }
  return { type: 'FeatureCollection', features }
}

let lastKey = ''

export function syncFlightLayers(
  map: MapLibreMap,
  payload: FlightsData | null,
  {
    beforeId,
    visible,
    selectedHex = null,
    trail = null,
    stale = false,
  }: {
    beforeId?: string
    visible: boolean
    selectedHex?: string | null
    trail?: Array<[number, number, number]> | null
    /** the feed is erroring while last-good planes are shown — dim them so a
     *  frozen snapshot never reads as live (review finding) */
    stale?: boolean
  },
): void {
  try {
    if (!map.getImage(PLANE_IMAGE)) map.addImage(PLANE_IMAGE, planeImageData(), { sdf: true, pixelRatio: 2 })
    const key = payload ? payload.fetchedAt : 'empty'
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: payload ? toFc(payload) : EMPTY_FC })
    else if (key !== lastKey) (map.getSource(SRC) as GeoJSONSource).setData(payload ? toFc(payload) : EMPTY_FC)
    lastKey = key
    // trail changes on selection + every poll — cheap (one plane), set each pass
    if (!map.getSource(SRC_TRAIL)) map.addSource(SRC_TRAIL, { type: 'geojson', data: trailFc(trail) })
    else (map.getSource(SRC_TRAIL) as GeoJSONSource).setData(trailFc(trail))

    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined
    const addOnce = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
      if (!map.getLayer((layer as { id: string }).id)) map.addLayer(layer, before)
    }

    // trail first so it renders beneath the planes
    addOnce({
      id: 'flt-trail',
      type: 'line',
      source: SRC_TRAIL,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ALT_INTERP as never,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 9, 3] as never,
        'line-opacity': stale ? 0.35 : 0.85,
      },
    })
    addOnce({
      id: 'flt-plane',
      type: 'symbol',
      source: SRC,
      layout: {
        'icon-image': PLANE_IMAGE,
        'icon-rotate': ['coalesce', ['get', 'track'], 0] as never,
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 7, 0.6, 11, 0.9] as never,
      },
      paint: { 'icon-color': COLOR_EXPR, 'icon-opacity': stale ? 0.4 : 0.95 },
    })
    addOnce({
      id: 'flt-label',
      type: 'symbol',
      source: SRC,
      minzoom: 7,
      layout: {
        // callsign only mid-zoom; full data block once zoomed in
        'text-field': ['step', ['zoom'], ['get', 'tag'], 8.5, ['get', 'block']] as never,
        'text-font': ['Montserrat Regular'],
        'text-size': 10,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': 'rgba(199, 210, 254, 0.95)',
        'text-halo-color': 'rgba(4, 10, 22, 0.95)',
        'text-halo-width': 1.3,
      },
    })

    // selected: enlarge + whiten. Emergency/military also enlarge so they read
    // at a glance across a busy field.
    const isSel = ['==', ['coalesce', ['get', 'hex'], ''], selectedHex ?? ' ']
    const emphasized = ['any', isSel, ['get', 'isEmergency'], ['get', 'military']]
    map.setLayoutProperty('flt-plane', 'icon-size', [
      'interpolate',
      ['linear'],
      ['zoom'],
      3, ['case', emphasized, 0.62, 0.4],
      7, ['case', emphasized, 0.9, 0.6],
      11, ['case', emphasized, 1.25, 0.9],
    ] as never)
    map.setPaintProperty('flt-plane', 'icon-color', ['case', isSel, 'rgb(248,250,252)', COLOR_EXPR] as never)
    // stale-dim re-applied every sync (addOnce paint only runs on creation)
    map.setPaintProperty('flt-plane', 'icon-opacity', stale ? 0.4 : 0.95)
    map.setPaintProperty('flt-trail', 'line-opacity', stale ? 0.35 : 0.85)

    for (const id of FLIGHT_LAYER_IDS) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  } catch {
    // best-effort during style swaps; the next sync pass recreates everything
  }
}

const CLICK_PAD_PX = 8

export const FLIGHT_CLICK_LAYERS = ['flt-plane'] as const

/** Resolve a click to the nearest aircraft in the pad (planes are small). */
export function pickAircraft(map: MapLibreMap, point: { x: number; y: number }): AircraftSelection | null {
  try {
    const box: [PointLike, PointLike] = [
      [point.x - CLICK_PAD_PX, point.y - CLICK_PAD_PX],
      [point.x + CLICK_PAD_PX, point.y + CLICK_PAD_PX],
    ]
    const feats = map.queryRenderedFeatures(box, { layers: FLIGHT_CLICK_LAYERS.filter((l) => map.getLayer(l)) })
    const hex = feats[0]?.properties?.hex
    return typeof hex === 'string' && hex ? { hex } : null
  } catch {
    return null
  }
}
