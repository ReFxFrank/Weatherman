/**
 * Lightning ingest — the lightning globe's data plane, merging multiple
 * geostationary lightning sensors into one rolling window:
 *
 * - GOES-West / GOES-East GLM: one L2 "LCFA" granule per satellite every
 *   20 seconds on NOAA's public S3 buckets (keyless, public domain,
 *   ~230 KB NetCDF-4), landing ~10–30 s after observation.
 * - Meteosat MTG-I1 Lightning Imager (server/mtgli.ts): one L2 "LFL"
 *   product every 10 minutes from EUMETSAT's Data Store — free but keyed
 *   (EUMETSAT_CONSUMER_KEY/SECRET), enabled only when credentials exist.
 *
 * NetCDF-4 is HDF5 — decoded with h5wasm (Node's netcdfjs can't read it).
 * Payloads use the same binary wire conventions as FIRMS (server/firms.ts).
 *
 * Coverage honesty (docs/DECISIONS.md): these sensors see the Americas plus
 * Europe/Africa — NOT the whole planet — and any instrument can go dark
 * (a multi-hour GOES-East outage was live while this shipped). Per-satellite
 * freshness, cadence, and sub-satellite longitude ship in the payload header
 * so the UI renders exactly what is and isn't covered.
 *
 * GLM flash timestamps quantize to the 20-second granule start; MTG-LI
 * products span 10 minutes, so those carry per-flash timestamps.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import h5wasm from 'h5wasm/node'
import { createMtgSources } from './mtgli'

export const LIGHTNING_WINDOW_MIN = 60
/** slack beyond the window: must exceed the longest product span (MTG: 10 min)
 *  so eviction-by-start-time never drops flashes still inside the window */
const EVICT_MIN = LIGHTNING_WINDOW_MIN + 15
/** granules fetched per source per ingest cycle (newest first) */
const FETCH_BATCH = 40
const FETCH_CONCURRENCY = 8
/** stop polling upstreams when nobody has asked for lightning in a while */
const IDLE_STOP_MS = 10 * 60_000
const CYCLE_ACTIVE_MS = 20_000
const CYCLE_BACKFILL_MS = 2_000

/** One decoded granule/product's worth of flashes. */
export interface FlashBatch {
  lon: Float32Array
  lat: Float32Array
  /** sensor-native optical intensity, normalized per source (see DECISIONS) */
  energy: Float32Array
  /** per-flash epoch seconds; omit to quantize every flash to the key's time */
  tsSec?: Uint32Array
}

/** A pluggable lightning sensor. */
export interface LightningSource {
  id: string
  name: string
  /** sub-satellite longitude, °E — center of its field of view */
  lonSubSat: number
  /** nominal product cadence, seconds (drives UI freshness expectations) */
  cadenceSec: number
  /** false when required credentials are missing — source omitted entirely */
  enabled(): boolean
  /** minimum seconds between upstream listings (be polite to keyed APIs) */
  listIntervalSec: number
  /** keys (granules/products) available for the window; must be sortable
   *  newest-last and carry their start time via keyEpochSec */
  list(nowSec: number, windowMin: number): Promise<string[]>
  keyEpochSec(key: string): number
  fetch(key: string): Promise<FlashBatch>
}

export interface SatMeta {
  id: string
  name: string
  lonSubSat: number
  cadenceSec: number
  /** epoch seconds of the newest decoded granule, 0 if none */
  lastGranuleSec: number
  flashCount: number
  /** granules listed in-window but not yet fetched (backfill in progress) */
  pendingKeys: number
  /** granules that failed twice and were given up — window gaps */
  failedKeys: number
  /** false until the first successful bucket listing — lets the client tell
   *  "still acquiring" apart from "satellite is dark" (review finding) */
  everListed: boolean
}

export interface LightningMeta {
  source: 'glm'
  windowMin: number
  mode: 'live' | 'baked'
  fetchedAt: string
  count: number
  sats: SatMeta[]
  /** 0..1 — fraction of the listed in-window granules already decoded */
  backfill: number
  stale?: boolean
}

