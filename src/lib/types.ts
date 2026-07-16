/** Metadata carried in the binary payload header from the proxy. */
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
  name: 'positions' | 'frp' | 'tsSec' | 'bright' | 'conf' | 'night'
  type: 'f32' | 'u32' | 'u8'
  /** elements per point (2 for positions, 1 otherwise) */
  size: number
  /** byte offset relative to dataOffset */
  offset: number
}

export type BinaryHeader = PayloadMeta & { dataOffset: number; sections: BinarySection[] }

/** Decoded fire dataset: parallel typed arrays plus derived render attributes. */
export interface FireData {
  meta: PayloadMeta
  /** points actually rendered (may be decimated below meta.count by quality tier) */
  count: number
  /** [lon, lat] interleaved */
  positions: Float32Array
  frp: Float32Array
  /** epoch seconds UTC */
  tsSec: Uint32Array
  bright: Float32Array
  /** 0 = low, 1 = nominal, 2 = high */
  conf: Uint8Array
  /** 1 = night detection */
  night: Uint8Array
  /** derived RGBA per point from the FRP ember ramp */
  colors: Uint8Array
  /** derived radius per point, meters */
  radii: Float32Array
  /** derived [frp, conf, night] triplets for the GPU DataFilterExtension */
  filterValues: Float32Array
}

/** Decoded payload before render attributes are derived. */
export type DecodedFire = Omit<FireData, 'colors' | 'radii' | 'filterValues'>
