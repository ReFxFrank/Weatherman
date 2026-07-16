import { decodeFireBinary, deriveRenderAttributes } from './binary'
import type { FireData } from './types'

export const DEFAULT_SOURCE = 'VIIRS_NOAA20_NRT'

/** Fetch + decode the binary hotspot payload and derive GPU attributes. */
export async function fetchFireData(source = DEFAULT_SOURCE, days = 1, stride = 1): Promise<FireData> {
  const res = await fetch(`/api/hotspots?source=${encodeURIComponent(source)}&days=${days}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`hotspots request failed (${res.status}) ${detail.slice(0, 200)}`)
  }
  const buf = await res.arrayBuffer()
  return deriveRenderAttributes(decodeFireBinary(buf), stride)
}
