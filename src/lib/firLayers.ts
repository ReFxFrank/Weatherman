import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'

/**
 * European FIR (Flight Information Region) boundaries — faint dashed outlines
 * + names, drawn BENEATH the aircraft on the flights globe as geographic
 * context ("which control region"). Static reference geometry (Eurocontrol
 * atlas, MIT); clean-licensed global FIR data doesn't exist, so this is
 * Europe-only, said so in the legend. Native MapLibre layers, anchored beneath
 * the EONET reticle (and, by insertion order, beneath the plane layers).
 */

const SRC = 'fir-src'

export const FIR_LAYER_IDS = ['fir-line', 'fir-label'] as const

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

let lastN = -1

export function syncFirLayers(
  map: MapLibreMap,
  fc: GeoJSON.FeatureCollection | null,
  { beforeId, visible }: { beforeId?: string; visible: boolean },
): void {
  try {
    const data = fc ?? EMPTY_FC
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data })
    else if (data.features.length !== lastN) (map.getSource(SRC) as GeoJSONSource).setData(data)
    lastN = data.features.length

    const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined
    const addOnce = (layer: Parameters<MapLibreMap['addLayer']>[0]) => {
      if (!map.getLayer((layer as { id: string }).id)) map.addLayer(layer, before)
    }

    addOnce({
      id: 'fir-line',
      type: 'line',
      source: SRC,
      paint: {
        'line-color': '#818cf8',
        'line-opacity': 0.22,
        'line-width': 0.8,
        'line-dasharray': [3, 3],
      },
    })
    addOnce({
      id: 'fir-label',
      type: 'symbol',
      source: SRC,
      minzoom: 4.5,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Montserrat Regular'],
        'text-size': 9,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
        'text-max-width': 8,
      },
      paint: {
        'text-color': 'rgba(165, 180, 252, 0.45)',
        'text-halo-color': 'rgba(4, 10, 22, 0.9)',
        'text-halo-width': 1,
      },
    })

    for (const id of FIR_LAYER_IDS) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  } catch {
    // best-effort during style swaps; the next sync pass recreates everything
  }
}
