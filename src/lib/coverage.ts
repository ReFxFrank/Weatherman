import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'

/**
 * Lightning coverage honesty (docs/DECISIONS.md): the geostationary sensors
 * see the Americas (GOES GLM) and Europe/Africa (Meteosat MTG-LI when
 * configured), not the planet. Dashed rings mark the approximate
 * field-of-view edge of each satellite in the current payload, so the empty
 * longitudes read as "no coverage", never "no lightning". A ring whose
 * satellite is dark restyles red — "covered but currently blind".
 *
 * The rings are spherical circles around each sub-satellite point. The true
 * FOVs are rounded squares; the 64° radius matches the measured envelope of
 * real GLM detections (histogram over 45 live granules: dense to ~63°, zero
 * beyond 65° — review-measured). MTG-LI's disk geometry is equivalent, so it
 * uses the same radius until its own envelope is measured.
 */

const RADIUS_DEG = 64
const DEG = Math.PI / 180

export interface CoverageSat {
  lonSubSat: number
  dark: boolean
}

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

function coverageGeojson(sats: CoverageSat[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: sats.map((s) => ({
      type: 'Feature' as const,
      properties: { dark: Boolean(s.dark) },
      geometry: { type: 'MultiLineString' as const, coordinates: circleSegments(s.lonSubSat) },
    })),
  }
}

export const GLM_COVERAGE_LAYER = 'glm-coverage'

let lastKey = ''

/** Idempotent create/refresh of the coverage rings (same pattern as the
 *  other native layers — style swaps wipe everything, so re-add freely). */
export function syncGlmCoverage(
  map: MapLibreMap,
  { beforeId, visible, sats = [] }: { beforeId?: string; visible: boolean; sats?: CoverageSat[] },
): void {
  try {
    const keyNow = sats.map((s) => `${s.lonSubSat}:${s.dark ? 1 : 0}`).join(',')
    if (!map.getSource(GLM_COVERAGE_LAYER)) {
      map.addSource(GLM_COVERAGE_LAYER, { type: 'geojson', data: coverageGeojson(sats) })
      lastKey = keyNow
    } else if (keyNow !== lastKey) {
      ;(map.getSource(GLM_COVERAGE_LAYER) as GeoJSONSource).setData(coverageGeojson(sats))
      lastKey = keyNow
    }
    if (!map.getLayer(GLM_COVERAGE_LAYER)) {
      map.addLayer(
        {
          id: GLM_COVERAGE_LAYER,
          type: 'line',
          source: GLM_COVERAGE_LAYER,
          paint: {
            'line-color': ['case', ['get', 'dark'], '#f87171', '#7dd3fc'] as never,
            'line-opacity': ['case', ['get', 'dark'], 0.3, 0.22] as never,
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
