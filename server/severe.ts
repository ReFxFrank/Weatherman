/**
 * Severe weather ingest (NWS + SPC) — the tornado globe's data plane.
 *
 * Sources (all keyless, US-government public domain, verified live):
 * - api.weather.gov active alerts, filtered to tornado/severe-thunderstorm
 *   warnings and watches. Warnings are storm-based polygons with inline
 *   geometry; watches are zone-based and usually ship `geometry: null` —
 *   their shapes are resolved via each alert's `affectedZones` URLs and
 *   merged into one MultiPolygon (zone geometries are cached in-process:
 *   a watch can span dozens of zones). The API requires a User-Agent.
 * - SPC storm reports (today's tornado/wind/hail CSVs, ~5 min cadence).
 *   Legitimately header-only on quiet days; the file resets at 12Z.
 * - SPC Day-1 categorical convective outlook GeoJSON (5 issuances/day),
 *   carrying the official risk-category colors in feature properties.
 *
 * Coverage honesty: this is a US-only globe by nature — tornado warning
 * infrastructure exists where it exists. The UI says so (legend note).
 *
 * Payloads are small (KBs of polygons/points, not MBs of splats), so this
 * globe ships plain JSON rather than the binary columnar format.
 */

const UA = 'Ember hazard globes (github.com/ReFxFrank/Weatherman)'
const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?event=' +
  encodeURIComponent(
    'Tornado Warning,Severe Thunderstorm Warning,Tornado Watch,Severe Thunderstorm Watch',
  )
const SPC_BASE = 'https://www.spc.noaa.gov'
const OUTLOOK_URL = `${SPC_BASE}/products/outlook/day1otlk_cat.lyr.geojson`

export type SevereKind = 'tornado-warning' | 'severe-warning' | 'tornado-watch' | 'severe-watch'

export interface SevereReport {
  /** HHMM UTC-ish as SPC reports it (CST-based day file) */
  time: string
  lat: number
  lon: number
  /** F-scale for tornadoes, mph for wind, hail size (1/100 in) — as reported */
  mag: string
  location: string
  state: string
}

export interface SevereCounts {
  tornadoWarnings: number
  severeWarnings: number
  tornadoWatches: number
  severeWatches: number
  reports: number
  /** alerts in the feed whose geometry could not be resolved (not drawn) */
  unmapped: number
}

export interface SeverePayload {
  source: 'nws-spc'
  mode: 'live' | 'baked'
  fetchedAt: string
  /** trimmed alert features; properties: {kind, event, severity, headline, areaDesc, onset, expires} */
  alerts: GeoJSON.FeatureCollection
  /** SPC Day-1 categorical outlook, trimmed props {dn, label, label2, fill, stroke, expire} */
  outlook: GeoJSON.FeatureCollection | null
  reports: { torn: SevereReport[]; wind: SevereReport[]; hail: SevereReport[] }
  counts: SevereCounts
  stale?: boolean
  /**
   * Sub-sources that failed during this build (e.g. 'outlook', 'reports') —
   * their sections are empty because the SOURCE was down, not because the
   * day is quiet. Clients must not render an all-clear over a degraded
   * payload. (Alerts are the headline source: their failure fails the whole
   * build instead, triggering the stale fallback.)
   */
  degraded?: string[]
}

// ---------------------------------------------------------------------------

