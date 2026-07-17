/**
 * EUMETSAT MTG-I1 Lightning Imager (LI) L2 "Lightning Flashes" (LFL) source
 * for the lightning globe — extends coverage from the Americas (GOES GLM) to
 * Europe / Africa / Middle East / Atlantic.
 *
 * Access model (docs/DECISIONS.md): free but keyed. EUMETSAT_CONSUMER_KEY /
 * EUMETSAT_CONSUMER_SECRET live in GitHub Actions secrets (Pages bake) or
 * .env (VPS) — never in client code. Without them this source reports
 * enabled() === false and is omitted from payloads entirely (the UI shows
 * nothing rather than a fake DARK satellite).
 *
 * Pipeline per product (one product every 10 minutes, published ~1–5 min
 * after its window closes):
 *   keyless browse API → product ids → OAuth2 client-credentials token →
 *   download zip → unzip (fflate) → NetCDF-4 body via h5wasm → per-flash
 *   lat/lon/time/intensity.
 *
 * LI reports flash *radiance* (mW·m⁻²·sr⁻¹), not optical energy like GLM's
 * joules. The wire format's `energy` column is treated as "sensor-native
 * optical intensity on a per-satellite relative scale": LI radiance is
 * multiplied by LI_INTENSITY_SCALE so its dynamic range lands in the same
 * numeric band the render ramp expects. Nothing in the UI displays the
 * number with units — color/size only — and DECISIONS.md documents this.
 */
import { unzipSync } from 'fflate'
import type { FlashBatch, LightningSource } from './glm'
import { h5Dataset, withH5 } from './glm'

const API = 'https://api.eumetsat.int'
const COLLECTION = 'EO:EUM:DAT:0691' // LI L2 Lightning Flashes (LFL)

const key = () => (process.env.EUMETSAT_CONSUMER_KEY ?? '').trim()
const secret = () => (process.env.EUMETSAT_CONSUMER_SECRET ?? '').trim()

