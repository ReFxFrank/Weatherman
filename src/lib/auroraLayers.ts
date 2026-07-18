import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { AuroraPayload } from './types'

/**
 * The aurora globe's native layer stack — a soft glowing field, not discrete
 * marks:
 *
 * - aur-glow: wide, heavily-blurred green circles whose color and opacity
 *   climb with forecast probability. At a ~1° grid the blurred discs overlap
 *   into a continuous auroral-oval band around each magnetic pole; a gentle
 *   shimmer (setAuroraShimmer, driven by the EmberMap rAF) makes it breathe.
 * - aur-core: a tighter, brighter inner disc on the higher-probability cells,
 *   giving the oval a luminous ridge.
 *
 * Display-only, like the lightning globe: the OVATION output is a continuous
 * probability field, so there's nothing discrete to click. All native
 * MapLibre layers (a few thousand points of JSON), anchored beneath the EONET
 * reticle layer. Best read on the night side — aurora is only visible in the
 * dark, which is why it pairs with the terminator.
 */

const SRC_FIELD = 'aur-field'

export const AURORA_LAYER_IDS = ['aur-glow', 'aur-core'] as const

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Forecast probability → aurora green, dim → vivid → white-green. */
const PROB_STOPS: Array<[number, [number, number, number]]> = [
  [5, [20, 83, 45]],
  [20, [22, 163, 74]],
  [40, [34, 197, 94]],
  [60, [74, 222, 128]],
  [80, [163, 255, 200]],
  [100, [230, 255, 240]],
]

/** JS interpolator over PROB_STOPS (legend swatches). */
export function auroraColor(prob: number): [number, number, number] {
  const s = PROB_STOPS
  if (prob <= s[0][0]) return s[0][1]
  if (prob >= s[s.length - 1][0]) return s[s.length - 1][1]
  for (let i = 1; i < s.length; i++) {
    if (prob <= s[i][0]) {
      const [p0, c0] = s[i - 1]
      const [p1, c1] = s[i]
      const t = (prob - p0) / (p1 - p0)
      return [
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
      ]
    }
  }
  return s[s.length - 1][1]
}

const COLOR_EXPR = [
  'interpolate',
  ['linear'],
  ['get', 'prob'],
  ...PROB_STOPS.flatMap(([p, [r, g, b]]) => [p, `rgb(${r},${g},${b})`]),
] as never

/** Base per-cell opacity by probability (before the shimmer multiplier). The
 *  floor is lifted enough that even a quiet-night oval reads as a clear band,
 *  while brightness still climbs with probability (kept translucent so
 *  overlapping discs sum into a glow, not a flat wash). */
const GLOW_OPACITY = ['interpolate', ['linear'], ['get', 'prob'], 5, 0.11, 30, 0.3, 60, 0.45, 100, 0.6]
const CORE_OPACITY = ['interpolate', ['linear'], ['get', 'prob'], 25, 0, 55, 0.2, 100, 0.5]

let lastKey = ''

export function syncAuroraLayers(
  map: MapLibreMap,
  payload: AuroraPayload | null,
  { beforeId, visible }: { beforeId?: string; visible: boolean },
): void {
  try {
    const key = payload ? payload.forecastTime || payload.fetchedAt : 'empty'
    const fc = (): GeoJSON.FeatureCollection =>
      payload
        ? {
            type: 'FeatureCollection',
            features: payload.points.map(([lon, lat, prob]) => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [lon, lat] },
              properties: { prob },
            })),
          }
        : EMPTY_FC
    if (!map.getSource(SRC_FIELD)) map.addSource(SRC_FIELD, { type: 'geojson', data: fc() })
    else if (key !== lastKey) (map.getSource(SRC_FIELD) as GeoJSONSource).setData(fc())
    lastKey = key

    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined
    const addOnce = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
      if (!map.getLayer((layer as { id: string }).id)) map.addLayer(layer, before)
    }

    addOnce({
      id: 'aur-glow',
      type: 'circle',
      source: SRC_FIELD,
      paint: {
        'circle-color': COLOR_EXPR,
        'circle-opacity': GLOW_OPACITY as never,
        'circle-blur': 1,
        // radius must exceed the ~1° cell spacing so blurred discs overlap
        // into a continuous band; grows with zoom
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 7, 4, 15, 6, 26] as never,
      },
    })
    addOnce({
      id: 'aur-core',
      type: 'circle',
      source: SRC_FIELD,
      paint: {
        'circle-color': COLOR_EXPR,
        'circle-opacity': CORE_OPACITY as never,
        'circle-blur': 0.7,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 4, 8, 6, 14] as never,
      },
    })

    for (const id of AURORA_LAYER_IDS) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  } catch {
    // best-effort during style swaps; the next sync pass recreates everything
  }
}

const SHIMMER_PERIOD_MS = 6000

/** Gentle breathing of the whole field (a slow ±9% on the glow opacity),
 *  driven by the EmberMap rAF. Guarded so a style mid-swap is a no-op. */
export function setAuroraShimmer(map: MapLibreMap, nowMs: number): void {
  if (!map.getLayer('aur-glow')) return
  // 0.82–1.0 sine — subtle, never fully dims the oval
  const s = 0.91 + 0.09 * Math.sin((nowMs / SHIMMER_PERIOD_MS) * Math.PI * 2)
  try {
    map.setPaintProperty('aur-glow', 'circle-opacity', ['*', GLOW_OPACITY, s] as never)
  } catch {
    // layer vanished mid-swap; resync recreates it
  }
}
