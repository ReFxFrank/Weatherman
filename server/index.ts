/**
 * Ember API proxy (Path A) — holds the FIRMS MAP_KEY server-side, caches world
 * queries so every visitor shares one upstream fetch, and converts FIRMS CSV
 * into a compact columnar JSON payload the client feeds straight into deck.gl.
 *
 * Phase 0 stub: columnar JSON. Phase 1 upgrades the wire format to binary
 * typed arrays.
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { compress } from 'hono/compress'
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'

// Honor HTTP(S)_PROXY/NO_PROXY if the host environment routes egress through a
// proxy (no-op when those vars are unset).
setGlobalDispatcher(new EnvHttpProxyAgent())

const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov'
const MAP_KEY = (process.env.FIRMS_MAP_KEY ?? '').trim()
const PORT = Number(process.env.PORT ?? 8787)
const CACHE_TTL_MS = 10 * 60 * 1000 // FIRMS updates per satellite pass; 10 min is safe (§8)

/** Sources accepted by the FIRMS area API (§3.1). */
const API_SOURCES = new Set([
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
  'MODIS_NRT',
  'LANDSAT_NRT',
])

/**
 * Keyless public "Active Fire Data" feeds — same live detections, but
 * world-only and fixed 24h/48h/7d windows. Used until FIRMS_MAP_KEY is set.
 * LANDSAT has no public feed.
 */
const PUBLIC_FEEDS: Record<string, string> = {
  VIIRS_NOAA20_NRT: 'noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global',
  VIIRS_NOAA21_NRT: 'noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global',
  VIIRS_SNPP_NRT: 'suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global',
  MODIS_NRT: 'modis-c6.1/csv/MODIS_C6_1_Global',
}

interface HotspotColumns {
  lat: number[]
  lon: number[]
  frp: number[]
  /** normalized confidence: 0 = low, 1 = nominal, 2 = high (§3.1) */
  conf: number[]
  /** acquisition time, epoch ms UTC */
  ts: number[]
  /** 1 = night detection, 0 = day */
  night: number[]
  /** brightness (bright_ti4 for VIIRS, brightness for MODIS), kelvin */
  bright: number[]
}

interface HotspotPayload {
  source: string
  /** days requested by the client (1–10) */
  days: number
  /** days actually covered (public feeds only offer 1/2/7) */
  coverageDays: number
  mode: 'api' | 'public-feed'
  fetchedAt: string
  count: number
  columns: HotspotColumns
  stale?: boolean
}

/** VIIRS letters, public-feed words, and MODIS 0–100 → one 0–2 scale. */
function normalizeConfidence(raw: string): number {
  const s = raw.trim().toLowerCase()
  if (s === 'l' || s === 'low') return 0
  if (s === 'n' || s === 'nominal') return 1
  if (s === 'h' || s === 'high') return 2
  const n = Number(s)
  if (Number.isFinite(n)) return n < 30 ? 0 : n < 80 ? 1 : 2
  return 1
}

/** acq_date "2026-07-15" + acq_time "0030" (or unpadded "30") → epoch ms UTC. */
function acqEpochMs(date: string, time: string): number {
  const t = time.trim().padStart(4, '0')
  const ms = Date.parse(`${date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`)
  return Number.isFinite(ms) ? ms : 0
}

/** FIRMS CSV has no quoted fields, so a plain split is safe. */
function parseFirmsCsv(csv: string): { count: number; columns: HotspotColumns } {
  const lines = csv.split('\n')
  const header = (lines[0] ?? '').trim().split(',')
  const col = (name: string) => header.indexOf(name)

  const iLat = col('latitude')
  const iLon = col('longitude')
  const iFrp = col('frp')
  const iConf = col('confidence')
  const iDate = col('acq_date')
  const iTime = col('acq_time')
  const iDayNight = col('daynight')
  // VIIRS: bright_ti4 · MODIS: brightness
  const iBright = col('bright_ti4') !== -1 ? col('bright_ti4') : col('brightness')
  if (iLat === -1 || iLon === -1) {
    throw new Error(`unexpected FIRMS CSV header: ${header.join(',')}`)
  }

  const columns: HotspotColumns = { lat: [], lon: [], frp: [], conf: [], ts: [], night: [], bright: [] }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length < 10) continue
    const f = line.split(',')
    const lat = Number(f[iLat])
    const lon = Number(f[iLon])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    columns.lat.push(lat)
    columns.lon.push(lon)
    columns.frp.push(Number(f[iFrp]) || 0)
    columns.conf.push(normalizeConfidence(f[iConf] ?? ''))
    columns.ts.push(acqEpochMs(f[iDate] ?? '', f[iTime] ?? ''))
    columns.night.push((f[iDayNight] ?? '').trim() === 'N' ? 1 : 0)
    columns.bright.push(Number(f[iBright]) || 0)
  }
  return { count: columns.lat.length, columns }
}