export interface LightningColumns {
  positions: Float32Array
  energy: Float32Array
  tsSec: Uint32Array
  sat: Uint8Array
}

export interface LightningSection {
  name: keyof LightningColumns
  type: 'f32' | 'u32' | 'u8'
  size: number
  offset: number
}

export type LightningHeader = LightningMeta & { dataOffset: number; sections: LightningSection[] }

interface Granule {
  key: string
  tsSec: number
  batch: FlashBatch
}

interface SourceState {
  def: LightningSource
  granules: Map<string, Granule>
  /** keys we've listed; pending/retry are fetchable, failed is given up */
  known: Map<string, 'pending' | 'retry' | 'done' | 'failed'>
  everListed: boolean
  lastListAt: number
}

// ---------------------------------------------------------------------------
// GOES GLM sources (keyless public S3)
// ---------------------------------------------------------------------------

/** `_s20261980102200_` in an object key → epoch seconds (year, DOY, HHMMSS). */
export function granuleEpochSec(key: string): number {
  const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d_/.exec(key)
  if (!m) return 0
  const [, y, doy, h, min, s] = m
  return (
    Date.UTC(Number(y), 0, 1, Number(h), Number(min), Number(s)) / 1000 +
    (Number(doy) - 1) * 86400
  )
}

/** hour prefixes (YYYY/DDD/HH) covering [now - windowMin - slack, now] */
function hourPrefixes(nowSec: number, windowMin: number): string[] {
  const out: string[] = []
  for (let t = nowSec - windowMin * 60 - 3600; t <= nowSec; t += 3600) {
    const d = new Date(Math.floor(t / 3600) * 3600 * 1000)
    const doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1) / 1000) / 86400) + 1
    out.push(
      `GLM-L2-LCFA/${d.getUTCFullYear()}/${String(doy).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`,
    )
  }
  return [...new Set(out)].slice(-3) // window ≤ 60 min spans at most 3 hour-dirs
}

async function listS3Keys(bucket: string, prefix: string): Promise<string[]> {
  const url = `https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`S3 list ${bucket} ${res.status}`)
  const xml = await res.text()
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])
}

const attrNum = (v: unknown): number => {
  if (v == null) return NaN
  if (typeof v === 'number') return v
  if (ArrayBuffer.isView(v)) return Number((v as unknown as ArrayLike<number>)[0])
  if (Array.isArray(v)) return Number(v[0])
  return Number(v)
}

let decodeSeq = 0

/**
 * Decode an HDF5/NetCDF-4 buffer via h5wasm and hand the open file to `read`.
 * h5wasm/node is NODERAWFS — these are REAL files, so they live in the OS
 * temp dir (not the cwd) with pid-unique names: the proxy and the bake script
 * can run concurrently from the same directory (review finding).
 */
export async function withH5<T>(buf: ArrayBuffer, read: (f: InstanceType<typeof h5wasm.File>) => T): Promise<T> {
  const Module = await h5wasm.ready
  const { FS } = Module
  const tmp = join(tmpdir(), `ember-li-${process.pid}-${decodeSeq++}.nc`)
  FS.writeFile(tmp, new Uint8Array(buf))
  let f: InstanceType<typeof h5wasm.File> | undefined
  try {
    f = new h5wasm.File(tmp, 'r')
    return read(f)
  } finally {
    f?.close()
    try {
      FS.unlink(tmp)
    } catch {
      /* already gone */
    }
  }
}

export function h5Dataset(
  f: InstanceType<typeof h5wasm.File>,
  name: string,
): { value: unknown; attrs: Record<string, { value: unknown }> } {
  const d = f.get(name)
  if (!d || !('value' in d)) throw new Error(`granule missing dataset ${name}`)
  return d as { value: unknown; attrs: Record<string, { value: unknown }> }
}

async function fetchGlmGranule(bucket: string, key: string): Promise<FlashBatch> {
  const res = await fetch(`https://${bucket}.s3.amazonaws.com/${key}`, {
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`S3 get ${res.status}`)
  const buf = await res.arrayBuffer()

  return withH5(buf, (f) => {
    const lat = h5Dataset(f, 'flash_lat').value as Float32Array
    const lon = h5Dataset(f, 'flash_lon').value as Float32Array
    const q = h5Dataset(f, 'flash_quality_flag').value as Int16Array
    const eRaw = h5Dataset(f, 'flash_energy')
    const eVal = eRaw.value as Int16Array
    // energy is a scaled int16 in joules, declared `_Unsigned: true` — h5wasm
    // reads it signed, so the strongest flashes wrap negative unless converted
    // back to unsigned (review finding: superbolts would be silently culled).
    const scale = attrNum(eRaw.attrs['scale_factor']?.value)
    const offset = attrNum(eRaw.attrs['add_offset']?.value)
    const toFJ = (signedRaw: number) => {
      const raw = signedRaw < 0 ? signedRaw + 0x10000 : signedRaw
      return Number.isFinite(scale)
        ? (raw * scale + (Number.isFinite(offset) ? offset : 0)) * 1e15
        : raw
    }

    const n = lat.length
    const outLon = new Float32Array(n)
    const outLat = new Float32Array(n)
    const outEnergy = new Float32Array(n)
    let m = 0
    for (let i = 0; i < n; i++) {
      if (q[i] !== 0) continue // keep only good-quality flashes
      outLon[m] = lon[i]
      outLat[m] = lat[i]
      // signed -1 is the unsigned 65535 _FillValue — position is still real,
      // render the flash at minimum energy rather than as a fake superbolt
      outEnergy[m] = eVal[i] === -1 ? 0 : toFJ(eVal[i])
      m++
    }
    return {
      lon: outLon.subarray(0, m),
      lat: outLat.subarray(0, m),
      energy: outEnergy.subarray(0, m),
    }
  })
}