const fetchJson = async (url: string, timeoutMs = 30_000): Promise<unknown> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/geo+json, application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`)
  return res.json()
}

/** Zone shapes are stable — cache them for the process lifetime. */
const zoneCache = new Map<string, GeoJSON.Geometry | null>()

async function resolveZones(urls: string[]): Promise<void> {
  const missing = urls.filter((u) => !zoneCache.has(u))
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(6, missing.length) }, async () => {
      while (i < missing.length) {
        const url = missing[i++]
        try {
          const z = (await fetchJson(url)) as { geometry?: GeoJSON.Geometry | null }
          // only cache real shapes: a 200 with null geometry (content
          // negotiation fallback, partial outage) must retry next refresh —
          // caching it would drop that zone from every future watch until
          // the process restarts (review finding)
          if (z.geometry) zoneCache.set(url, z.geometry)
        } catch {
          // transient failure: leave uncached so a later refresh retries
        }
      }
    }),
  )
}

/** Collect Polygon/MultiPolygon rings from geometries into one MultiPolygon. */
function mergePolygons(geoms: Array<GeoJSON.Geometry | null | undefined>): GeoJSON.Geometry | null {
  const polys: GeoJSON.Position[][][] = []
  for (const g of geoms) {
    if (!g) continue
    if (g.type === 'Polygon') polys.push(g.coordinates)
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates)
  }
  if (!polys.length) return null
  return { type: 'MultiPolygon', coordinates: polys }
}

function kindOf(event: string): SevereKind | null {
  switch (event) {
    case 'Tornado Warning':
      return 'tornado-warning'
    case 'Severe Thunderstorm Warning':
      return 'severe-warning'
    case 'Tornado Watch':
      return 'tornado-watch'
    case 'Severe Thunderstorm Watch':
      return 'severe-watch'
    default:
      return null
  }
}

interface RawAlertFeature {
  geometry: GeoJSON.Geometry | null
  properties: {
    id?: string
    event?: string
    severity?: string
    headline?: string
    areaDesc?: string
    onset?: string
    expires?: string
    affectedZones?: string[]
  }
}

async function fetchAlerts(): Promise<{ fc: GeoJSON.FeatureCollection; counts: SevereCounts }> {
  const raw = (await fetchJson(NWS_ALERTS_URL, 45_000)) as { features?: RawAlertFeature[] }
  const feats = raw.features ?? []

  // resolve zone geometry for alerts that ship without one (watches)
  const zoneUrls = new Set<string>()
  for (const f of feats) {
    if (!f.geometry) for (const z of f.properties.affectedZones ?? []) zoneUrls.add(z)
  }
  await resolveZones([...zoneUrls])

  const counts: SevereCounts = {
    tornadoWarnings: 0,
    severeWarnings: 0,
    tornadoWatches: 0,
    severeWatches: 0,
    reports: 0,
    unmapped: 0,
  }
  const out: GeoJSON.Feature[] = []
  for (const f of feats) {
    const kind = kindOf(f.properties.event ?? '')
    if (!kind) continue
    // Count from the FEED, before any geometry skip: an alert whose zones
    // failed to resolve must still count, or a zone-endpoint outage during
    // an active watch renders a confident false all-clear (review finding).
    if (kind === 'tornado-warning') counts.tornadoWarnings++
    else if (kind === 'severe-warning') counts.severeWarnings++
    else if (kind === 'tornado-watch') counts.tornadoWatches++
    else counts.severeWatches++
    const geometry =
      f.geometry ??
      mergePolygons((f.properties.affectedZones ?? []).map((z) => zoneCache.get(z)))
    if (!geometry) {
      counts.unmapped++
      continue // undrawable, but counted + surfaced via counts.unmapped
    }
    out.push({
      type: 'Feature',
      geometry,
      properties: {
        kind,
        event: f.properties.event,
        severity: f.properties.severity ?? null,
        headline: f.properties.headline ?? null,
        areaDesc: (f.properties.areaDesc ?? '').slice(0, 200),
        onset: f.properties.onset ?? null,
        expires: f.properties.expires ?? null,
      },
    })
  }
  return { fc: { type: 'FeatureCollection', features: out }, counts }
}

/** SPC report CSVs: header + rows; the trailing Comments field may contain
 *  commas, so split with a field cap. Header-only files are normal. */
function parseSpcCsv(csv: string): SevereReport[] {
  const lines = csv.trim().split('\n')
  const out: SevereReport[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 7) continue
    const [time, mag, location, , state, latS, lonS] = parts
    const lat = Number(latS)
    const lon = Number(lonS)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    out.push({ time, mag, location: location.slice(0, 60), state, lat, lon })
  }
  return out
}

async function fetchReports(kind: 'torn' | 'wind' | 'hail'): Promise<SevereReport[]> {
  const res = await fetch(`${SPC_BASE}/climo/reports/today_${kind}.csv`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`SPC ${kind} ${res.status}`)
  return parseSpcCsv(await res.text())
}

interface RawOutlookFeature {
  geometry: GeoJSON.Geometry
  properties: Record<string, unknown>
}

async function fetchOutlook(): Promise<GeoJSON.FeatureCollection | null> {
  const raw = (await fetchJson(OUTLOOK_URL)) as { features?: RawOutlookFeature[] }
  if (!raw.features) return null
  return {
    type: 'FeatureCollection',
    features: raw.features.map((f) => ({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        dn: f.properties.DN ?? 0,
        label: f.properties.LABEL ?? '',
        label2: f.properties.LABEL2 ?? '',
        fill: f.properties.fill ?? '#557755',
        stroke: f.properties.stroke ?? '#557755',
        expire: f.properties.EXPIRE_ISO ?? null,
      },
    })),
  }
}

// ---------------------------------------------------------------------------
// Cache: 60s single-flight + last-good stale fallback (FIRMS pattern).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000
/** after a failed build, serve stale for this long before re-trying upstream —
 *  otherwise every 60 s poll rides the full 45 s alerts timeout during an
 *  outage and the server hammers the failing endpoint (review finding) */
const FAIL_BACKOFF_MS = 30_000
let cached: { at: number; payload: SeverePayload } | null = null
let lastGood: SeverePayload | null = null
let lastFailAt = 0
let inflight: Promise<SeverePayload> | null = null

/** slow-moving sources keep a private TTL under the 60 s payload cache:
 *  the outlook changes ~5x/day and report CSVs every ~5 min — refetching
 *  them every rebuild is pure waste (review finding) */
let outlookCache: { at: number; value: GeoJSON.FeatureCollection } | null = null
let reportsCache: { at: number; value: SeverePayload['reports'] } | null = null
const OUTLOOK_TTL_MS = 10 * 60_000
const REPORTS_TTL_MS = 4 * 60_000
/** A failure-fallback sub-source stays servable only within ~3× its TTL of
 *  its last success; past that a persistent outage would serve a superseded
 *  outlook — or, worse, the PREVIOUS convective day's reports as "since 12Z"
 *  (SPC files reset at 12Z) — as if current. Beyond the bound we serve
 *  empty + flag `degraded` instead of lying (review finding). */
const OUTLOOK_FALLBACK_MAX_MS = 3 * OUTLOOK_TTL_MS
const REPORTS_FALLBACK_MAX_MS = 3 * REPORTS_TTL_MS

async function buildPayload(mode: SeverePayload['mode']): Promise<SeverePayload> {
  // alerts are the headline data — their failure fails the fetch (triggering
  // stale fallback); outlook/reports degrade per-source, but the degradation
  // is RECORDED: an empty-because-SPC-is-down section must never read as a
  // quiet day (the hurricanes globe set this convention). A failed fetch
  // falls back to the sub-TTL cache when one exists (older data beats none —
  // that path is NOT flagged) and never overwrites that cache, so the next
  // rebuild retries upstream. All five fetches share ONE Promise.all so
  // every promise has its handler attached immediately — a fast alerts
  // rejection during a slow SPC response must reject this call, not become
  // an unhandled rejection that kills the process (review finding).
  const degraded: string[] = []
  const outlookFresh = outlookCache && Date.now() - outlookCache.at < OUTLOOK_TTL_MS
  const reportsFresh = reportsCache && Date.now() - reportsCache.at < REPORTS_TTL_MS
  const [{ fc, counts }, outlook, reports] = await Promise.all([
    fetchAlerts(),
    outlookFresh
      ? Promise.resolve(outlookCache!.value)
      : fetchOutlook()
          // one retry: SPC/runner blips shouldn't degrade a whole cycle
          // (matches the EONET retry in hurricanes.ts)
          .catch(() => fetchOutlook())
          .then((v) => {
            // a 200 without `features` is a failed fetch, not a quiet
            // outlook — never cache null (same rule as null zone geometries)
            if (v) {
              outlookCache = { at: Date.now(), value: v }
              return v
            }
            throw new Error('outlook response carried no features')
          })
          .catch((err) => {
            console.error('[severe] outlook failed:', (err as Error).message)
            const usable = outlookCache && Date.now() - outlookCache.at < OUTLOOK_FALLBACK_MAX_MS
            if (!usable) degraded.push('outlook')
            return usable ? outlookCache!.value : null
          }),
    reportsFresh
      ? Promise.resolve(reportsCache!.value)
      : Promise.all([
          fetchReports('torn').catch(() => fetchReports('torn')).catch(() => null),
          fetchReports('wind').catch(() => fetchReports('wind')).catch(() => null),
          fetchReports('hail').catch(() => fetchReports('hail')).catch(() => null),
        ]).then(([torn, wind, hail]) => {
          // the failure fallback is age-bounded: a report cache older than
          // ~3× its TTL may straddle the 12Z reset, so past that we serve
          // empty + degrade rather than mislabel yesterday's reports
          const prevUsable = reportsCache && Date.now() - reportsCache.at < REPORTS_FALLBACK_MAX_MS
          const prev = prevUsable ? reportsCache!.value : undefined
          const anyFailed = !torn || !wind || !hail
          const value = {
            torn: torn ?? prev?.torn ?? [],
            wind: wind ?? prev?.wind ?? [],
            hail: hail ?? prev?.hail ?? [],
          }
          // only a fully-fresh trio may become the cache: caching a failure's
          // empty array would serve the false quiet for a whole sub-TTL
          if (!anyFailed) reportsCache = { at: Date.now(), value }
          else if (!prev) degraded.push('reports')
          return value
        }),
  ])
  counts.reports = reports.torn.length + reports.wind.length + reports.hail.length
  return {
    source: 'nws-spc',
    mode,
    fetchedAt: new Date().toISOString(),
    alerts: fc,
    outlook,
    reports,
    counts,
    ...(degraded.length ? { degraded } : {}),
  }
}

/** Live-mode entry point (Hono route). */
export async function getSeverePayload(): Promise<SeverePayload> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload
  if (lastGood && Date.now() - lastFailAt < FAIL_BACKOFF_MS) {
    return { ...lastGood, stale: true }
  }
  if (!inflight) {
    inflight = buildPayload('live')
      .then((payload) => {
        cached = { at: Date.now(), payload }
        // a degraded build (SPC down) still serves fresh, but must not
        // REPLACE a complete fallback copy — outages would erode the stale
        // chain one section at a time (hurricanes convention)
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
export function fetchSevereOnce(): Promise<SeverePayload> {
  return buildPayload('baked')
}
