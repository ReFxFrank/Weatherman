/**
 * Ember API proxy (Path A) — holds the FIRMS MAP_KEY server-side, caches world
 * queries so every visitor shares one upstream fetch, and serves the binary
 * typed-array payload deck.gl consumes with zero JSON parsing.
 *
 * The FIRMS fetch/parse/encode logic lives in server/firms.ts, shared with
 * the static data baker (scripts/bake-data.ts) used for GitHub Pages.
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { compress } from 'hono/compress'
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'
import {
  API_SOURCES,
  FIRMS_BASE,
  decodeBinaryColumns,
  encodeBinary,
  fetchAndEncode,
  type PayloadMeta,
} from './firms'

// Honor HTTP(S)_PROXY/NO_PROXY if the host environment routes egress through a
// proxy (no-op when those vars are unset).
setGlobalDispatcher(new EnvHttpProxyAgent())

const MAP_KEY = (process.env.FIRMS_MAP_KEY ?? '').trim()
const PORT = Number(process.env.PORT ?? 8787)
const CACHE_TTL_MS = 10 * 60 * 1000 // FIRMS updates per satellite pass; 10 min is safe (§8)

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

async function getHotspots(source: string, days: number): Promise<CacheEntry> {
  const key = `${source}/${days}/${MAP_KEY ? 'api' : 'pub'}`
  const cached = fresh.get(key)
  if (cached && cached.expires > Date.now()) return cached.entry

  let flight = inflight.get(key)
  if (!flight) {
    flight = fetchAndEncode(source, days, MAP_KEY)
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
    if (c.req.query('format') === 'json') {
      const { header, columns } = decodeBinaryColumns(entry.bin)
      const { dataOffset: _o, sections: _s, ...meta } = header
      return c.json({
        ...meta,
        stale: entry.meta.stale,
        columns: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, Array.from(v)])),
      })
    }
    let bin = entry.bin
    if (entry.meta.stale) {
      // Stale flag lives in the header, so stale responses re-encode meta only.
      bin = encodeBinary(entry.meta, decodeBinaryColumns(entry.bin).columns)
    }
    c.header('Content-Type', 'application/octet-stream')
    return c.body(bin.slice().buffer as ArrayBuffer)
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
