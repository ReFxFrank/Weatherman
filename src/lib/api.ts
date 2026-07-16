import type { HotspotResponse } from './types'

export const DEFAULT_SOURCE = 'VIIRS_NOAA20_NRT'

export async function fetchHotspots(source = DEFAULT_SOURCE, days = 1): Promise<HotspotResponse> {
  const res = await fetch(`/api/hotspots?source=${encodeURIComponent(source)}&days=${days}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`hotspots request failed (${res.status}) ${detail.slice(0, 200)}`)
  }
  return res.json()
}
