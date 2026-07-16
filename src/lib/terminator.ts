import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'

/**
 * Real-time day/night terminator (§5.7): three nested night polygons at sun
 * depressions of 0° (civil dusk edge), 6° and 12°, rendered as MapLibre fill
 * layers so they shade correctly under both the globe and mercator cameras.
 *
 * Solar position is the low-precision NOAA/Meeus series (declination +
 * equation of time via right ascension − GMST), good to well under 0.7°.
 */

const RAD = Math.PI / 180

/** Sun-depression thresholds, degrees below the horizon, one per band. */
const BAND_DEPRESSIONS = [0, 6, 12] as const

const TERMINATOR_SOURCE = 'terminator'
const BAND_LAYERS = ['terminator-band-0', 'terminator-band-1', 'terminator-band-2'] as const
/** Bands nest, so deep night stacks to ≈0.40 total. */
const BAND_OPACITY = [0.16, 0.13, 0.11] as const

/** Insert deck's fire layers *above* this id (the bottom terminator band). */
export const TERMINATOR_ANCHOR: string = BAND_LAYERS[0]

function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

function wrap180(deg: number): number {
  return norm360(deg + 180) - 180
}

/**
 * Point on Earth where the sun is at zenith. Declination is the subsolar
 * latitude; the longitude folds in the equation of time via RA − GMST.
 */
export function subsolarPoint(date: Date): { lon: number; lat: number } {
  // Days since J2000.0 (UT is close enough to TT at this accuracy).
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0
  const meanLon = norm360(280.46 + 0.9856474 * n)
  const meanAnom = (357.528 + 0.9856003 * n) * RAD
  const eclLon =
    (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * RAD
  const obliquity = (23.439 - 0.0000004 * n) * RAD
  const lat = Math.asin(Math.sin(obliquity) * Math.sin(eclLon)) / RAD
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon)) / RAD
  const gmst = norm360(280.46061837 + 360.98564736629 * n)
  return { lon: wrap180(ra - gmst), lat }
}

/**
 * Latitude on the meridian at hour angle `hDeg` (lon − subsolar lon) where
 * sun altitude equals −d — the single branch toward the dark pole. Solves
 * sinDec·sin(lat) + cosDec·cos(H)·cos(lat) = −sin(d) as R·sin(lat+ψ) = −sin(d).
 *
 * The night region on any meridian is a single latitude interval touching at
 * most one pole (never both, for d ≥ 0), so at most two genuine crossings
 * exist; degenerate meridians (no crossing, or a detached near-equinox band
 * when |dec| < d) collapse to the appropriate pole / far crossing.
 */
function boundaryLat(
  hDeg: number,
  sinDec: number,
  cosDec: number,
  sinD: number,
  darkSign: 1 | -1,
): number {
  const poleLat = 90 * darkSign
  const a = sinDec
  const b = cosDec * Math.cos(hDeg * RAD)
  const r = Math.hypot(a, b)
  if (r < 1e-9) return poleLat // sun altitude ≈ 0 everywhere here: not below −d
  const s = -sinD / r
  if (s < -1) return poleLat // meridian never gets darker than −d
  const asinDeg = Math.asin(Math.min(1, Math.max(-1, s))) / RAD
  const psi = Math.atan2(b, a) / RAD

  const cands: number[] = []
  for (const x of [asinDeg, 180 - asinDeg]) {
    for (const k of [-360, 0, 360]) {
      const lat = x + k - psi
      if (lat >= -90.0001 && lat <= 90.0001) {
        cands.push(Math.min(90, Math.max(-90, lat)))
      }
    }
  }

  if (cands.length === 0) {
    // Uniform meridian — classify by altitude at the equator.
    return b < -sinD ? -poleLat : poleLat
  }
  if (cands.length === 1) return cands[0]

  const lo = Math.min(...cands)
  const hi = Math.max(...cands)
  if (hi - lo < 1e-6) return lo
  const mid = ((lo + hi) / 2) * RAD
  const nightBetween = a * Math.sin(mid) + b * Math.cos(mid) < -sinD
  if (nightBetween) {
    // Detached night band (|dec| < d): take the crossing away from the dark
    // pole so the pole-closed ring still covers the true night interval.
    return darkSign < 0 ? hi : lo
  }
  // Night hugs the dark pole below/above the nearer crossing.
  return darkSign < 0 ? lo : hi
}

/**
 * Three nested night polygons — features with properties `{ band: 0|1|2 }`
 * for sun altitude below 0°/−6°/−12°. Each ring samples every integer
 * longitude −180…180 and closes through the dark pole (the pole opposite the
 * solar declination's sign), which keeps the fill valid on both the globe
 * and mercator cameras.
 */
export function nightBands(date: Date): GeoJSON.FeatureCollection {
  const sun = subsolarPoint(date)
  const sinDec = Math.sin(sun.lat * RAD)
  const cosDec = Math.cos(sun.lat * RAD)
  const darkSign: 1 | -1 = sun.lat >= 0 ? -1 : 1
  const poleLat = 90 * darkSign

  const features: GeoJSON.Feature[] = BAND_DEPRESSIONS.flatMap((d, band) => {
    // Detached-band regime: when |declination| < depression the alt<−d region
    // no longer contains either pole, so a pole-closed ring would wrongly
    // shade the whole polar cap (review finding: weeks around each equinox).
    // Under-shade honestly instead: skip the band until geometry returns.
    if (d > 0 && Math.abs(sun.lat) <= d + 0.5) return []

    const sinD = Math.sin(d * RAD)
    const ring: [number, number][] = []
    for (let lon = -180; lon <= 180; lon++) {
      ring.push([lon, boundaryLat(lon - sun.lon, sinDec, cosDec, sinD, darkSign)])
    }
    // Close through the dark pole so the ring encloses the night cap.
    ring.push([180, poleLat], [-180, poleLat], [ring[0][0], ring[0][1]])
    return [
      {
        type: 'Feature' as const,
        properties: { band },
        geometry: { type: 'Polygon' as const, coordinates: [ring] },
      },
    ]
  })

  return { type: 'FeatureCollection', features }
}

/**
 * Idempotent: (re)creates source/layers if missing and refreshes geometry —
 * call after map load, after every style swap, and on the visibility toggle
 * or a clock tick. Pass `beforeId` so the shade sits under the fire layers.
 */
export function syncTerminatorLayers(
  map: MapLibreMap,
  opts: { beforeId?: string; visible: boolean; date?: Date },
): void {
  try {
    syncUnguarded(map, opts)
  } catch {
    // Style mid-swap: additions throw until the new style lands; the
    // style.load handler re-runs this sync the moment it does.
  }
}

function syncUnguarded(
  map: MapLibreMap,
  { beforeId, visible, date }: { beforeId?: string; visible: boolean; date?: Date },
) {
  const data = nightBands(date ?? new Date())
  if (!map.getSource(TERMINATOR_SOURCE)) {
    map.addSource(TERMINATOR_SOURCE, { type: 'geojson', data })
  } else {
    ;(map.getSource(TERMINATOR_SOURCE) as GeoJSONSource).setData(data)
  }

  BAND_LAYERS.forEach((id, band) => {
    if (!map.getLayer(id)) {
      map.addLayer(
        {
          id,
          type: 'fill',
          source: TERMINATOR_SOURCE,
          filter: ['==', ['get', 'band'], band],
          paint: {
            'fill-color': '#020617',
            'fill-opacity': BAND_OPACITY[band],
            'fill-outline-color': 'rgba(0,0,0,0)',
          },
        },
        beforeId,
      )
    }
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
  })
}
