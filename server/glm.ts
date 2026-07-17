/**
 * GOES GLM (Geostationary Lightning Mapper) ingest — the lightning globe's
 * data plane. NOAA publishes one L2 "LCFA" granule per satellite every
 * 20 seconds to public S3 buckets (keyless, public domain, ~230 KB NetCDF-4);
 * granules land ~10–30 s after observation. This module lists the buckets,
 * decodes granules with h5wasm (NetCDF-4 is HDF5 — Node's netcdfjs can't read
 * it), and maintains a rolling window of flashes per satellite, encoded into
 * the same binary wire conventions as the FIRMS payloads (see server/firms.ts).
 *
 * Coverage honesty (docs/DECISIONS.md): GOES-West (137.2°W) + GOES-East
 * (75.2°W) see the Americas and adjacent oceans — NOT the whole planet, and
 * either instrument can go dark (a multi-hour GOES-East outage was observed
 * while building this). Per-satellite freshness ships in the payload header
 * so the UI can say so instead of silently going dark. EUMETSAT's MTG Lightning
 * Imager (Europe/Africa) can extend coverage later behind EUMETSAT_KEY.
 *
 * Flash timestamps are quantized to the 20-second granule start (parsed from
 * the object key) — per-flash sub-second offsets exist in the file but are
 * irrelevant at the one-hour window this globe renders.
 */
import h5wasm from 'h5wasm/node'

export const LIGHTNING_WINDOW_MIN = 60
/** keep a little slack beyond the window so eviction never races the filter */
const EVICT_MIN = LIGHTNING_WINDOW_MIN + 5
/** granules fetched per satellite per ingest cycle (newest first) */
const FETCH_BATCH = 40
const FETCH_CONCURRENCY = 8
/** stop polling S3 when nobody has asked for lightning in a while */
const IDLE_STOP_MS = 10 * 60_000
const CYCLE_ACTIVE_MS = 20_000
const CYCLE_BACKFILL_MS = 2_000

export interface GlmSatellite {
  id: string
  name: string
  bucket: string
  /** sub-satellite longitude, °E — the center of its field of view */
  lonSubSat: number
}

export const GLM_SATELLITES: GlmSatellite[] = [
  { id: 'G18', name: 'GOES-West', bucket: 'noaa-goes18', lonSubSat: -137.2 },
  { id: 'G19', name: 'GOES-East', bucket: 'noaa-goes19', lonSubSat: -75.2 },
]

export interface LightningColumns {
  /** [lon, lat] interleaved */
  positions: Float32Array
  /** flash optical energy, femtojoules (raw joules × 1e15) */
  energy: Float32Array
  /** granule start, epoch seconds UTC (20 s quantization) */
  tsSec: Uint32Array
  /** index into GLM_SATELLITES */
  sat: Uint8Array
}

export interface SatMeta {
  id: string
  name: string
  /** epoch seconds of the newest decoded granule, 0 if none */
  lastGranuleSec: number
  flashCount: number
  /** granules listed in-window but not yet fetched (backfill in progress) */
  pendingKeys: number
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
  lon: Float32Array
  lat: Float32Array
  energy: Float32Array
}

interface SatState {
  def: GlmSatellite
  granules: Map<string, Granule>
  /** keys we've listed; pending/retry are fetchable, failed is given up */
  known: Map<string, 'pending' | 'retry' | 'done' | 'failed'>
}

const state: SatState[] = GLM_SATELLITES.map((def) => ({
  def,
  granules: new Map(),
  known: new Map(),
}))

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

/** hour prefixes (YYYY/DDD/HH) covering [now - windowMin, now] */
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

