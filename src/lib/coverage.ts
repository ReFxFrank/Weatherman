import type { Map as MapLibreMap } from 'maplibre-gl'

/**
 * GLM coverage honesty (docs/DECISIONS.md): the two GOES satellites see the
 * Americas and adjacent oceans, not the planet. Dashed rings mark the
 * approximate field-of-view edge of each satellite so the empty longitudes
 * read as "no coverage", never "no lightning".
 *
 * The rings are spherical circles around each sub-satellite point. GLM's true
 * FOV is a rounded square; a 72° circle tracks the envelope of real detections
 * well enough for an honesty marker (labeled "approx" in the legend).
 */

const RADIUS_DEG = 72
const SUB_SAT_LONS = [-137.2, -75.2] // GOES-West, GOES-East

const DEG = Math.PI / 180

/** Points of a spherical circle around (lonCenter, 0), split at the antimeridian. */
function circleSegments(lonCenter: number): number[][][] {
  const rho = RADIUS_DEG * DEG
  const segments: number[][][] = []
  let current: number[][] = []
  let prevLon: number | null = null
  for (let deg = 0; deg <= 360; deg += 2) {
    const theta = deg * DEG
    const lat = Math.asin(Math.sin(rho) * Math.cos(theta)) / DEG
    let lon = lonCenter + Math.atan2(Math.sin(theta) * Math.sin(rho), Math.cos(rho)) / DEG
    lon = ((((lon + 180) % 360) + 360) % 360) - 180
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
      if (current.length > 1) segments.push(current)
      current = []
    }
    current.push([lon, lat])
    prevLon = lon
  }
  if (current.length > 1) segments.push(current)
  return segments
}

const COVERAGE_GEOJSON: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: SUB_SAT_LONS.map((lon) => ({
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'MultiLineString' as const, coordinates: circleSegments(lon) },
  })),
}

export const GLM_COVERAGE_LAYER = 'glm-coverage'

/** Idempotent create/refresh of the coverage rings (same pattern as the
 *  other native layers — style swaps wipe everything, so re-add freely). */
export function syncGlmCoverage(
  map: MapLibreMap,
  { beforeId, visible }: { beforeId?: string; visible: boolean },
): void {
  try {
    if (!map.getSource(GLM_COVERAGE_LAYER)) {
      map.addSource(GLM_COVERAGE_LAYER, { type: 'geojson', data: COVERAGE_GEOJSON })
    }
    if (!map.getLayer(GLM_COVERAGE_LAYER)) {
      map.addLayer(
        {
          id: GLM_COVERAGE_LAYER,
          type: 'line',
          source: GLM_COVERAGE_LAYER,
          paint: {
            'line-color': '#7dd3fc',
            'line-opacity': 0.22,
            'line-width': 1,
            'line-dasharray': [2, 3],
          },
        },
        beforeId && map.getLayer(beforeId) ? beforeId : undefined,
      )
    }
    map.setLayoutProperty(GLM_COVERAGE_LAYER, 'visibility', visible ? 'visible' : 'none')
  } catch {
    // best-effort during style swaps; the next sync pass recreates it
  }
}
