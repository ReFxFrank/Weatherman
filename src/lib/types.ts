/** Columnar hotspot payload from the proxy — parallel arrays indexed together. */
export interface HotspotColumns {
  lat: number[]
  lon: number[]
  /** Fire Radiative Power, MW — the intensity signal (§3.1) */
  frp: number[]
  /** normalized confidence: 0 = low, 1 = nominal, 2 = high */
  conf: number[]
  /** acquisition time, epoch ms UTC */
  ts: number[]
  /** 1 = night detection, 0 = day */
  night: number[]
  /** brightness temperature, kelvin */
  bright: number[]
}

export interface HotspotResponse {
  source: string
  days: number
  coverageDays: number
  mode: 'api' | 'public-feed'
  fetchedAt: string
  count: number
  columns: HotspotColumns
  stale?: boolean
}
