/**
 * Shared FIRMS logic: CSV parsing, confidence/time normalization, and the
 * binary wire format. Used by the live Hono proxy (server/index.ts) and the
 * static data baker for GitHub Pages (scripts/bake-data.ts).
 *
 * Wire format:
 *   [0..4)          uint32 LE — byte length of the JSON header (H)
 *   [4..4+H)        UTF-8 JSON header (BinaryHeader)
 *   [dataOffset..)  parallel arrays, each 4-byte aligned, laid out per
 *                   header.sections (offsets relative to dataOffset)
 */

export const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov'

/** Sources accepted by the FIRMS area API (§3.1). */
export const API_SOURCES = new Set([
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
export const PUBLIC_FEEDS: Record<string, string> = {
  VIIRS_NOAA20_NRT: 'noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global',
  VIIRS_NOAA21_NRT: 'noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global',
  VIIRS_SNPP_NRT: 'suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global',
  MODIS_NRT: 'modis-c6.1/csv/MODIS_C6_1_Global',
}

export type FeedWindow = '24h' | '48h' | '7d'

export const WINDOW_DAYS: Record<FeedWindow, number> = { '24h': 1, '48h': 2, '7d': 7 }

/** Nearest public-feed window covering a 1–10 day request. */
export function windowForDays(days: number): FeedWindow {
  return days <= 1 ? '24h' : days <= 2 ? '48h' : '7d'
}

export interface FireColumns {
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

export interface PayloadMeta {
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

export interface BinarySection {
  name: keyof FireColumns
  type: 'f32' | 'u32' | 'u8'
  /** elements per point (2 for positions, 1 otherwise) */
  size: number
  /** byte offset relative to dataOffset */
  offset: number
}

export type BinaryHeader = PayloadMeta & { dataOffset: number; sections: BinarySection[] }

/** VIIRS letters, public-feed words, and MODIS 0–100 → one 0–2 scale. */
export function normalizeConfidence(raw: string): number {
  const s = raw.trim().toLowerCase()
  if (s === 'l' || s === 'low') return 0
  if (s === 'n' || s === 'nominal') return 1
  if (s === 'h' || s === 'high') return 2
  const n = Number(s)
  if (Number.isFinite(n)) return n < 30 ? 0 : n < 80 ? 1 : 2
  return 1
}

/** acq_date "2026-07-15" + acq_time "0030" (or unpadded "30") → epoch seconds UTC. */
export function acqEpochSec(date: string, time: string): number {
  const t = time.trim().padStart(4, '0')
  const ms = Date.parse(`${date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

/** FIRMS CSV has no quoted fields, so a plain split is safe. */
export function parseFirmsCsv(csv: string): { count: number; columns: FireColumns } {
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
export function encodeBinary(meta: PayloadMeta, columns: FireColumns): Uint8Array {
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

/** Reconstruct typed-array columns from an encoded payload. */
export function decodeBinaryColumns(bin: Uint8Array): { header: BinaryHeader; columns: FireColumns } {
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const headerLen = view.getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(bin.subarray(4, 4 + headerLen))) as BinaryHeader
  const at = (s: BinarySection) => bin.byteOffset + header.dataOffset + s.offset
  const get = (name: keyof FireColumns) => {
    const s = header.sections.find((x) => x.name === name)
    if (!s) throw new Error(`payload missing section ${name}`)
    return s
  }
  const f32 = (name: keyof FireColumns) => {
    const s = get(name)
    return new Float32Array(bin.buffer, at(s), header.count * s.size)
  }
  return {
    header,
    columns: {
      positions: f32('positions'),
      frp: f32('frp'),
      tsSec: new Uint32Array(bin.buffer, at(get('tsSec')), header.count),
      bright: f32('bright'),
      conf: new Uint8Array(bin.buffer, at(get('conf')), header.count),
      night: new Uint8Array(bin.buffer, at(get('night')), header.count),
    },
  }
}

/**
 * Fetch one FIRMS dataset and encode it. With a MAP_KEY this uses the area
 * API (any source, exact day windows); without, the public keyless feeds.
 */
export async function fetchAndEncode(
  source: string,
  days: number,
  mapKey: string,
): Promise<{ meta: PayloadMeta; bin: Uint8Array }> {
  let url: string
  let mode: PayloadMeta['mode']
  let coverageDays: number
  if (mapKey) {
    url = `${FIRMS_BASE}/api/area/csv/${mapKey}/${source}/world/${days}`
    mode = 'api'
    coverageDays = days
  } else {
    const feed = PUBLIC_FEEDS[source]
    if (!feed) throw new Error(`source ${source} requires a FIRMS_MAP_KEY (no public feed)`)
    const window = windowForDays(days)
    url = `${FIRMS_BASE}/data/active_fire/${feed}_${window}.csv`
    mode = 'public-feed'
    coverageDays = WINDOW_DAYS[window]
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  const body = await res.text()
  if (!res.ok) throw new Error(`FIRMS upstream ${res.status}: ${body.slice(0, 200)}`)
  // The API returns errors (bad key, quota) as a 200 text page, not CSV.
  if (!body.startsWith('latitude') && !body.includes('\nlatitude')) {
    throw new Error(`FIRMS returned non-CSV response: ${body.slice(0, 200)}`)
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