function glmSource(id: string, name: string, bucket: string, lonSubSat: number): LightningSource {
  return {
    id,
    name,
    lonSubSat,
    cadenceSec: 20,
    enabled: () => true,
    listIntervalSec: 0,
    list: async (nowSec, windowMin) => {
      const prefixes = hourPrefixes(nowSec, windowMin)
      const lists = await Promise.all(prefixes.map((p) => listS3Keys(bucket, p)))
      return lists.flat()
    },
    keyEpochSec: granuleEpochSec,
    fetch: (key) => fetchGlmGranule(bucket, key),
  }
}

// ---------------------------------------------------------------------------
// Ingest core (source-agnostic)
// ---------------------------------------------------------------------------

const SOURCES: LightningSource[] = [
  glmSource('G18', 'GOES-West', 'noaa-goes18', -137.2),
  glmSource('G19', 'GOES-East', 'noaa-goes19', -75.2),
  ...createMtgSources(),
]

const state: SourceState[] = SOURCES.map((def) => ({
  def,
  granules: new Map(),
  known: new Map(),
  everListed: false,
  lastListAt: 0,
}))

const activeStates = () => state.filter((s) => s.def.enabled())

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]
      await run(item)
    }
  })
  await Promise.all(workers)
}

/**
 * One ingest cycle: refresh listings, fetch a batch of missing granules
 * (newest first, so "now" fills before history), evict outside the window.
 * Returns how many granules are still pending across sources.
 */
