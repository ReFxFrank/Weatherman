/**
 * Ember API proxy (Path A) — holds the FIRMS MAP_KEY server-side, caches world
 * queries so every visitor shares one upstream fetch, and converts FIRMS CSV
 * into a binary typed-array payload deck.gl consumes with zero JSON parsing.
 *
 * Wire format of /api/hotspots:
 *   [0..4)          uint32 LE — byte length of the JSON header (H)
 *   [4..4+H)        UTF-8 JSON header (BinaryHeader below)
 *   [dataOffset..)  parallel arrays, each 4-byte aligned, laid out per
 *                   header.sections (offsets relative to dataOffset)
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

interface FireColumns {
  /** [lon, lat] interleaved — deck.gl position order */
  positions: Float32Array
  /** Fire Radiative Power, MW */
  frp: Float32Array
  /** acquisition time, epoch seconds UTC */
  tsSec: Uint32Array
  /** brightness (bright_ti4 for VIIRS, brightness for MODIS), kelvin */
  bright: Float32Array
  /** normalized confidence: 0 = low, 1 = nominal, 2 = high (§3.1) */
  conf: Uint8Array
  /** 1 = night detection, 0 = day */
  night: Uint8Array
}

interface PayloadMeta {
  source: string
  /** days requested by the client (1–10) */
  days: number
  /** days actually covered (public feeds only offer 1/2/7) */
  coverageDays: number
  mode: 'api' | 'public-feed'
  fetchedAt: string
  count: number
  stale?: boolean
}

interface BinarySection {
  name: keyof FireColumns
  type: 'f32' | 'u32' | 'u8'
  /** elements per point (2 for positions, 1 otherwise) */
  size: number
  /** byte offset relative to dataOffset */
  offset: number
}

type BinaryHeader = PayloadMeta & { dataOffset: number; sections: BinarySection[] }

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

