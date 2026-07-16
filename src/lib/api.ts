import { decodeFireBinary } from './binary'
import type { DecodedFire } from './types'

export const DEFAULT_SOURCE = 'VIIRS_NOAA20_NRT'

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
