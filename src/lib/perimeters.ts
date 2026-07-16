import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { EONET_ICON_LAYER } from './eonetSymbols'

/**
 * US wildfire perimeters (Phase 5) from NIFC's public WFIGS "current
 * interagency perimeters" ArcGIS service — keyless, CORS-open GeoJSON with
 * server-side geometry simplification. EU (EFFIS/GWIS) has no comparable
 * public GeoJSON feed and stays a follow-up per the brief's §3.3.
 */

const NIFC_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query'

const PAGE = 1000
const MAX_PAGES = 5

export async function fetchPerimeters(): Promise<GeoJSON.FeatureCollection> {
  const features: GeoJSON.Feature[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      where: '1=1',
      outFields: 'poly_IncidentName,poly_GISAcres',
      maxAllowableOffset: '0.001', // ~100 m — plenty at map scale, slashes payload
      f: 'geojson',
      resultRecordCount: String(PAGE),
      resultOffset: String(page * PAGE),
    })
    const res = await fetch(`${NIFC_URL}?${q}`)
    if (!res.ok) throw new Error(`NIFC perimeters request failed (${res.status})`)
    const fc = (await res.json()) as GeoJSON.FeatureCollection & {
      properties?: { exceededTransferLimit?: boolean }
    }
    features.push(...(fc.features ?? []))
    if (!fc.properties?.exceededTransferLimit) break
  }
  return { type: 'FeatureCollection', features }
}

const SOURCE_ID = 'ember-perimeters'
const FILL_ID = 'ember-perimeters-fill'
const LINE_ID = 'ember-perimeters-line'

/** Idempotent native-layer sync — perimeters sit beneath the fire splats. */
export function syncPerimetersLayer(
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
    const anchor = map.getLayer(EONET_ICON_LAYER) ? EONET_ICON_LAYER : undefined
    if (!map.getLayer(FILL_ID)) {
      map.addLayer(
        {
          id: FILL_ID,
          type: 'fill',
          source: SOURCE_ID,
          paint: {
            'fill-color': 'rgba(249,115,22,0.10)',
            'fill-outline-color': 'rgba(0,0,0,0)',
          },
        },
        anchor,
      )
    }
    if (!map.getLayer(LINE_ID)) {
      map.addLayer(
        {
          id: LINE_ID,
          type: 'line',
          source: SOURCE_ID,
          paint: {
            'line-color': 'rgba(251,146,60,0.85)',
            'line-width': 1.4,
          },
        },
        anchor,
      )
    }
    map.setLayoutProperty(FILL_ID, 'visibility', visible ? 'visible' : 'none')
    map.setLayoutProperty(LINE_ID, 'visibility', visible ? 'visible' : 'none')
  } catch {
    // style mid-swap; the style.load handler re-syncs
  }
}
