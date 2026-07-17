import { decodeFireBinary } from './binary'
import { decodeLightningBinary } from './lightningBinary'
import type { DecodedFire, DecodedLightning, EonetEvent, SeverePayload } from './types'

export const DEFAULT_SOURCE = 'VIIRS_NOAA20_NRT'

/** Auto-refresh cadence (§5.2/§8) — matches the proxy cache TTL. */
export const REFRESH_MS = 10 * 60 * 1000

/**
 * Static mode (GitHub Pages): no proxy exists — a scheduled Action bakes the
 * same binary payloads to /data/*.bin and the app fetches those instead.
 * The ?v= tick makes each auto-refresh revalidate the CDN cache.
 */
const STATIC_MODE = import.meta.env.VITE_DATA_MODE === 'static'
const cacheTick = () => Math.floor(Date.now() / REFRESH_MS)
const windowFor = (days: number) => (days <= 1 ? '24h' : days <= 2 ? '48h' : '7d')

/**
 * Fetch + decode the binary hotspot payload. Render attributes are derived
 * separately (per quality tier) so a quality switch never refetches.
 */
export async function fetchFireDecoded(source = DEFAULT_SOURCE, days = 1): Promise<DecodedFire> {
  const url = STATIC_MODE
    ? `${import.meta.env.BASE_URL}data/hotspots-${source}-${windowFor(days)}.bin?v=${cacheTick()}`
    : `/api/hotspots?source=${encodeURIComponent(source)}&days=${days}`
  const res = await fetch(url)
  if (!res.ok) {
    if (STATIC_MODE) {
      throw new Error(
        res.status === 404
          ? `${source} not in the baked feed (see the Pages workflow)`
          : `data fetch failed (${res.status})`,
      )
    }
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `hotspots request failed (${res.status})`)
  }
  return decodeFireBinary(await res.arrayBuffer())
}

/**
 * Lightning refresh: GLM granules land every 20 s and the proxy keeps a
 * ~15 s payload cache, so live mode polls each minute. Baked mode (Pages)
 * only changes when the cron redeploys — poll on the fire cadence.
 */
export const LIGHTNING_REFRESH_MS = STATIC_MODE ? REFRESH_MS : 60_000

export async function fetchLightningDecoded(): Promise<DecodedLightning> {
  const url = STATIC_MODE
    ? `${import.meta.env.BASE_URL}data/lightning.bin?v=${Math.floor(Date.now() / LIGHTNING_REFRESH_MS)}`
    : '/api/lightning'
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      STATIC_MODE && res.status === 404
        ? 'lightning not in the baked feed yet (next Pages deploy adds it)'
        : `lightning request failed (${res.status})`,
    )
  }
  return decodeLightningBinary(await res.arrayBuffer())
}

/** NWS warnings update within seconds of issuance — poll live mode fast. */
export const SEVERE_REFRESH_MS = STATIC_MODE ? REFRESH_MS : 60_000

export async function fetchSevere(): Promise<SeverePayload> {
  const url = STATIC_MODE
    ? `${import.meta.env.BASE_URL}data/severe.json?v=${Math.floor(Date.now() / SEVERE_REFRESH_MS)}`
    : '/api/severe'
  const res = await fetch(url)
  if (!res.ok) {
    if (STATIC_MODE) {
      throw new Error(
        res.status === 404
          ? 'severe weather not in the baked feed yet (next Pages deploy adds it)'
          : `severe request failed (${res.status})`,
      )
    }
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.error === 'string' ? body.error : ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `severe request failed (${res.status})`)
  }
  return res.json()
}

export interface HealthInfo {
  ok: boolean
  hasKey: boolean
}

/** FIRMS quota status for the ?debug corner (§3.1). Null when unavailable. */
export async function fetchQuota(): Promise<{ current: number; limit: number } | null> {
  if (STATIC_MODE) return null
  try {
    const res = await fetch('/api/quota')
    if (!res.ok) return null
    const j = (await res.json()) as { current_transactions?: number; transaction_limit?: number }
    if (typeof j.current_transactions === 'number') {
      return { current: j.current_transactions, limit: j.transaction_limit ?? 5000 }
    }
    return null
  } catch {
    return null
  }
}

export async function fetchHealth(): Promise<HealthInfo> {
  if (STATIC_MODE) {
    const res = await fetch(`${import.meta.env.BASE_URL}data/manifest.json?v=${cacheTick()}`)
    if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`)
    const manifest = (await res.json()) as { hasKey?: boolean }
    return { ok: true, hasKey: Boolean(manifest.hasKey) }
  }
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`health check failed (${res.status})`)
  return res.json()
}

/**
 * EONET v3 is keyless + CORS-friendly — called straight from the client (§3.2).
 * `status=open` alone returns thousands of stale incidents; the 30-day window
 * keeps it to events with recent reported activity.
 */
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open&days=30'

interface EonetRaw {
  events: Array<{
    id: string
    title: string
    link: string
    sources?: Array<{ id: string; url: string }>
    geometry: Array<{
      date: string
      type: string
      coordinates: [number, number]
      magnitudeValue?: number | null
      magnitudeUnit?: string | null
    }>
  }>
}

export async function fetchEonetEvents(): Promise<EonetEvent[]> {
  const res = await fetch(EONET_URL)
  if (!res.ok) throw new Error(`EONET request failed (${res.status})`)
  const raw = (await res.json()) as EonetRaw
  return raw.events
    .map((e) => {
      // geometry is a time series of the event's reported positions — the
      // last point entry is where the incident is now.
      const points = e.geometry.filter((g) => g.type === 'Point')
      const last = points[points.length - 1]
      if (!last) return null
      return {
        id: e.id,
        title: e.title,
        link: e.link,
        date: last.date,
        coordinates: [last.coordinates[0], last.coordinates[1]] as [number, number],
        magnitudeValue: last.magnitudeValue ?? null,
        magnitudeUnit: last.magnitudeUnit ?? null,
        sources: e.sources ?? [],
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
}
