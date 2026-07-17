/**
 * Static data baker for GitHub Pages: fetches live FIRMS detections and
 * writes the same binary payloads the Hono proxy serves, as static files.
 * A scheduled GitHub Action runs this every ~20 minutes and redeploys, so
 * the Pages site stays a live feed with no server (FIRMS_MAP_KEY, if any,
 * stays inside Actions secrets).
 *
 * Usage:
 *   npx tsx scripts/bake-data.ts               # all sources × 24h/48h/7d
 *   SOURCES=VIIRS_NOAA20_NRT WINDOWS=24h ...   # subset (dev/testing)
 *   OUT_DIR=dist/data                          # output dir (default dist/data)
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'
import { fetchAndEncode, PUBLIC_FEEDS, WINDOW_DAYS, type FeedWindow } from '../server/firms'
import { fetchLightningOnce } from '../server/glm'
import { fetchSevereOnce } from '../server/severe'
import { fetchHurricanesOnce } from '../server/hurricanes'

setGlobalDispatcher(new EnvHttpProxyAgent())

const MAP_KEY = (process.env.FIRMS_MAP_KEY ?? '').trim()
const OUT_DIR = process.env.OUT_DIR ?? 'dist/data'

const ALL_WINDOWS: FeedWindow[] = ['24h', '48h', '7d']
const windows = (process.env.WINDOWS?.split(',').filter(Boolean) as FeedWindow[] | undefined) ?? ALL_WINDOWS

const defaultSources = [...Object.keys(PUBLIC_FEEDS), ...(MAP_KEY ? ['LANDSAT_NRT'] : [])]
const sources = process.env.SOURCES?.split(',').filter(Boolean) ?? defaultSources

interface ManifestEntry {
  source: string
  window: FeedWindow
  file: string
  count: number
  bytes: number
  fetchedAt: string
  /** true when the upstream fetch failed and the previous deploy's payload
   *  was reused — the data is older than this bake, but present */
  reused?: boolean
}

const FALLBACK_BASE = (process.env.FALLBACK_BASE ?? '').trim().replace(/\/$/, '')

/**
 * Upstream outage fallback: refetch the currently-deployed copy of this
 * payload so one bad FIRMS window can't strip datasets from the site
 * (observed: FIRMS unreachable from Actions runners for ~1 h — the bake
 * failed everything and the deploy was refused). Returns null when there is
 * no previous deploy or it isn't a valid payload.
 */
