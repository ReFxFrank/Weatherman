import { decodeFireBinary } from './binary'
import { decodeLightningBinary } from './lightningBinary'
import type {
  AuroraPayload,
  DecodedFire,
  DecodedLightning,
  EonetEvent,
  HurricanePayload,
  Quake,
  QuakePayload,
  SeverePayload,
} from './types'

export const DEFAULT_SOURCE = 'VIIRS_NOAA20_NRT'

/** Auto-refresh cadence (§5.2/§8) — matches the proxy cache TTL. */
export const REFRESH_MS = 10 * 60 * 1000

/**
 * Static mode (GitHub Pages): no proxy exists — a scheduled Action bakes the
 * same binary payloads to /data/*.bin and the app fetches those instead.
 * The ?v= tick makes each auto-refresh revalidate the CDN cache.
 */
const STATIC_MODE = import.meta.env.VITE_DATA_MODE === 'static'
const cacheTick = () => Math.floor(Date.now() / REFRESH_MS)
const windowFor = (days: number) => (days <= 1 ? '24h' : days <= 2 ? '48h' : '7d')

/**
 * Fetch + decode the binary hotspot payload. Render attributes are derived
 * separately (per quality tier) so a quality switch never refetches.
 */
export async function fetchFireDecoded(source = DEFAULT_SOURCE, days = 1): Promise<DecodedFire> {
  const url = STATIC_MODE
    ? `${import.meta.env.BASE_URL}data/hotspots-${source}-${windowFor(days)}.bin?v=${cacheTick()}`
    : `/api/hotspots?source=${encodeURIComponent(source)}&days=${days}`
  const res = await fetch(url)
  if (!res.ok) {
    if (STATIC_MODE) {
      throw new Error(
        res.status === 404
          ? `${source} not in the baked feed (see the Pages workflow)`
          : `data fetch failed (${res.status})`,
      )
    }
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `hotspots request failed (${res.status})`)
  }
  return decodeFireBinary(await res.arrayBuffer())
}

/**
 * Lightning refresh: GLM granules land every 20 s and the proxy keeps a
 * ~15 s payload cache, so live mode polls each minute. Baked mode (Pages)
 * only changes when the cron redeploys — poll on the fire cadence.
 */
export const LIGHTNING_REFRESH_MS = STATIC_MODE ? REFRESH_MS : 60_000

export async function fetchLightningDecoded(): Promise<DecodedLightning> {
  const url = STATIC_MODE
    ? `${import.meta.env.BASE_URL}data/lightning.bin?v=${Math.floor(Date.now() / LIGHTNING_REFRESH_MS)}`
    : '/api/lightning'
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      STATIC_MODE && res.status === 404
        ? 'lightning not in the baked feed yet (next Pages deploy adds it)'
        : `lightning request failed (${res.status})`,
    )
  }
  return decodeLightningBinary(await res.arrayBuffer())
}

/** NWS warnings update within seconds of issuance — poll live mode fast. */
export const SEVERE_REFRESH_MS = STATIC_MODE ? REFRESH_MS : 60_000

export async function fetchSevere(): Promise<SeverePayload> {
  const url = STATIC_MODE
    ? `${import.meta.env.BASE_URL}data/severe.json?v=${Math.floor(Date.now() / SEVERE_REFRESH_MS)}`
    : '/api/severe'
  const res = await fetch(url)
  if (!res.ok) {
    if (STATIC_MODE) {
      throw new Error(
        res.status === 404
          ? 'severe weather not in the baked feed yet (next Pages deploy adds it)'
          : `severe request failed (${res.status})`,
      )
    }
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `severe request failed (${res.status})`)
  }
  return res.json()
}

/**
 * NHC advisories land every 3–6 h and the proxy caches 5 min — polling
 * faster buys nothing. Baked mode changes only when the cron redeploys.
 */
export const HURRICANES_REFRESH_MS = STATIC_MODE ? REFRESH_MS : 5 * 60_000