// ---------------------------------------------------------------------------
// OAuth2 client-credentials token, cached until shortly before expiry.
// ---------------------------------------------------------------------------
let tokenCache: { token: string; expiresAt: number } | null = null

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token
  const basic = Buffer.from(`${key()}:${secret()}`).toString('base64')
  const res = await fetch(`${API}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.text()
  if (!res.ok) {
    tokenCache = null
    // NEVER log the body verbatim: the error_description field echoes the
    // consumer key ("...could not be found for client_id: <KEY>"), which
    // would leak the credential into CI logs (research finding).
    let code = `http ${res.status}`
    try {
      const parsed = JSON.parse(body) as { error?: string }
      if (parsed.error) code = parsed.error
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`EUMETSAT token rejected (${code}) — check EUMETSAT_CONSUMER_KEY/SECRET`)
  }
  const j = JSON.parse(body) as { access_token?: string; expires_in?: number }
  if (!j.access_token) throw new Error(`EUMETSAT token response missing access_token: ${body.slice(0, 160)}`)
  tokenCache = {
    token: j.access_token,
    // refresh 2 min early; default lifetime is ~1h
    expiresAt: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000,
  }
  return tokenCache.token
}

// ---------------------------------------------------------------------------
// Product discovery (keyless browse API) + id → time parsing
// ---------------------------------------------------------------------------

/** product ids carry coverage start/end as ..._OPE_<start14>_<end14>_... */
export function mtgProductEpochSec(id: string): number {
  const m = /_(?:OPE|VAL)_(\d{14})_(\d{14})/.exec(id)
  if (!m) return 0
  const t = m[1]
  return (
    Date.UTC(
      Number(t.slice(0, 4)),
      Number(t.slice(4, 6)) - 1,
      Number(t.slice(6, 8)),
      Number(t.slice(8, 10)),
      Number(t.slice(10, 12)),
      Number(t.slice(12, 14)),
    ) / 1000
  )
}

async function listProducts(nowSec: number, windowMin: number): Promise<string[]> {
  // browse API is organized by UTC hour — cover [now - window - slack, now]
  const hours: string[] = []
  for (let t = nowSec - windowMin * 60 - 3600; t <= nowSec; t += 3600) {
    const d = new Date(Math.floor(t / 3600) * 3600 * 1000)
    hours.push(
      `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/times/${String(d.getUTCHours()).padStart(2, '0')}`,
    )
  }
  // parallel + generous timeout: the browse API has been observed to take
  // >30 s from GitHub Actions runners (fast from elsewhere), and a one-shot
  // bake only gets a couple of retry rounds
  const uniq = [...new Set(hours)].slice(-3)
  const pages = await Promise.all(
    uniq.map(async (h) => {
      const url = `${API}/data/browse/1.0.0/collections/${encodeURIComponent(COLLECTION)}/dates/${h}/products?format=json`
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) })
      if (!res.ok) throw new Error(`EUMETSAT browse ${res.status}`)
      return (await res.json()) as { products?: Array<{ id?: string } | string> }
    }),
  )
  const ids: string[] = []
  for (const j of pages) {
    for (const p of j.products ?? []) {
      const id = typeof p === 'string' ? p : p.id
      if (id) ids.push(id)
    }
  }
  return ids
}

// ---------------------------------------------------------------------------
// Product download + decode
// ---------------------------------------------------------------------------

/** Multiply LI radiance into the numeric band the render ramp expects
 *  (calibrated against real payloads after first deploy; see DECISIONS). */
const LI_INTENSITY_SCALE = 1

/** Try several dataset paths (LI files have used both root and grouped
 *  layouts across processor versions); first hit wins. */
function firstDataset(
  f: Parameters<Parameters<typeof withH5>[1]>[0],
  candidates: string[],
): ReturnType<typeof h5Dataset> | null {
  for (const c of candidates) {
    try {
      return h5Dataset(f, c)
    } catch {
      /* try next */
    }
  }
  return null
}

/** Recursive key listing for decode-failure diagnostics (depth 2). */
function describeStructure(f: { keys(): string[]; get(name: string): unknown }): string {
  const out: string[] = []
  for (const k of f.keys().slice(0, 40)) {
    out.push(k)
    try {
      const child = f.get(k) as { keys?: () => string[] }
      if (child && typeof child.keys === 'function') {
        for (const k2 of child.keys().slice(0, 40)) out.push(`${k}/${k2}`)
      }
    } catch {
      /* leaf */
    }
  }
  return out.join(', ').slice(0, 600)
}

const attrNum = (v: unknown): number => {
  if (v == null) return NaN
  if (typeof v === 'number') return v
  if (ArrayBuffer.isView(v)) return Number((v as unknown as ArrayLike<number>)[0])
  if (Array.isArray(v)) return Number(v[0])
  return Number(v)
}

const asF64 = (v: unknown): Float64Array => {
  if (v instanceof Float64Array) return v
  const a = v as ArrayLike<number>
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = Number(a[i])
  return out
}

/** parse "seconds since 2000-01-01 00:00:00[.000][Z]" style units → epoch sec */
function unitsEpochSec(units: unknown): number | null {
  if (typeof units !== 'string') return null
  const m = /since\s+(\d{4}-\d{2}-\d{2})[T ]?(\d{2}:\d{2}:\d{2}(?:\.\d+)?)?/.exec(units)
  if (!m) return null
  const ms = Date.parse(`${m[1]}T${m[2] ?? '00:00:00'}Z`)
  return Number.isFinite(ms) ? ms / 1000 : null
}

async function fetchProduct(id: string): Promise<FlashBatch> {
  const token = await getToken()
  const url = `${API}/data/download/1.0.0/collections/${encodeURIComponent(COLLECTION)}/products/${encodeURIComponent(id)}`
  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  })
  if (res.status === 401 || res.status === 403) {
    // token may have been revoked/expired early — refresh once and retry
    tokenCache = null
    const fresh = await getToken()
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${fresh}` },
      signal: AbortSignal.timeout(120_000),
    })
  }
  if (!res.ok) throw new Error(`EUMETSAT download ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const zipBuf = new Uint8Array(await res.arrayBuffer())

  // the product zip carries a BODY NetCDF (the flashes), a small TRAIL .nc,
  // and metadata XML — prefer the BODY entry by name, largest .nc otherwise
  const entries = unzipSync(zipBuf)
  let body: Uint8Array | null = null
  let bodyName = ''
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.toLowerCase().endsWith('.nc')) continue
    const isBody = name.includes('BODY')
    const currentIsBody = bodyName.includes('BODY')
    if (!body || (isBody && !currentIsBody) || (isBody === currentIsBody && bytes.byteLength > body.byteLength)) {
      body = bytes
      bodyName = name
    }
  }
  if (!body) throw new Error(`no .nc entry in product zip (entries: ${Object.keys(entries).join(', ').slice(0, 300)})`)

  const productStart = mtgProductEpochSec(id)
  const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer

  // LFL structure per the official format spec (EUM/MTG/SPE/10/0452 A.6),
  // cross-checked against satpy's operational reader and a real-file ncdump:
  // all variables at the NetCDF root; latitude/longitude are SCALED int16
  // (fill -32767); radiance is uint16 (fill 65535) scaled to mW·m⁻²·sr⁻¹;
  // flash_time is per-flash float64 "seconds since 2000-01-01 00:00:00.0"
  // UTC. flash_filter_confidence is deliberately NOT used to cull: the spec
  // defines it inverted (0 = high confidence of a true flash) while
  // operational files changed its type/scaling — misreading it would drop
  // real flashes, so all quality-controlled L2 flashes render.
  return withH5(buf, (f) => {
    const latDs = firstDataset(f, ['latitude', 'data/latitude', 'flash_latitude'])
    const lonDs = firstDataset(f, ['longitude', 'data/longitude', 'flash_longitude'])
    if (!latDs || !lonDs) {
      throw new Error(
        `LFL body ${bodyName}: lat/lon datasets not found — structure: ${describeStructure(f as never)}`,
      )
    }
    const radDs = firstDataset(f, ['radiance', 'data/radiance', 'flash_radiance'])
    const timeDs = firstDataset(f, ['flash_time', 'data/flash_time', 'time'])

    // CF scaling; some LI files carried a misspelled `scaling_factor`
    // attribute (satpy keeps the same fallback)
    const scaleOf = (ds: { attrs: Record<string, { value: unknown }> }) => {
      const s = attrNum(ds.attrs['scale_factor']?.value ?? ds.attrs['scaling_factor']?.value)
      return Number.isFinite(s) ? s : NaN
    }
    const fillOf = (ds: { attrs: Record<string, { value: unknown }> }, dflt: number) => {
      const v = attrNum(ds.attrs['_FillValue']?.value)
      return Number.isFinite(v) ? v : dflt
    }

    const latRaw = latDs.value as ArrayLike<number>
    const lonRaw = lonDs.value as ArrayLike<number>
    const latScale = scaleOf(latDs)
    const latOff = attrNum(latDs.attrs['add_offset']?.value)
    const lonScale = scaleOf(lonDs)
    const lonOff = attrNum(lonDs.attrs['add_offset']?.value)
    const latFill = fillOf(latDs, -32767)
    const lonFill = fillOf(lonDs, -32767)
    const applyScale = (raw: number, scale: number, off: number) =>
      Number.isFinite(scale) ? raw * scale + (Number.isFinite(off) ? off : 0) : raw

    const n = latRaw.length
    const lon = new Float32Array(n)
    const lat = new Float32Array(n)
    const energy = new Float32Array(n)
    const tsSec = new Uint32Array(n)

    // per-flash times: absolute seconds relative to the units epoch; fall
    // back to the product window mid-point when absent/unparseable
    let timeVals: Float64Array | null = null
    let timeEpoch: number | null = null
    let timeScale = 1
    if (timeDs) {
      timeVals = asF64(timeDs.value)
      timeEpoch = unitsEpochSec(timeDs.attrs['units']?.value)
      const s = scaleOf(timeDs)
      if (Number.isFinite(s)) timeScale = s
    }
    const fallbackTs = productStart > 0 ? productStart + 300 : Math.floor(Date.now() / 1000)

    let radVals: Float64Array | null = null
    let radScale = 1
    let radOff = 0
    let radFill = 65535
    if (radDs) {
      radVals = asF64(radDs.value)
      const s = scaleOf(radDs)
      const o = attrNum(radDs.attrs['add_offset']?.value)
      if (Number.isFinite(s)) radScale = s
      if (Number.isFinite(o)) radOff = o
      radFill = fillOf(radDs, 65535)
    }

    let m = 0
    for (let i = 0; i < n; i++) {
      const rawLa = Number(latRaw[i])
      const rawLo = Number(lonRaw[i])
      if (rawLa === latFill || rawLo === lonFill) continue
      const la = applyScale(rawLa, latScale, latOff)
      const lo = applyScale(rawLo, lonScale, lonOff)
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) continue
      lat[m] = la
      lon[m] = lo
      // fill-valued radiance renders at minimum intensity, position is real
      const rad =
        radVals && radVals[i] !== radFill ? Math.max(0, radVals[i] * radScale + radOff) : 0
      energy[m] = rad * LI_INTENSITY_SCALE
      let ts = fallbackTs
      if (timeVals && timeEpoch !== null) {
        const cand = timeEpoch + timeVals[i] * timeScale
        // sanity: within the product window ± slack
        if (productStart === 0 || (cand > productStart - 900 && cand < productStart + 1500)) ts = Math.floor(cand)
      }
      tsSec[m] = ts
      m++
    }
    return {
      lon: lon.subarray(0, m),
      lat: lat.subarray(0, m),
      energy: energy.subarray(0, m),
      tsSec: tsSec.subarray(0, m),
    }
  })
}

// ---------------------------------------------------------------------------

export function createMtgSources(): LightningSource[] {
  return [
    {
      id: 'MTI1',
      name: 'Meteosat MTG-I1',
      lonSubSat: 0,
      cadenceSec: 600,
      enabled: () => Boolean(key() && secret()),
      // keyless browse, but 10-min products — no need to list more than
      // every 2 minutes
      listIntervalSec: 120,
      list: listProducts,
      keyEpochSec: mtgProductEpochSec,
      fetch: fetchProduct,
    },
  ]
}
