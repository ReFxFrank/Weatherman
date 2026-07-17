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
        // One bad feed must not kill the whole deploy — bake what works.
        failures.push(`${file}: ${err instanceof Error ? err.message.slice(0, 160) : err}`)
        console.error(`FAILED ${file}:`, err instanceof Error ? err.message.slice(0, 200) : err)
      }
    }
  }

  // Lightning (GOES GLM): one rolling-window payload, keyless. The window is
  // fetched fresh each bake (~360 granules across two satellites, parallel).
  let lightning: { file: string; count: number; fetchedAt: string } | null = null
  if (process.env.SKIP_LIGHTNING !== '1') {
    try {
      const t0 = Date.now()
      const { meta, bin } = await fetchLightningOnce()
      await writeFile(join(OUT_DIR, 'lightning.bin'), bin)
      lightning = { file: 'lightning.bin', count: meta.count, fetchedAt: meta.fetchedAt }
      console.log(
        `baked lightning.bin: ${meta.count.toLocaleString()} flashes ` +
          `(backfill ${(meta.backfill * 100).toFixed(0)}%), ` +
          `${(bin.byteLength / 1e6).toFixed(1)}MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      )
    } catch (err) {
      failures.push(`lightning.bin: ${err instanceof Error ? err.message.slice(0, 160) : err}`)
      console.error('FAILED lightning.bin:', err instanceof Error ? err.message.slice(0, 200) : err)
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    hasKey: Boolean(MAP_KEY),
    files: baked,
    lightning,
    failures,
  }
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`manifest.json: ${baked.length} baked, ${failures.length} failed`)

  if (baked.length === 0) {
    console.error('no datasets baked — refusing to deploy an empty feed')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