export async function fetchHurricanes(): Promise<HurricanePayload> {
  const url = STATIC_MODE
    ? `${import.meta.env.BASE_URL}data/hurricanes.json?v=${Math.floor(Date.now() / HURRICANES_REFRESH_MS)}`
    : '/api/hurricanes'
  const res = await fetch(url)
  if (!res.ok) {
    if (STATIC_MODE) {
      throw new Error(
        res.status === 404
          ? 'hurricanes not in the baked feed yet (next Pages deploy adds it)'
          : `hurricanes request failed (${res.status})`,
      )
    }
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `hurricanes request failed (${res.status})`)
  }
  return res.json()
}

/**
 * USGS earthquake feed — keyless, CORS-open, public domain, updated every
 * minute (Cache-Control max-age=60). Fetched straight from the client in
 * BOTH deploy modes (like EONET): no proxy, no bake. The all_day feed always
 * carries hundreds of global events, so there is no honest "empty" state —
 * only a fetch error.
 */
const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson'
export const QUAKES_REFRESH_MS = 60_000

interface UsgsFeature {
  id?: string
  properties?: {
    mag?: number | null
    place?: string | null
    time?: number | null
    tsunami?: number | null
    felt?: number | null
    type?: string | null
    url?: string | null
  }
  geometry?: { type?: string; coordinates?: [number, number, number] } | null
}

export async function fetchQuakes(): Promise<QuakePayload> {
  const res = await fetch(USGS_URL)
  if (!res.ok) throw new Error(`USGS earthquake feed failed (${res.status})`)
  const raw = (await res.json()) as {
    metadata?: { generated?: number }
    features?: UsgsFeature[]
  }
  const quakes: Quake[] = []
  for (const f of raw.features ?? []) {
    const p = f.properties ?? {}
    const c = f.geometry?.coordinates
    // USGS sends null mag for some picks and can omit geometry — both make the
    // event unrenderable (no size/color, no position); drop them honestly
    if (f.geometry?.type !== 'Point' || !Array.isArray(c)) continue
    const [lon, lat, depth] = c
    if (typeof p.mag !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) continue
    quakes.push({
      id: f.id ?? `${lon},${lat},${p.time ?? 0}`,
      mag: p.mag,
      place: p.place ?? 'Unknown location',
      time: typeof p.time === 'number' ? p.time : 0,
      lon,
      lat,
      depthKm: Number.isFinite(depth) ? depth : null,
      tsunami: p.tsunami === 1,
      felt: typeof p.felt === 'number' ? p.felt : null,
      type: p.type ?? 'earthquake',
      url: p.url ?? '',
    })
  }
  let strongestMag = -Infinity
  let strongestPlace: string | null = null
  let significant = 0
  for (const q of quakes) {
    if (q.mag >= 4.5) significant++
    if (q.mag > strongestMag) {
      strongestMag = q.mag
      strongestPlace = q.place
    }
  }
  // the feed's own generation time is the honest freshness anchor — but guard
  // it like every other field: a malformed non-null `generated` would throw
  // RangeError from toISOString() and reject an otherwise-valid payload,
  // turning hundreds of real quakes into a false "feed unreachable"
  const gen = raw.metadata?.generated
  const fetchedAt = new Date(
    typeof gen === 'number' && Number.isFinite(gen) ? gen : Date.now(),
  ).toISOString()
  return {
    source: 'usgs',
    windowHours: 24,
    fetchedAt,
    quakes,
    counts: {
      total: quakes.length,
      significant,
      strongestMag: quakes.length ? strongestMag : 0,
      strongestPlace,
    },
  }
}

/**
 * NOAA SWPC OVATION aurora forecast — keyless, CORS-open, public domain, a
 * new grid every ~5 min (client-fetched in both deploy modes, like USGS). The
 * payload is a 1° global grid ([lon 0–359, lat −90..90, prob 0–100]); we keep
 * only cells above a visibility-meaningful threshold and normalize longitude
 * to −180..180. This is a FORECAST (valid ~30–90 min ahead — solar-wind lead
 * time from L1; the payload's Forecast Time carries the exact valid time),
 * labeled as such.
 */
const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json'
export const AURORA_REFRESH_MS = 5 * 60_000
/** cells below this forecast probability (%) aren't worth drawing (noise floor
 *  around the ovals); keeps the field to a few thousand points */
const AURORA_MIN_PROB = 5

