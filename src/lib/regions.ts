/**
 * Coarse continent classifier for the §5.4 stats breakdown. Hand-crafted
 * polygons — accuracy target is "which continent is burning", not cartography.
 * Europe/Asia split: ~60°E along the Urals, then the Caspian (~50°N/50°E) and
 * the Black Sea/Bosporus (~30°E at the Med). Indonesia/Philippines → Asia;
 * New Guinea, Australia, NZ and the Pacific → Oceania; Central America and
 * the Caribbean → North America.
 *
 * regionOf runs ~500k times per stats pass: bbox fast-path first, ray-cast
 * point-in-polygon second, zero allocations.
 */

export const REGION_NAMES: readonly string[] = [
  'North America',
  'South America',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
  'Antarctica',
]

/** [lon, lat] vertex rings (not closed; ray-cast treats them as closed). */
const POLYGONS: Array<{ region: number; ring: number[][] }> = [
  // North America: Arctic islands through Panama, incl. Caribbean & Greenland;
  // west edge dips to -168.5 (Bering) without crossing into Chukotka.
  {
    region: 0,
    ring: [
      [-168.5, 66], [-168.5, 72], [-120, 84], [-60, 84], [-10, 84], [-10, 68],
      [-50, 58], [-55, 45], [-75, 22], [-58, 8], [-77, 6.5], [-81, 8.8],
      [-92, 14], [-105, 18], [-118, 30], [-130, 50], [-168.5, 58],
    ],
  },
  // South America (east of the Panama isthmus down to Tierra del Fuego)
  {
    region: 1,
    ring: [
      [-81, 8.8], [-77, 6.5], [-58, 8], [-48, 6], [-30, 0], [-32, -20],
      [-52, -40], [-62, -57], [-72, -57], [-78, -45], [-73, -18], [-82, -4],
    ],
  },
  // Europe: Iceland/Scandinavia to the Urals (60E), Caspian, Black Sea, Med
  // (west edge past Iberia's Atlantic coast; Aegean edge south of Crete)
  {
    region: 2,
    ring: [
      [-30, 62], [-10, 70], [15, 72], [32, 72], [60, 70], [60, 51],
      [50, 46.5], [42, 44], [36, 42], [28, 40.5], [28.5, 36], [26.5, 34.4],
      [21, 34.6], [12, 36.5], [-6, 35.7], [-10.5, 36], [-11.5, 44], [-28, 52],
    ],
  },
  // Africa (incl. Madagascar box on the SE)
  {
    region: 3,
    ring: [
      [-19, 21], [-6, 35.5], [12, 36.5], [22, 35.5], [33, 31.5], [35, 28],
      [44, 11.5], [52, 12.5], [52, 2], [42, -12], [52, -17], [51, -27],
      [37, -37], [17, -37], [11, -18], [7, 4], [-18, 12],
    ],
  },
  // Asia: Urals/Caspian east to Bering & down through Indonesia
  // (Pacific edge bows east past the Japanese archipelago)
  {
    region: 4,
    ring: [
      [60, 70], [70, 78], [110, 78], [180, 71], [180, 64], [163, 58],
      [156, 50], [147, 44], [143, 33], [128, 30], [122, 22], [128, 5],
      [120, -11], [104, -9.5], [95, -6], [80, 4], [72, 6], [60, 22],
      [43, 11.5], [35, 28], [33, 31.5], [36, 36], [26, 40.5], [28, 41.5],
      [36, 42], [42, 44], [50, 46.5], [60, 51],
    ],
  },
  // Oceania: Australia, New Guinea, NZ, western Pacific
  {
    region: 5,
    ring: [
      [110, -8], [128, 0], [141, -1], [155, -4], [180, -10], [180, -50],
      [160, -52], [140, -45], [112, -38], [110, -22],
    ],
  },
]

/** Precomputed bounding boxes for the fast path. */
const BBOXES = POLYGONS.map(({ ring }) => {
  let minLon = 180
  let maxLon = -180
  let minLat = 90
  let maxLat = -90
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { minLon, maxLon, minLat, maxLat }
})

function inRing(ring: number[][], lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

export function regionOf(lon: number, lat: number): number {
  // trivial latitude bands first
  if (lat < -60) return 6 // Antarctica
  if (lat > 78) {
    // high Arctic: split by hemisphere
    return lon > -10 && lon < 180 ? 4 : 0
  }
  // NE Russia beyond the antimeridian wrap (reported as negative lons)
  if (lon < -168.5 && lat > 50) return 4

  for (let p = 0; p < POLYGONS.length; p++) {
    const b = BBOXES[p]
    if (lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) continue
    if (inRing(POLYGONS[p].ring, lon, lat)) return POLYGONS[p].region
  }
  return -1
}