function upstreamUrl(source: string, days: number): { url: string; mode: 'api' | 'public-feed'; coverageDays: number } {
  if (MAP_KEY) {
    return {
      url: `${FIRMS_BASE}/api/area/csv/${MAP_KEY}/${source}/world/${days}`,
      mode: 'api',
      coverageDays: days,
    }
  }
  const feed = PUBLIC_FEEDS[source]
  if (!feed) throw new HttpError(400, `source ${source} requires a FIRMS_MAP_KEY (no public feed)`)
  const window = days <= 1 ? '24h' : days <= 2 ? '48h' : '7d'
  return {
    url: `${FIRMS_BASE}/data/active_fire/${feed}_${window}.csv`,
    mode: 'public-feed',
    coverageDays: days <= 1 ? 1 : days <= 2 ? 2 : 7,
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Cache: single-flight per (source, days) with TTL, plus last-good fallback so
// an upstream hiccup (or quota exhaustion) degrades to stale data, not errors.
// ---------------------------------------------------------------------------
const inflight = new Map<string, Promise<HotspotPayload>>()
const fresh = new Map<string, { expires: number; payload: HotspotPayload }>()
const lastGood = new Map<string, HotspotPayload>()

async function fetchHotspots(source: string, days: number): Promise<HotspotPayload> {
  const { url, mode, coverageDays } = upstreamUrl(source, days)
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  const body = await res.text()
  if (!res.ok) throw new HttpError(502, `FIRMS upstream ${res.status}: ${body.slice(0, 200)}`)
  // The API returns errors (bad key, quota) as a 200 text page, not CSV.
  if (!body.startsWith('latitude') && !body.includes('\nlatitude')) {
    throw new HttpError(502, `FIRMS returned non-CSV response: ${body.slice(0, 200)}`)
  }
  const { count, columns } = parseFirmsCsv(body)
  return { source, days, coverageDays, mode, fetchedAt: new Date().toISOString(), count, columns }
}

async function getHotspots(source: string, days: number): Promise<HotspotPayload> {
  const key = `${source}/${days}/${MAP_KEY ? 'api' : 'pub'}`
  const cached = fresh.get(key)
  if (cached && cached.expires > Date.now()) return cached.payload

  let flight = inflight.get(key)
  if (!flight) {
    flight = fetchHotspots(source, days)
      .then((payload) => {
        fresh.set(key, { expires: Date.now() + CACHE_TTL_MS, payload })
        lastGood.set(key, payload)
        return payload
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, flight)
  }

  try {
    return await flight
  } catch (err) {
    const stale = lastGood.get(key)
    if (stale) return { ...stale, stale: true }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const app = new Hono()
app.use('*', compress())

app.get('/api/health', (c) => c.json({ ok: true, hasKey: Boolean(MAP_KEY) }))

app.get('/api/hotspots', async (c) => {
  const source = c.req.query('source') ?? 'VIIRS_NOAA20_NRT'
  const days = Math.min(10, Math.max(1, Number(c.req.query('days') ?? 1) || 1))
  if (!API_SOURCES.has(source)) {
    return c.json({ error: `unknown source ${source}` }, 400)
  }
  try {
    const payload = await getHotspots(source, days)
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(payload)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502
    return c.json({ error: err instanceof Error ? err.message : 'upstream failure' }, status as 400 | 502)
  }
})

/** FIRMS quota status (§3.1) for the dev/debug corner. */
app.get('/api/quota', async (c) => {
  if (!MAP_KEY) return c.json({ hasKey: false, mode: 'public-feed' })
  try {
    const res = await fetch(`${FIRMS_BASE}/mapserver/mapkey_status/?MAP_KEY=${MAP_KEY}`, {
      signal: AbortSignal.timeout(15_000),
    })
    return c.json(await res.json())
  } catch {
    return c.json({ error: 'quota check failed' }, 502)
  }
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    `[ember] api proxy on http://localhost:${info.port} — ` +
      (MAP_KEY ? 'FIRMS area API (key set)' : 'public keyless feeds (set FIRMS_MAP_KEY for full API)'),
  )
})
