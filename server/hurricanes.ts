/**
 * Tropical cyclone ingest (NHC + EONET) — the hurricanes globe's data plane.
 *
 * Sources (keyless, US-government / NASA, verified live — TS Elida was on
 * the wire during development):
 * - NHC CurrentStorms.json: the active-storm index for NHC/CPHC basins
 *   (Atlantic, E/Central Pacific) — name, classification, intensity (kt),
 *   pressure, position, movement, advisory number.
 * - NOAA ArcGIS "NHC tropical weather summary" MapServer (f=geojson):
 *   layer 5 forecast points (per-tau intensity), 6 forecast track,
 *   7 forecast cone, 11 past track (with per-segment Saffir-Simpson `ss`).
 * - NASA EONET severeStorms: global coverage beyond NHC's basins (W Pacific
 *   typhoons etc.). EONET keeps events "open" long after storms die — a
 *   review-verified phantom-storm trap — so events are dropped unless their
 *   newest track point is < GLOBAL_MAX_AGE_H old, and storms already in the
 *   NHC index are deduped by name (NHC is fresher and richer).
 *
 * Advisory cadence is 3–6 h (intermediate advisories 3 h), so a 5-minute
 * cache is generous. Payload is small JSON, same conventions as severe.ts.
 */

const UA = 'Ember hazard globes (github.com/ReFxFrank/Weatherman)'
const STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json'
const ARCGIS =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer'
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=severeStorms&status=open'

/** EONET events with no track point newer than this are dead storms. */
const GLOBAL_MAX_AGE_H = 48

export interface ActiveStorm {
  id: string
  name: string
  /** TD | TS | HU | PTC … as NHC classifies it */
  classification: string
  /** max sustained wind, kt */
  intensityKt: number
  pressureMb: number | null
  lat: number
  lon: number
  movementDir: number | null
  movementSpeedKt: number | null
  advisoryNum: string
  lastUpdate: string
}

export interface GlobalStorm {
  title: string
  /** oldest → newest [lon, lat, iso] */
  track: Array<[number, number, string]>
  lastDate: string
}

export interface HurricaneCounts {
  nhcActive: number
  globalActive: number
  strongestName: string | null
  strongestKt: number
}