/** acq_date "2026-07-15" + acq_time "0030" (or unpadded "30") → epoch seconds UTC. */
function acqEpochSec(date: string, time: string): number {
  const t = time.trim().padStart(4, '0')
  const ms = Date.parse(`${date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

/** FIRMS CSV has no quoted fields, so a plain split is safe. */
function parseFirmsCsv(csv: string): { count: number; columns: FireColumns } {
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

  const cap = Math.max(lines.length - 1, 0)
  const positions = new Float32Array(cap * 2)
  const frp = new Float32Array(cap)
  const tsSec = new Uint32Array(cap)
  const bright = new Float32Array(cap)
  const conf = new Uint8Array(cap)
  const night = new Uint8Array(cap)

  let m = 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length < 10) continue
    const f = line.split(',')
    const lat = Number(f[iLat])
    const lon = Number(f[iLon])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    positions[m * 2] = lon
    positions[m * 2 + 1] = lat
    frp[m] = Number(f[iFrp]) || 0
    tsSec[m] = acqEpochSec(f[iDate] ?? '', f[iTime] ?? '')
    bright[m] = Number(f[iBright]) || 0
    conf[m] = normalizeConfidence(f[iConf] ?? '')
    night[m] = (f[iDayNight] ?? '').trim() === 'N' ? 1 : 0
    m++
  }
  return {
    count: m,
    columns: {
      positions: positions.subarray(0, m * 2),
      frp: frp.subarray(0, m),
      tsSec: tsSec.subarray(0, m),
      bright: bright.subarray(0, m),
      conf: conf.subarray(0, m),
      night: night.subarray(0, m),
    },
  }
}

const align4 = (n: number) => (n + 3) & ~3

/** Pack meta + columns into the binary wire format described at the top. */
function encodeBinary(meta: PayloadMeta, columns: FireColumns): Uint8Array {
  const order: Array<{ name: keyof FireColumns; type: BinarySection['type']; size: number }> = [
    { name: 'positions', type: 'f32', size: 2 },
    { name: 'frp', type: 'f32', size: 1 },
    { name: 'tsSec', type: 'u32', size: 1 },
    { name: 'bright', type: 'f32', size: 1 },
    { name: 'conf', type: 'u8', size: 1 },
    { name: 'night', type: 'u8', size: 1 },
  ]

  const sections: BinarySection[] = []
  let cursor = 0
  for (const { name, type, size } of order) {
    cursor = align4(cursor)
    sections.push({ name, type, size, offset: cursor })
    cursor += columns[name].byteLength
  }
  const dataLength = align4(cursor)

  // Header length affects dataOffset, and dataOffset appears in the header —
  // stabilize by padding the header to 4-byte alignment (one extra pass).
  let headerBytes = new TextEncoder().encode(JSON.stringify({ ...meta, dataOffset: 0, sections }))
  let dataOffset = align4(4 + headerBytes.byteLength)
  const header: BinaryHeader = { ...meta, dataOffset, sections }
  headerBytes = new TextEncoder().encode(JSON.stringify(header))
  while (align4(4 + headerBytes.byteLength) !== dataOffset) {
    dataOffset = align4(4 + headerBytes.byteLength)
    headerBytes = new TextEncoder().encode(JSON.stringify({ ...header, dataOffset }))
  }

  const out = new Uint8Array(dataOffset + dataLength)
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, true)
  out.set(headerBytes, 4)
  for (let i = 0; i < order.length; i++) {
    const src = columns[order[i].name]
    out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), dataOffset + sections[i].offset)
  }
  return out
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
// The encoded binary buffer is cached, so repeat requests are a memcpy.
// ---------------------------------------------------------------------------
interface CacheEntry {
  meta: PayloadMeta
  bin: Uint8Array
}

const inflight = new Map<string, Promise<CacheEntry>>()
const fresh = new Map<string, { expires: number; entry: CacheEntry }>()
const lastGood = new Map<string, CacheEntry>()

async function fetchHotspots(source: string, days: number): Promise<CacheEntry> {
  const { url, mode, coverageDays } = upstreamUrl(source, days)
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  const body = await res.text()
  if (!res.ok) throw new HttpError(502, `FIRMS upstream ${res.status}: ${body.slice(0, 200)}`)
  // The API returns errors (bad key, quota) as a 200 text page, not CSV.
  if (!body.startsWith('latitude') && !body.includes('\nlatitude')) {
    throw new HttpError(502, `FIRMS returned non-CSV response: ${body.slice(0, 200)}`)
  }
  const { count, columns } = parseFirmsCsv(body)
  const meta: PayloadMeta = {
    source,
    days,
    coverageDays,
    mode,
    fetchedAt: new Date().toISOString(),
    count,
  }
  return { meta, bin: encodeBinary(meta, columns) }
}

async function getHotspots(source: string, days: number): Promise<CacheEntry> {
  const key = `${source}/${days}/${MAP_KEY ? 'api' : 'pub'}`
  const cached = fresh.get(key)
  if (cached && cached.expires > Date.now()) return cached.entry

  let flight = inflight.get(key)
  if (!flight) {
    flight = fetchHotspots(source, days)
      .then((entry) => {
        fresh.set(key, { expires: Date.now() + CACHE_TTL_MS, entry })
        lastGood.set(key, entry)
        return entry
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, flight)
  }

  try {
    return await flight
  } catch (err) {
    const stale = lastGood.get(key)
    if (stale) {
      // Re-encode with the stale flag so the client can surface it.
      return { meta: { ...stale.meta, stale: true }, bin: stale.bin }
    }
    throw err
  }
}

/** Debug view of a binary entry as JSON columns (`?format=json`). */
function decodeForDebug(entry: CacheEntry): Record<string, unknown> {
  const view = new DataView(entry.bin.buffer, entry.bin.byteOffset, entry.bin.byteLength)
  const headerLen = view.getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(entry.bin.subarray(4, 4 + headerLen))) as BinaryHeader
  const columns: Record<string, number[]> = {}
  for (const s of header.sections) {
    const byteOffset = entry.bin.byteOffset + header.dataOffset + s.offset
    const len = header.count * s.size
    const arr =
      s.type === 'f32'
        ? new Float32Array(entry.bin.buffer, byteOffset, len)
        : s.type === 'u32'
          ? new Uint32Array(entry.bin.buffer, byteOffset, len)
          : new Uint8Array(entry.bin.buffer, byteOffset, len)
    columns[s.name] = Array.from(arr)
  }
  return { ...entry.meta, columns }
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
    const entry = await getHotspots(source, days)
    c.header('Cache-Control', 'public, max-age=300')
    if (c.req.query('format') === 'json') return c.json(decodeForDebug(entry))
    let bin = entry.bin
    if (entry.meta.stale) {
      // Stale flag lives in the header, so stale responses re-encode meta only.
      bin = encodeBinary(entry.meta, decodeColumns(entry))
    }
    c.header('Content-Type', 'application/octet-stream')
    return c.body(bin.slice().buffer as ArrayBuffer)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502
    return c.json({ error: err instanceof Error ? err.message : 'upstream failure' }, status as 400 | 502)
  }
})

/** Reconstruct typed-array columns from a cached binary entry. */
function decodeColumns(entry: CacheEntry): FireColumns {
  const view = new DataView(entry.bin.buffer, entry.bin.byteOffset, entry.bin.byteLength)
  const headerLen = view.getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(entry.bin.subarray(4, 4 + headerLen))) as BinaryHeader
  const at = (s: BinarySection) => entry.bin.byteOffset + header.dataOffset + s.offset
  const get = (name: keyof FireColumns) => header.sections.find((s) => s.name === name)!
  const f32 = (s: BinarySection) => new Float32Array(entry.bin.buffer, at(s), header.count * s.size)
  return {
    positions: f32(get('positions')),
    frp: f32(get('frp')),
    tsSec: new Uint32Array(entry.bin.buffer, at(get('tsSec')), header.count),
    bright: f32(get('bright')),
    conf: new Uint8Array(entry.bin.buffer, at(get('conf')), header.count),
    night: new Uint8Array(entry.bin.buffer, at(get('night')), header.count),
  }
}

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
