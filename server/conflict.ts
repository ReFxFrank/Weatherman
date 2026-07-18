/**
 * Armed-conflict ingest (UCDP + GDELT) — the conflict globe's data plane.
 *
 * TWO epistemically distinct sources, kept separate end to end (never merged):
 *
 * - UCDP GED-Candidate: analyst-VERIFIED events of organized violence with at
 *   least one reported death, geo-coded to the locality. CC BY 4.0, keyless
 *   bulk CSV. Released MONTHLY with ~1-month lag — so it is authoritative but
 *   NOT live; the newest verified events are weeks old, and a place with no
 *   points is "not yet verified", not "peaceful". This is the honest core.
 * - GDELT 2.0: machine-coded conflict-related NEWS events from world media,
 *   refreshed every 15 min. UNVERIFIED — a point marks where news is being
 *   written about a place (algorithmic geolocation, machine event coding),
 *   NOT a confirmed event. Free/unrestricted use with citation.
 *
 * Neither is a "war/tensions" meter — "tensions" isn't measured by any of
 * these; the globe shows verified fatal EVENTS plus, separately, conflict
 * NEWS ATTENTION.
 */
import { unzipSync } from 'fflate'

/** UCDP GED-Candidate is released MONTHLY. Rather than a fixed version list
 *  (which expires), walk FORWARD from a known-good floor and keep the newest
 *  file that exists — so a monthly bump is picked up with no code change, and
 *  a superseded older file is never chosen once a newer one ships. */
const UCDP_FLOOR: [number, number, number] = [26, 0, 5]
const ucdpUrl = (v: [number, number, number]) =>
  `https://ucdp.uu.se/downloads/candidateged/GEDEvent_v${v[0]}_${v[1]}_${v[2]}.csv`

const headOk = async (url: string): Promise<boolean> => {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(9_000) })
    return r.ok
  } catch {
    return false
  }
}

/** Discover the newest reachable candidate: walk the patch number up from the
 *  floor, then the middle digit / year for the eventual rollover, tolerating
 *  pruned gaps but stopping a few misses past the newest hit so it stays
 *  bounded. */
async function latestUcdpUrl(): Promise<{ url: string; version: string }> {
  const [fy, fm, fp] = UCDP_FLOOR
  const tries: Array<[number, number, number]> = []
  for (let p = fp; p <= fp + 18; p++) tries.push([fy, fm, p]) // 26.0.5 … 26.0.23
  for (let m = fm + 1; m <= fm + 3; m++) for (let p = 1; p <= 6; p++) tries.push([fy, m, p])
  for (let p = 1; p <= 6; p++) tries.push([fy + 1, 0, p]) // next year
  let best: { url: string; version: string } | null = null
  let missesSinceHit = 0
  for (const v of tries) {
    if (await headOk(ucdpUrl(v))) {
      best = { url: ucdpUrl(v), version: v.join('.') }
      missesSinceHit = 0
    } else if (best && ++missesSinceHit >= 4) break
  }
  if (!best) throw new Error('no reachable UCDP candidate version')
  return best
}

const GDELT_LAST = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt'
/** keep verified events from roughly the last year (the candidate file is
 *  already recent; this bounds it and the payload size) */
const UCDP_MAX_AGE_DAYS = 400
const UCDP_MAX_EVENTS = 9000

export interface ConflictEvent {
  /** UCDP event id (stable across polls) */
  id: string
  lat: number
  lon: number
  /** best estimate of deaths (UCDP `best`) */
  deaths: number
  /** 1 = state-based, 2 = non-state, 3 = one-sided (against civilians) */
  type: number
  country: string
  /** event start date, YYYY-MM-DD */
  date: string
  /** UCDP geocoding precision 1 (exact) … 7 (country) */
  wherePrec: number
}

export interface NewsEvent {
  /** GDELT GlobalEventID (stable within a slice) */
  id: string
  lat: number
  lon: number
  /** GDELT AvgTone (negative = more negative coverage) */
  tone: number
  /** ActionGeo_FullName, e.g. "Kharkiv, Ukraine" */
  place: string
  /** source article URL */
  url: string
}