export async function ingestCycle(batch = FETCH_BATCH): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000)
  let pendingTotal = 0

  for (const s of activeStates()) {
    // 1. list — tolerate a source being unreachable, others keep going
    if (nowSec - s.lastListAt >= s.def.listIntervalSec) {
      try {
        const keys = await s.def.list(nowSec, LIGHTNING_WINDOW_MIN)
        s.everListed = true
        s.lastListAt = nowSec
        for (const key of keys) {
          if (!s.known.has(key) && s.def.keyEpochSec(key) >= nowSec - EVICT_MIN * 60) {
            s.known.set(key, 'pending')
          }
        }
      } catch (err) {
        console.error(`[lightning] list ${s.def.id} failed:`, (err as Error).message)
      }
    }

    // 2. fetch a newest-first batch of pending keys
    const pending = [...s.known.entries()]
      .filter(([, st]) => st === 'pending' || st === 'retry')
      .map(([k]) => k)
      .sort()
      .reverse()
    const take = pending.slice(0, batch)
    await pool(take, FETCH_CONCURRENCY, async (key) => {
      try {
        const batchData = await s.def.fetch(key)
        s.granules.set(key, { key, tsSec: s.def.keyEpochSec(key), batch: batchData })
        s.known.set(key, 'done')
      } catch (err) {
        // one retry on a later cycle, then give up so backfill can reach 1
        const st = s.known.get(key)
        s.known.set(key, st === 'pending' ? 'retry' : 'failed')
        console.error(`[lightning] ${s.def.id} ${key.slice(-48)} failed:`, (err as Error).message)
      }
    })

    // 3. evict granules (and listing memory) older than the window + slack
    const cutoff = nowSec - EVICT_MIN * 60
    for (const [key, g] of s.granules) if (g.tsSec < cutoff) s.granules.delete(key)
    for (const key of s.known.keys()) if (s.def.keyEpochSec(key) < cutoff) s.known.delete(key)

    pendingTotal += [...s.known.values()].filter((st) => st === 'pending' || st === 'retry').length
  }
  return pendingTotal
}

// ---------------------------------------------------------------------------
// Lazy background polling: starts on first payload request, stops when idle.
// ---------------------------------------------------------------------------
let loopRunning = false
let lastRequestAt = 0

function ensureIngestLoop() {
  lastRequestAt = Date.now()
  if (loopRunning) return
  loopRunning = true
  ;(async () => {
    console.log('[lightning] ingest loop started')
    while (Date.now() - lastRequestAt < IDLE_STOP_MS) {
      let backlog = 0
      try {
        backlog = await ingestCycle()
      } catch (err) {
        console.error('[lightning] ingest cycle failed:', (err as Error).message)
      }
      await new Promise((r) => setTimeout(r, backlog > 0 ? CYCLE_BACKFILL_MS : CYCLE_ACTIVE_MS))
    }
    loopRunning = false
    console.log('[lightning] ingest loop idle-stopped')
  })()
}

const align4 = (n: number) => (n + 3) & ~3