async function reusePrevious(file: string): Promise<{ count: number; bytes: Uint8Array; fetchedAt: string } | null> {
  if (!FALLBACK_BASE) return null
  try {
    const res = await fetch(`${FALLBACK_BASE}/data/${file}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    // validate: must decode as our wire format with a sane header
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const headerLen = view.getUint32(0, true)
    if (headerLen <= 0 || headerLen > bytes.byteLength - 4) return null
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen))) as {
      count?: number
      fetchedAt?: string
    }
    if (typeof header.count !== 'number' || header.count <= 0) return null
    return { count: header.count, bytes, fetchedAt: header.fetchedAt ?? 'unknown' }
  } catch {
    return null
  }
}

/**
 * JSON twin of reusePrevious(): refetch the currently-deployed copy of a
 * JSON payload (validated by the presence of fetchedAt) so one upstream
 * outage can't strip a dataset from the site. Returns null when there is
 * no previous deploy or it isn't a valid payload.
 */
async function reusePreviousJson(file: string): Promise<{ fetchedAt: string; json: Record<string, unknown> } | null> {
  if (!FALLBACK_BASE) return null
  try {
    const res = await fetch(`${FALLBACK_BASE}/data/${file}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    const json = (await res.json()) as Record<string, unknown>
    if (typeof json.fetchedAt !== 'string' || !json.fetchedAt) return null
    return { fetchedAt: json.fetchedAt, json }
  } catch {
    return null
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const baked: ManifestEntry[] = []
  const failures: string[] = []

  for (const source of sources) {
    for (const window of windows) {
      const file = `hotspots-${source}-${window}.bin`
      try {
        const t0 = Date.now()
        const { meta, bin } = await fetchAndEncode(source, WINDOW_DAYS[window], MAP_KEY)
        await writeFile(join(OUT_DIR, file), bin)
        baked.push({ source, window, file, count: meta.count, bytes: bin.byteLength, fetchedAt: meta.fetchedAt })
        console.log(
          `baked ${file}: ${meta.count.toLocaleString()} detections, ` +
            `${(bin.byteLength / 1e6).toFixed(1)}MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        )
      } catch (err) {
        // One bad feed must not kill the whole deploy — bake what works,
        // and reuse the previous deploy's copy of what doesn't.
        const prev = await reusePrevious(file)
        if (prev) {
          await writeFile(join(OUT_DIR, file), prev.bytes)
          baked.push({
            source,
            window,
            file,
            count: prev.count,
            bytes: prev.bytes.byteLength,
            fetchedAt: prev.fetchedAt,
            reused: true,
          })
          console.warn(
            `REUSED previous ${file} (${prev.count.toLocaleString()} rows from ${prev.fetchedAt}) — upstream: ${err instanceof Error ? err.message.slice(0, 120) : err}`,
          )
        } else {
          failures.push(`${file}: ${err instanceof Error ? err.message.slice(0, 160) : err}`)
          console.error(`FAILED ${file}:`, err instanceof Error ? err.message.slice(0, 200) : err)
        }
      }
    }
  }

  // Lightning (GOES GLM): one rolling-window payload, keyless. The window is
  // fetched fresh each bake (~360 granules across two satellites, parallel).
  let lightning: { file: string; count: number; fetchedAt: string; reused?: boolean } | null = null
  if (process.env.SKIP_LIGHTNING !== '1') {
    try {
      const t0 = Date.now()
      const { meta, bin } = await fetchLightningOnce()
      // GLM sees tens of thousands of flashes per hour across the Americas —
      // a zero-count window means the fetch failed (S3 unreachable, both
      // satellites listing empty), not a lightning-free hemisphere. Don't
      // ship an empty payload as if it were real (review finding).
      if (meta.count === 0) {
        throw new Error('empty GLM window — S3 listings unavailable or both satellites dark')
      }
      await writeFile(join(OUT_DIR, 'lightning.bin'), bin)
      lightning = { file: 'lightning.bin', count: meta.count, fetchedAt: meta.fetchedAt }
      console.log(
        `baked lightning.bin: ${meta.count.toLocaleString()} flashes ` +
          `(backfill ${(meta.backfill * 100).toFixed(0)}%), ` +
          `${(bin.byteLength / 1e6).toFixed(1)}MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      )
    } catch (err) {
      // Same reuse-previous fallback as the fire bins: an S3/GLM outage
      // must not strip lightning from the site. The reused window's
      // fetchedAt is old, which the client renders honestly (baked windows
      // freeze at bake time: "60 min to HH:MMZ").
      const prev = await reusePrevious('lightning.bin')
      if (prev) {
        await writeFile(join(OUT_DIR, 'lightning.bin'), prev.bytes)
        lightning = { file: 'lightning.bin', count: prev.count, fetchedAt: prev.fetchedAt, reused: true }
        console.warn(
          `REUSED previous lightning.bin (${prev.count.toLocaleString()} flashes from ${prev.fetchedAt}) — upstream: ${err instanceof Error ? err.message.slice(0, 120) : err}`,
        )
      } else {
        failures.push(`lightning.bin: ${err instanceof Error ? err.message.slice(0, 160) : err}`)
        console.error('FAILED lightning.bin:', err instanceof Error ? err.message.slice(0, 200) : err)
      }
    }
  }

  // Severe weather (NWS/SPC, US): small JSON payload; zero active warnings
  // is a legitimate quiet-day state, so unlike lightning an "empty" result
  // still deploys. On fetch failure, reuse the currently-deployed copy.
  let severe: { file: string; fetchedAt: string; counts?: unknown; degraded?: string[] } | null = null
  if (process.env.SKIP_SEVERE !== '1') {
    try {
      const payload = await fetchSevereOnce()
      // NOTE: unlike hurricanes, a degraded severe build is shipped FRESH,
      // not swapped for a complete previous deploy. Severe's headline data is
      // the NWS warnings/watches, and those only reach this line when they
      // succeeded (an alerts failure throws to the catch below). Only the
      // SECONDARY sources (SPC outlook shading, report dots) can degrade — so
      // the fresh build always carries the safety-relevant, minutes-fresh
      // warnings, and preferring a ~20-min-old previous deploy would trade
      // those away to preserve secondary shading (review finding). The client
      // shows a PARTIAL chip + suppresses the all-clear from `degraded`.
      await writeFile(join(OUT_DIR, 'severe.json'), JSON.stringify(payload))
      severe = {
        file: 'severe.json',
        fetchedAt: payload.fetchedAt,
        counts: payload.counts,
        ...(payload.degraded?.length ? { degraded: payload.degraded } : {}),
      }
      if (payload.degraded?.length) {
        console.warn(
          `baked severe.json with FRESH warnings but degraded sources (${payload.degraded.join(', ')})`,
        )
      } else {
        console.log(
          `baked severe.json: ${JSON.stringify(payload.counts)} · outlook ${payload.outlook ? 'ok' : 'missing'}`,
        )
      }
    } catch (err) {
      const prev = await reusePreviousJson('severe.json')
      if (prev) {
        await writeFile(join(OUT_DIR, 'severe.json'), JSON.stringify({ ...prev.json, stale: true }))
        severe = { file: 'severe.json', fetchedAt: prev.fetchedAt, counts: prev.json.counts }
        console.warn(`REUSED previous severe.json (from ${prev.fetchedAt})`)
      } else {
        failures.push(`severe.json: ${err instanceof Error ? err.message.slice(0, 160) : err}`)
        console.error('FAILED severe.json:', err instanceof Error ? err.message.slice(0, 200) : err)
      }
    }
  }

  // Tropical cyclones (NHC + EONET): small JSON payload; zero active storms
  // is a legitimate state (quiet season), so empties deploy. On fetch
  // failure, reuse the currently-deployed copy.
  let hurricanes: { file: string; fetchedAt: string; counts?: unknown } | null = null
  if (process.env.SKIP_HURRICANES !== '1') {
    try {
      const payload = await fetchHurricanesOnce()
      // A degraded build (ArcGIS/EONET down: sections empty because the
      // SOURCE failed) must not replace a complete previous deploy — that
      // would erode the fallback chain and can read as a false all-clear.
      // Prefer the older complete copy; ship degraded-fresh only when there
      // is no better option (still labeled via payload.degraded).
      if (payload.degraded?.length) {
        const prev = await reusePreviousJson('hurricanes.json')
        if (prev && !(prev.json as { degraded?: string[] }).degraded?.length) {
          await writeFile(join(OUT_DIR, 'hurricanes.json'), JSON.stringify({ ...prev.json, stale: true }))
          hurricanes = { file: 'hurricanes.json', fetchedAt: prev.fetchedAt, counts: prev.json.counts }
          console.warn(
            `REUSED previous hurricanes.json (fresh build degraded: ${payload.degraded.join(', ')})`,
          )
        } else {
          await writeFile(join(OUT_DIR, 'hurricanes.json'), JSON.stringify(payload))
          hurricanes = { file: 'hurricanes.json', fetchedAt: payload.fetchedAt, counts: payload.counts }
          console.warn(
            `baked DEGRADED hurricanes.json (${payload.degraded.join(', ')} down; no complete previous deploy)`,
          )
        }
      } else {
        await writeFile(join(OUT_DIR, 'hurricanes.json'), JSON.stringify(payload))
        hurricanes = { file: 'hurricanes.json', fetchedAt: payload.fetchedAt, counts: payload.counts }
        console.log(`baked hurricanes.json: ${JSON.stringify(payload.counts)}`)
      }
    } catch (err) {
      const prev = await reusePreviousJson('hurricanes.json')
      if (prev) {
        await writeFile(join(OUT_DIR, 'hurricanes.json'), JSON.stringify({ ...prev.json, stale: true }))
        hurricanes = { file: 'hurricanes.json', fetchedAt: prev.fetchedAt, counts: prev.json.counts }
        console.warn(`REUSED previous hurricanes.json (from ${prev.fetchedAt})`)
      } else {
        failures.push(`hurricanes.json: ${err instanceof Error ? err.message.slice(0, 160) : err}`)
        console.error('FAILED hurricanes.json:', err instanceof Error ? err.message.slice(0, 200) : err)
      }
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    hasKey: Boolean(MAP_KEY),
    files: baked,
    lightning,
    severe,
    hurricanes,
    failures,
  }
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`manifest.json: ${baked.length} baked, ${failures.length} failed`)

  // Refuse to deploy only when there is literally nothing to serve — fresh,
  // reused, or lightning. (A deploy with data beats no deploy: a skipped run
  // leaves whatever won the last race live, and stale-labeled data beats a
  // broken site.)
  if (baked.length === 0 && !lightning && !severe && !hurricanes) {
    console.error('nothing baked or reusable — refusing to deploy an empty feed')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