export interface ConflictPayload {
  source: 'ucdp-gdelt'
  mode: 'live' | 'baked'
  fetchedAt: string
  ucdp: {
    /** e.g. "26.0.5" — the GED-Candidate version actually loaded */
    version: string
    events: ConflictEvent[]
  }
  gdelt: {
    /** the 15-min slice these news events came from, ISO */
    at: string
    events: NewsEvent[]
  }
  counts: {
    /** verified events actually rendered (may be capped below verifiedTotal) */
    verified: number
    /** total verified events in the loaded window before the render cap */
    verifiedTotal: number
    /** cumulative deaths over the WHOLE loaded window (never truncated) */
    verifiedDeaths: number
    news: number
  }
  stale?: boolean
  /** sub-sources that failed this build ('ucdp' / 'gdelt') — an empty section
   *  there is a source outage, NOT an absence of conflict */
  degraded?: string[]
}

// ---------------------------------------------------------------------------

const fetchText = async (url: string, timeoutMs = 45_000): Promise<string> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`)
  return res.text()
}

/** Full CSV parser: handles quoted commas AND quoted newlines (UCDP source
 *  fields contain both). 1.3 MB parses in-memory fine. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else if (ch !== '\r') cur += ch
  }
  if (cur !== '' || row.length) {
    row.push(cur)
    rows.push(row)
  }
  return rows
}

interface UcdpLoad {
  version: string
  events: ConflictEvent[]
  /** total fatal events in the window before the render cap */
  total: number
  /** cumulative deaths over the whole window (never truncated) */
  totalDeaths: number
}

/** Load the newest reachable candidate. */
async function fetchUcdp(): Promise<UcdpLoad> {
  const picked = await latestUcdpUrl()
  const text = await fetchText(picked.url, 60_000)
  const rows = parseCsv(text)
  const header = rows[0] ?? []
  const col = (name: string) => header.indexOf(name)
  const iId = col('id')
  const iLat = col('latitude')
  const iLon = col('longitude')
  const iBest = col('best')
  const iType = col('type_of_violence')
  const iCountry = col('country')
  const iDate = col('date_start')
  const iPrec = col('where_prec')
  if (iLat < 0 || iLon < 0 || iBest < 0) throw new Error('UCDP CSV missing expected columns')

  const cutoff = Date.now() - UCDP_MAX_AGE_DAYS * 86400_000
  const events: ConflictEvent[] = []
  let totalDeaths = 0
  for (let r = 1; r < rows.length; r++) {
    const f = rows[r]
    const lat = Number(f[iLat])
    const lon = Number(f[iLon])
    const deaths = Number(f[iBest])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (!Number.isFinite(deaths) || deaths < 1) continue // fatal events only
    const date = (f[iDate] ?? '').slice(0, 10)
    const t = Date.parse(date)
    if (Number.isFinite(t) && t < cutoff) continue
    totalDeaths += deaths
    events.push({
      id: iId >= 0 ? (f[iId] ?? `${lat},${lon},${date}`) : `${lat},${lon},${date}`,
      lat,
      lon,
      deaths,
      type: Number(f[iType]) || 0,
      country: f[iCountry] ?? '',
      date,
      wherePrec: Number(f[iPrec]) || 0,
    })
  }
  // newest first; the death total is over ALL of them, the event list is capped
  events.sort((a, b) => (a.date < b.date ? 1 : -1))
  return { version: picked.version, events: events.slice(0, UCDP_MAX_EVENTS), total: events.length, totalDeaths }
}

const GDELT_CONFLICT_ROOTS = new Set(['18', '19', '20']) // assault, fight, mass violence

/** Latest 15-min GDELT Events slice → conflict news points (deduped by cell). */
async function fetchGdelt(): Promise<{ at: string; events: NewsEvent[] }> {
  const last = await fetchText(GDELT_LAST, 20_000)
  const exportUrl = last
    .split('\n')
    .find((l) => l.includes('.export.CSV.zip'))
    ?.split(' ')
    .pop()
  if (!exportUrl) throw new Error('no GDELT export slice listed')
  const res = await fetch(exportUrl, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`gdelt export ${res.status}`)
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const csv = new TextDecoder().decode(files[Object.keys(files)[0]])
  // slice timestamp from the filename (…/YYYYMMDDHHMMSS.export.CSV.zip)
  const m = exportUrl.match(/(\d{14})\.export/)
  const at = m
    ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[1].slice(8, 10)}:${m[1].slice(10, 12)}:00Z`
    : new Date().toISOString()

  const events: NewsEvent[] = []
  const seen = new Set<string>()
  for (const line of csv.split('\n')) {
    if (!line) continue
    const f = line.split('\t')
    // QuadClass 4 = Material Conflict, or an assault/fight/mass-violence root
    if (f[29] !== '4' && !GDELT_CONFLICT_ROOTS.has(f[28])) continue
    const lat = Number(f[56])
    const lon = Number(f[57])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue
    // one physical event is coded from many articles — dedupe by ~11 km cell
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push({
      id: f[0] || `${lat},${lon}`, // GlobalEventID
      lat,
      lon,
      tone: Number(f[34]) || 0,
      place: (f[52] ?? '').slice(0, 80),
      url: f[60] ?? '',
    })
  }
  return { at, events }
}