/** Pack meta + columns into the FIRMS-style wire format (see server/firms.ts). */
export function encodeLightning(meta: LightningMeta, columns: LightningColumns): Uint8Array {
  const order: Array<{ name: keyof LightningColumns; type: LightningSection['type']; size: number }> = [
    { name: 'positions', type: 'f32', size: 2 },
    { name: 'energy', type: 'f32', size: 1 },
    { name: 'tsSec', type: 'u32', size: 1 },
    { name: 'sat', type: 'u8', size: 1 },
  ]
  const sections: LightningSection[] = []
  let cursor = 0
  for (const { name, type, size } of order) {
    cursor = align4(cursor)
    sections.push({ name, type, size, offset: cursor })
    cursor += columns[name].byteLength
  }
  const dataLength = align4(cursor)

  let headerBytes = new TextEncoder().encode(JSON.stringify({ ...meta, dataOffset: 0, sections }))
  let dataOffset = align4(4 + headerBytes.byteLength)
  const header: LightningHeader = { ...meta, dataOffset, sections }
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

/** Merge the rolling store into one window payload. */
function buildPayload(mode: LightningMeta['mode']): { meta: LightningMeta; bin: Uint8Array } {
  const nowSec = Math.floor(Date.now() / 1000)
  const cutoff = nowSec - LIGHTNING_WINDOW_MIN * 60
  const states = activeStates()

  // Per-flash time filtering: a product whose START is outside the window can
  // still hold in-window flashes (MTG products span 10 minutes).
  let total = 0
  for (const s of states)
    for (const g of s.granules.values()) {
      const ts = g.batch.tsSec
      if (ts) {
        for (let i = 0; i < ts.length; i++) if (ts[i] >= cutoff) total++
      } else if (g.tsSec >= cutoff) {
        total += g.batch.lon.length
      }
    }

  const positions = new Float32Array(total * 2)
  const energy = new Float32Array(total)
  const tsSec = new Uint32Array(total)
  const sat = new Uint8Array(total)

  const sats: SatMeta[] = []
  let listedInWindow = 0
  let doneInWindow = 0
  let m = 0
  for (let si = 0; si < states.length; si++) {
    const s = states[si]
    let flashCount = 0
    let lastGranuleSec = 0
    for (const g of s.granules.values()) {
      const perFlash = g.batch.tsSec
      if (!perFlash && g.tsSec < cutoff) continue
      lastGranuleSec = Math.max(lastGranuleSec, g.tsSec)
      for (let i = 0; i < g.batch.lon.length; i++) {
        const ts = perFlash ? perFlash[i] : g.tsSec
        if (ts < cutoff) continue
        positions[m * 2] = g.batch.lon[i]
        positions[m * 2 + 1] = g.batch.lat[i]
        energy[m] = g.batch.energy[i]
        tsSec[m] = ts
        sat[m] = si
        m++
        flashCount++
      }
    }
    let pendingKeys = 0
    let failedKeys = 0
    for (const [key, st] of s.known) {
      if (s.def.keyEpochSec(key) < cutoff) continue
      listedInWindow++
      if (st === 'pending' || st === 'retry') pendingKeys++
      else {
        doneInWindow++
        if (st === 'failed') failedKeys++
      }
    }
    sats.push({
      id: s.def.id,
      name: s.def.name,
      lonSubSat: s.def.lonSubSat,
      cadenceSec: s.def.cadenceSec,
      lastGranuleSec,
      flashCount,
      pendingKeys,
      failedKeys,
      everListed: s.everListed,
    })
  }

  const meta: LightningMeta = {
    source: 'glm',
    windowMin: LIGHTNING_WINDOW_MIN,
    mode,
    fetchedAt: new Date().toISOString(),
    count: m,
    sats,
    // No listings at all means nothing is fillable — report complete rather
    // than a forever "filling 0%"; the per-sat DARK chips carry the honesty
    // for that failure mode (review finding).
    backfill: listedInWindow > 0 ? doneInWindow / listedInWindow : 1,
  }
  return {
    meta,
    bin: encodeLightning(meta, {
      positions: positions.subarray(0, m * 2),
      energy: energy.subarray(0, m),
      tsSec: tsSec.subarray(0, m),
      sat: sat.subarray(0, m),
    }),
  }
}

let payloadCache: { at: number; meta: LightningMeta; bin: Uint8Array } | null = null
const PAYLOAD_TTL_MS = 15_000

/**
 * Live-mode entry point (Hono route). Starts/keeps the background ingest
 * running and serves the current rolling window; the first calls return a
 * partial window that fills as backfill completes (meta.backfill → 1).
 */
export function getLightningPayload(): { meta: LightningMeta; bin: Uint8Array } {
  ensureIngestLoop()
  if (payloadCache && Date.now() - payloadCache.at < PAYLOAD_TTL_MS) return payloadCache
  const built = buildPayload('live')
  payloadCache = { at: Date.now(), ...built }
  return built
}

/**
 * Baked-mode entry point (scripts/bake-data.ts): fetch the full window in one
 * shot — no budget, no background loop — and return the encoded payload.
 */
export async function fetchLightningOnce(): Promise<{ meta: LightningMeta; bin: Uint8Array }> {
  // At least two rounds ALWAYS: a transient listing timeout on round one
  // (observed from Actions runners against EUMETSAT) must get a retry in a
  // one-shot bake — failed listings don't count toward the backlog.
  let backlog = await ingestCycle(1000)
  for (let round = 0; (backlog > 0 || round < 1) && round < 5; round++) {
    backlog = await ingestCycle(1000)
  }
  return buildPayload('baked')
}