async function listKeys(bucket: string, prefix: string): Promise<string[]> {
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

/** Download one granule and extract quality-0 flashes. */
async function fetchGranule(bucket: string, key: string): Promise<Granule> {
  const res = await fetch(`https://${bucket}.s3.amazonaws.com/${key}`, {
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`S3 get ${res.status}`)
  const buf = await res.arrayBuffer()

  const Module = await h5wasm.ready
  const { FS } = Module
  const tmp = `glm-${decodeSeq++}.nc`
  FS.writeFile(tmp, new Uint8Array(buf))
  let f: InstanceType<typeof h5wasm.File> | undefined
  try {
    f = new h5wasm.File(tmp, 'r')
    const ds = (name: string) => {
      const d = f!.get(name)
      if (!d || !('value' in d)) throw new Error(`granule missing dataset ${name}`)
      return d as { value: unknown; attrs: Record<string, { value: unknown }> }
    }
    const lat = ds('flash_lat').value as Float32Array
    const lon = ds('flash_lon').value as Float32Array
    const q = ds('flash_quality_flag').value as Int16Array
    const eRaw = ds('flash_energy')
    const eVal = eRaw.value as Int16Array
    // energy is a scaled int16 in joules — decode and store as femtojoules
    const scale = attrNum(eRaw.attrs['scale_factor']?.value)
    const offset = attrNum(eRaw.attrs['add_offset']?.value)
    const toFJ = (raw: number) =>
      Number.isFinite(scale) ? (raw * scale + (Number.isFinite(offset) ? offset : 0)) * 1e15 : raw

    const n = lat.length
    const outLon = new Float32Array(n)
    const outLat = new Float32Array(n)
    const outEnergy = new Float32Array(n)
    let m = 0
    for (let i = 0; i < n; i++) {
      if (q[i] !== 0) continue // keep only good-quality flashes
      outLon[m] = lon[i]
      outLat[m] = lat[i]
      outEnergy[m] = toFJ(eVal[i])
      m++
    }
    return {
      key,
      tsSec: granuleEpochSec(key),
      lon: outLon.subarray(0, m),
      lat: outLat.subarray(0, m),
      energy: outEnergy.subarray(0, m),
    }
  } finally {
    f?.close()
    try {
      FS.unlink(tmp)
    } catch {
      /* already gone */
    }
  }
}

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
 * Returns how many granules are still pending across satellites.
 */
export async function ingestCycle(batch = FETCH_BATCH): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000)
  let pendingTotal = 0

  for (const s of state) {
    // 1. list — tolerate a satellite being unreachable, others keep going
    try {
      const prefixes = hourPrefixes(nowSec, LIGHTNING_WINDOW_MIN)
      const lists = await Promise.all(prefixes.map((p) => listKeys(s.def.bucket, p)))
      for (const key of lists.flat()) {
        if (!s.known.has(key) && granuleEpochSec(key) >= nowSec - EVICT_MIN * 60) {
          s.known.set(key, 'pending')
        }
      }
    } catch (err) {
      console.error(`[glm] list ${s.def.id} failed:`, (err as Error).message)
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
        const g = await fetchGranule(s.def.bucket, key)
        s.granules.set(key, g)
        s.known.set(key, 'done')
      } catch (err) {
        // one retry on a later cycle, then give up so backfill can reach 1
        const st = s.known.get(key)
        s.known.set(key, st === 'pending' ? 'retry' : 'failed')
        console.error(`[glm] granule ${key.slice(-40)} failed:`, (err as Error).message)
      }
    })

    // 3. evict granules (and listing memory) older than the window + slack
    const cutoff = nowSec - EVICT_MIN * 60
    for (const [key, g] of s.granules) if (g.tsSec < cutoff) s.granules.delete(key)
    for (const key of s.known.keys()) if (granuleEpochSec(key) < cutoff) s.known.delete(key)

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
    console.log('[glm] ingest loop started')
    while (Date.now() - lastRequestAt < IDLE_STOP_MS) {
      let backlog = 0
      try {
        backlog = await ingestCycle()
      } catch (err) {
        console.error('[glm] ingest cycle failed:', (err as Error).message)
      }
      await new Promise((r) => setTimeout(r, backlog > 0 ? CYCLE_BACKFILL_MS : CYCLE_ACTIVE_MS))
    }
    loopRunning = false
    console.log('[glm] ingest loop idle-stopped')
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

  let total = 0
  for (const s of state)
    for (const g of s.granules.values()) if (g.tsSec >= cutoff) total += g.lon.length

  const positions = new Float32Array(total * 2)
  const energy = new Float32Array(total)
  const tsSec = new Uint32Array(total)
  const sat = new Uint8Array(total)

  const sats: SatMeta[] = []
  let listedInWindow = 0
  let doneInWindow = 0
  let m = 0
  for (let si = 0; si < state.length; si++) {
    const s = state[si]
    let flashCount = 0
    let lastGranuleSec = 0
    for (const g of s.granules.values()) {
      if (g.tsSec < cutoff) continue
      lastGranuleSec = Math.max(lastGranuleSec, g.tsSec)
      for (let i = 0; i < g.lon.length; i++) {
        positions[m * 2] = g.lon[i]
        positions[m * 2 + 1] = g.lat[i]
        energy[m] = g.energy[i]
        tsSec[m] = g.tsSec
        sat[m] = si
        m++
      }
      flashCount += g.lon.length
    }
    let pendingKeys = 0
    for (const [key, st] of s.known) {
      if (granuleEpochSec(key) < cutoff) continue
      listedInWindow++
      if (st === 'pending' || st === 'retry') pendingKeys++
      else doneInWindow++
    }
    sats.push({ id: s.def.id, name: s.def.name, lastGranuleSec, flashCount, pendingKeys })
  }

  const meta: LightningMeta = {
    source: 'glm',
    windowMin: LIGHTNING_WINDOW_MIN,
    mode,
    fetchedAt: new Date().toISOString(),
    count: m,
    sats,
    backfill: listedInWindow > 0 ? doneInWindow / listedInWindow : 0,
  }
  return { meta, bin: encodeLightning(meta, { positions, energy, tsSec, sat }) }
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
  let backlog = await ingestCycle(1000)
  for (let round = 0; backlog > 0 && round < 5; round++) backlog = await ingestCycle(1000)
  return buildPayload('baked')
}