// ---------------------------------------------------------------------------
// Cache: UCDP is monthly (6 h sub-cache); the combined payload rides GDELT's
// 15-min cadence. Canonical pattern otherwise (hurricanes-style degraded).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60_000
const FAIL_BACKOFF_MS = 60_000
const UCDP_TTL_MS = 6 * 3600_000
let cached: { at: number; payload: ConflictPayload } | null = null
let lastGood: ConflictPayload | null = null
let lastFailAt = 0
let inflight: Promise<ConflictPayload> | null = null
let ucdpCache: { at: number; value: UcdpLoad } | null = null
const EMPTY_UCDP: UcdpLoad = { version: '?', events: [], total: 0, totalDeaths: 0 }

async function buildPayload(mode: ConflictPayload['mode']): Promise<ConflictPayload> {
  const degraded: string[] = []
  const ucdpFresh = ucdpCache && Date.now() - ucdpCache.at < UCDP_TTL_MS
  const [ucdp, gdelt] = await Promise.all([
    ucdpFresh
      ? Promise.resolve(ucdpCache!.value)
      : fetchUcdp()
          .then((v) => {
            ucdpCache = { at: Date.now(), value: v }
            return v
          })
          .catch((err) => {
            console.error('[conflict] UCDP failed:', (err as Error).message)
            const fallback = ucdpCache?.value
            if (!fallback) degraded.push('ucdp')
            return fallback ?? EMPTY_UCDP
          }),
    fetchGdelt().catch((err) => {
      console.error('[conflict] GDELT failed:', (err as Error).message)
      degraded.push('gdelt')
      return { at: new Date().toISOString(), events: [] as NewsEvent[] }
    }),
  ])
  // Both sources down with nothing to show is a TOTAL outage, not "no
  // conflict" — reject so the live cache serves last-good/stale (mirrors the
  // headline-source-fails pattern; otherwise that machinery is unreachable and
  // an outage renders a false empty globe for a full TTL).
  if (degraded.includes('ucdp') && degraded.includes('gdelt')) {
    throw new Error('conflict: both UCDP and GDELT unavailable')
  }
  return {
    source: 'ucdp-gdelt',
    mode,
    fetchedAt: new Date().toISOString(),
    ucdp: { version: ucdp.version, events: ucdp.events },
    gdelt,
    counts: {
      verified: ucdp.events.length,
      verifiedTotal: ucdp.total,
      verifiedDeaths: ucdp.totalDeaths,
      news: gdelt.events.length,
    },
    ...(degraded.length ? { degraded } : {}),
  }
}

/** Live-mode entry point (Hono route). */
export async function getConflictPayload(): Promise<ConflictPayload> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload
  if (lastGood && Date.now() - lastFailAt < FAIL_BACKOFF_MS) return { ...lastGood, stale: true }
  if (!inflight) {
    inflight = buildPayload('live')
      .then((payload) => {
        cached = { at: Date.now(), payload }
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
export function fetchConflictOnce(): Promise<ConflictPayload> {
  return buildPayload('baked')
}