export async function fetchAurora(): Promise<AuroraPayload> {
  const res = await fetch(OVATION_URL)
  if (!res.ok) throw new Error(`aurora forecast feed failed (${res.status})`)
  const raw = (await res.json()) as {
    ['Observation Time']?: string
    ['Forecast Time']?: string
    coordinates?: Array<[number, number, number]>
  }
  // a healthy OVATION feed ALWAYS returns the full ~65k-cell grid; genuine
  // quiet is that full grid at low probabilities. A missing/empty grid is an
  // outage, not a calm sky — throw so it surfaces as an error chip, never a
  // false "aurora unlikely" all-clear ("empty ≠ degraded"; review finding).
  const coords = raw.coordinates
  if (!Array.isArray(coords) || coords.length === 0) {
    throw new Error('aurora forecast returned no grid')
  }
  const points: Array<[number, number, number]> = []
  let peakProb = 0
  for (const c of coords) {
    const prob = c[2]
    if (typeof prob !== 'number' || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue
    // peak is over the WHOLE grid, so a quiet night still reports its true
    // peak even when every cell is below the draw threshold (review finding)
    if (prob > peakProb) peakProb = prob
    if (prob < AURORA_MIN_PROB) continue
    // OVATION longitude is 0–359; MapLibre wants −180..180
    const lon = c[0] > 180 ? c[0] - 360 : c[0]
    points.push([lon, c[1], prob])
  }
  const obs = typeof raw['Observation Time'] === 'string' ? raw['Observation Time'] : ''
  const fc = typeof raw['Forecast Time'] === 'string' ? raw['Forecast Time'] : ''
  return {
    source: 'ovation',
    observationTime: obs,
    forecastTime: fc,
    // true client fetch time (the type contract); forecastTime is the
    // valid-time anchor used for display
    fetchedAt: new Date().toISOString(),
    points,
    peakProb,
    count: points.length,
  }
}

export interface HealthInfo {
  ok: boolean
  hasKey: boolean
}

/** FIRMS quota status for the ?debug corner (§3.1). Null when unavailable. */
export async function fetchQuota(): Promise<{ current: number; limit: number } | null> {
  if (STATIC_MODE) return null
  try {
    const res = await fetch('/api/quota')
    if (!res.ok) return null
    const j = (await res.json()) as { current_transactions?: number; transaction_limit?: number }
    if (typeof j.current_transactions === 'number') {
      return { current: j.current_transactions, limit: j.transaction_limit ?? 5000 }
    }
    return null
  } catch {
    return null
  }
}

export async function fetchHealth(): Promise<HealthInfo> {
  if (STATIC_MODE) {
    const res = await fetch(`${import.meta.env.BASE_URL}data/manifest.json?v=${cacheTick()}`)
    if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`)
    const manifest = (await res.json()) as { hasKey?: boolean }
    return { ok: true, hasKey: Boolean(manifest.hasKey) }
  }
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`health check failed (${res.status})`)
  return res.json()
}

/**
 * EONET v3 is keyless + CORS-friendly — called straight from the client (§3.2).
 * `status=open` alone returns thousands of stale incidents; the 30-day window
 * keeps it to events with recent reported activity.
 */
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open&days=30'

interface EonetRaw {
  events: Array<{
    id: string
    title: string
    link: string
    sources?: Array<{ id: string; url: string }>
    geometry: Array<{
      date: string
      type: string
      coordinates: [number, number]
      magnitudeValue?: number | null
      magnitudeUnit?: string | null
    }>
  }>
}

export async function fetchEonetEvents(): Promise<EonetEvent[]> {
  const res = await fetch(EONET_URL)
  if (!res.ok) throw new Error(`EONET request failed (${res.status})`)
  const raw = (await res.json()) as EonetRaw
  return raw.events
    .map((e) => {
      // geometry is a time series of the event's reported positions — the
      // last point entry is where the incident is now.
      const points = e.geometry.filter((g) => g.type === 'Point')
      const last = points[points.length - 1]
      if (!last) return null
      return {
        id: e.id,
        title: e.title,
        link: e.link,
        date: last.date,
        coordinates: [last.coordinates[0], last.coordinates[1]] as [number, number],
        magnitudeValue: last.magnitudeValue ?? null,
        magnitudeUnit: last.magnitudeUnit ?? null,
        sources: e.sources ?? [],
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
}