export interface HurricanePayload {
  source: 'nhc-eonet'
  mode: 'live' | 'baked'
  fetchedAt: string
  storms: ActiveStorm[]
  /** forecast cones/tracks/points + past tracks — trimmed NHC GeoJSON */
  cones: GeoJSON.FeatureCollection
  tracks: GeoJSON.FeatureCollection
  points: GeoJSON.FeatureCollection
  pastTracks: GeoJSON.FeatureCollection
  /** non-NHC storms from EONET, freshness-filtered */
  global: GlobalStorm[]
  counts: HurricaneCounts
  stale?: boolean
  /**
   * Sources that failed during this build (e.g. 'cones', 'eonet') — their
   * sections are empty because the SOURCE was down, not because the sky is
   * clear. Clients must not render an all-clear over a degraded payload.
   */
  degraded?: string[]
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

const fetchJson = async (url: string, timeoutMs = 40_000): Promise<unknown> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/geo+json, application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`)
  return res.json()
}

interface RawFeature {
  geometry: GeoJSON.Geometry
  properties: Record<string, unknown>
}

/** Query one MapServer layer as GeoJSON, keeping only the named properties. */
async function fetchLayer(layerId: number, keep: string[]): Promise<GeoJSON.FeatureCollection> {
  const url = `${ARCGIS}/${layerId}/query?where=1%3D1&outFields=${keep.join(',')}&f=geojson`
  const raw = (await fetchJson(url)) as {
    features?: RawFeature[]
    error?: { message?: string; code?: number }
  }
  // ArcGIS reports failures as an error object with HTTP 200 — surface it so
  // the layer degrades loudly instead of shipping "no storms" as data.
  if (raw.error) {
    throw new Error(`arcgis layer ${layerId}: ${raw.error.message ?? `code ${raw.error.code}`}`)
  }
  return {
    type: 'FeatureCollection',
    features: (raw.features ?? []).map((f) => ({
      type: 'Feature',
      geometry: f.geometry,
      properties: Object.fromEntries(keep.map((k) => [k, f.properties[k] ?? null])),
    })),
  }
}

interface RawCurrentStorms {
  activeStorms?: Array<{
    id?: string
    name?: string
    classification?: string
    intensity?: string | number
    pressure?: string | number
    latitudeNumeric?: number
    longitudeNumeric?: number
    movementDir?: number
    movementSpeed?: number
    lastUpdate?: string
    publicAdvisory?: { advNum?: string }
  }>
}

async function fetchStorms(): Promise<ActiveStorm[]> {
  const raw = (await fetchJson(STORMS_URL)) as RawCurrentStorms
  return (raw.activeStorms ?? [])
    .filter((s) => Number.isFinite(s.latitudeNumeric) && Number.isFinite(s.longitudeNumeric))
    .map((s) => ({
      id: s.id ?? '',
      name: s.name ?? 'Unnamed',
      classification: s.classification ?? '??',
      intensityKt: Number(s.intensity) || 0,
      pressureMb: Number(s.pressure) || null,
      lat: s.latitudeNumeric as number,
      lon: s.longitudeNumeric as number,
      movementDir: Number.isFinite(s.movementDir) ? (s.movementDir as number) : null,
      movementSpeedKt: Number.isFinite(s.movementSpeed) ? (s.movementSpeed as number) : null,
      advisoryNum: s.publicAdvisory?.advNum ?? '',
      lastUpdate: s.lastUpdate ?? '',
    }))
}

interface RawEonet {
  events?: Array<{
    title?: string
    geometry?: Array<{ type?: string; date?: string; coordinates?: [number, number] }>
  }>
}

async function fetchGlobalStorms(nhcNames: Set<string>): Promise<GlobalStorm[]> {
  const raw = (await fetchJson(EONET_URL)) as RawEonet
  const cutoff = Date.now() - GLOBAL_MAX_AGE_H * 3600_000
  const out: GlobalStorm[] = []
  for (const e of raw.events ?? []) {
    const pts = (e.geometry ?? []).filter(
      (g) => g.type === 'Point' && g.date && Array.isArray(g.coordinates),
    )
    if (!pts.length) continue
    const last = pts[pts.length - 1]
    // phantom-storm filter: "open" EONET events can be days-dead
    if (Date.parse(last.date as string) < cutoff) continue
    const title = e.title ?? 'Unnamed storm'
    // dedupe against NHC (its data is fresher/richer for its basins) by
    // whole-word match — substring matching would let a short NHC name
    // false-match inside an unrelated longer title. Token-wise on both
    // sides: PTC names like "Five-E" are multi-token.
    const words = new Set(title.toLowerCase().split(/[^a-z]+/).filter(Boolean))
    const dupOfNhc = [...nhcNames].some((n) => {
      const toks = n.split(/[^a-z]+/).filter(Boolean)
      return toks.length > 0 && toks.every((t) => words.has(t))
    })
    if (dupOfNhc) continue
    out.push({
      title,
      track: pts.map((p) => [p.coordinates![0], p.coordinates![1], p.date as string]),
      lastDate: last.date as string,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Cache: 5-min single-flight + stale-on-error + failure backoff.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60_000
const FAIL_BACKOFF_MS = 60_000
let cached: { at: number; payload: HurricanePayload } | null = null
let lastGood: HurricanePayload | null = null
let lastFailAt = 0
let inflight: Promise<HurricanePayload> | null = null

async function buildPayload(mode: HurricanePayload['mode']): Promise<HurricanePayload> {
  // The storm index is the headline source — its failure fails the build
  // (stale fallback); each map layer degrades to empty independently, but
  // the degradation is RECORDED: an empty-because-source-down section must
  // never read as an all-clear (review finding).
  const degraded: string[] = []
  const layer = (id: number, name: string, keep: string[]) =>
    fetchLayer(id, keep).catch((err) => {
      console.error(`[hurricanes] layer ${id} (${name}) failed:`, (err as Error).message)
      degraded.push(name)
      return EMPTY_FC
    })
  const [storms, points, tracks, cones, pastTracks] = await Promise.all([
    fetchStorms(),
    layer(5, 'points', ['stormname', 'tcdvlp', 'ssnum', 'maxwind', 'gust', 'mslp', 'datelbl', 'tau', 'validtime', 'advisnum', 'basin']),
    layer(6, 'tracks', ['stormname', 'stormtype', 'advisnum', 'basin']),
    layer(7, 'cones', ['stormname', 'stormtype', 'advisnum', 'basin']),
    layer(11, 'past tracks', ['ss', 'stormtype', 'stormnum', 'binnumber']),
  ])
  const nhcNames = new Set(storms.map((s) => s.name.toLowerCase()))
  const global = await fetchGlobalStorms(nhcNames)
    // one retry: EONET flaps from CI runners ("fetch failed" observed on the
    // first production bake) and a blip shouldn't degrade a 20-min cycle
    .catch(() => fetchGlobalStorms(nhcNames))
    .catch((err) => {
      console.error('[hurricanes] EONET failed:', (err as Error).message)
      degraded.push('eonet')
      return [] as GlobalStorm[]
    })

  let strongestName: string | null = null
  let strongestKt = 0
  for (const s of storms) {
    if (s.intensityKt > strongestKt) {
      strongestKt = s.intensityKt
      strongestName = s.name
    }
  }
  return {
    source: 'nhc-eonet',
    mode,
    fetchedAt: new Date().toISOString(),
    storms,
    cones,
    tracks,
    points,
    pastTracks,
    global,
    counts: { nhcActive: storms.length, globalActive: global.length, strongestName, strongestKt },
    ...(degraded.length ? { degraded } : {}),
  }
}

/** Live-mode entry point (Hono route). */
export async function getHurricanePayload(): Promise<HurricanePayload> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload
  if (lastGood && Date.now() - lastFailAt < FAIL_BACKOFF_MS) {
    return { ...lastGood, stale: true }
  }
  if (!inflight) {
    inflight = buildPayload('live')
      .then((payload) => {
        cached = { at: Date.now(), payload }
        // a degraded build (some sources down) still serves fresh, but must
        // not REPLACE a complete fallback copy — outages would erode the
        // stale chain one section at a time (review finding)
        if (!payload.degraded || !lastGood || lastGood.degraded) lastGood = payload
        return payload
      })
      .finally(() => {
        inflight = null
      })
  }
  try {
    return await inflight
  } catch (err) {
    lastFailAt = Date.now()
    if (lastGood) return { ...lastGood, stale: true }
    throw err
  }
}

/** Baked-mode entry point (scripts/bake-data.ts). */
export function fetchHurricanesOnce(): Promise<HurricanePayload> {
  return buildPayload('baked')
}
