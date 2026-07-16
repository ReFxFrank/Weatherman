import { decodeFireBinary } from './binary'
import type { DecodedFire, EonetEvent } from './types'

export const DEFAULT_SOURCE = 'VIIRS_NOAA20_NRT'

/** Auto-refresh cadence (§5.2/§8) — matches the proxy cache TTL. */
export const REFRESH_MS = 10 * 60 * 1000

/**
 * Fetch + decode the binary hotspot payload. Render attributes are derived
 * separately (per quality tier) so a quality switch never refetches.
 */
export async function fetchFireDecoded(source = DEFAULT_SOURCE, days = 1): Promise<DecodedFire> {
  const res = await fetch(`/api/hotspots?source=${encodeURIComponent(source)}&days=${days}`)
  if (!res.ok) {
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

export interface HealthInfo {
  ok: boolean
  hasKey: boolean
}

export async function fetchHealth(): Promise<HealthInfo> {
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
