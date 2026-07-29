import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'

/**
 * Ring highlighting the selected detection (amber for fire, sky for
 * lightning) — a maplibre-native circle layer (globe-safe), re-synced after
 * style swaps like the other native layers.
 */
const SOURCE = 'ember-selection'
const LAYER = 'ember-selection-ring'

export function syncSelectionMarker(
  map: MapLibreMap,
  point: { lon: number; lat: number } | null,
  color = '#fcd34d',
) {
  try {
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: point
        ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [point.lon, point.lat] }, properties: {} }]
        : [],
    }
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: 'geojson', data })
    } else {
      ;(map.getSource(SOURCE) as GeoJSONSource).setData(data)
    }
    if (!map.getLayer(LAYER)) {
      map.addLayer({
        id: LAYER,
        type: 'circle',
        source: SOURCE,
        paint: {
          'circle-radius': 11,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': color,
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.95,
          'circle-pitch-alignment': 'map',
        },
      })
    } else {
      map.setPaintProperty(LAYER, 'circle-stroke-color', color)
    }
  } catch {
    // style mid-swap; the style.load handler re-syncs
  }
}
