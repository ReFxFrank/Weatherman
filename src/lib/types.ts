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
  /** [lon, lat, liftMeters] interleaved — lifted off the globe surface so
   *  splats never depth-fight the basemap tile mesh (see binary.ts) */
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
  /**
   * derived [frp, conf, night, ageDays] per point for the GPU
   * DataFilterExtension — ageDays is days before meta.fetchedAt
   */
  filterValues: Float32Array
}

/** Decoded payload before render attributes are derived. */
export type DecodedFire = Omit<FireData, 'colors' | 'radii' | 'filterValues'>

// ---------------------------------------------------------------------------
// Lightning (GOES GLM) — mirrors server/glm.ts wire format
// ---------------------------------------------------------------------------

export interface LightningSatMeta {
  id: string
  name: string
  /** sub-satellite longitude, °E — center of its field of view */
  lonSubSat: number
  /** nominal product cadence, seconds (20 for GLM, 600 for MTG-LI) */
  cadenceSec: number
  /** epoch seconds of the newest decoded granule, 0 if the satellite is dark */
  lastGranuleSec: number
  flashCount: number
  /** granules listed but not yet fetched (server backfill in progress) */
  pendingKeys: number
  /** granules that failed twice and were given up — window gaps */
  failedKeys: number
  /** false until the first bucket listing succeeds — "acquiring", not "dark" */
  everListed: boolean
}

export interface LightningMeta {
  source: 'glm'
  windowMin: number
  mode: 'live' | 'baked'
  fetchedAt: string
  count: number
  sats: LightningSatMeta[]
  /** 0..1 — fraction of the in-window granules the server has decoded */
  backfill: number
  stale?: boolean
}

export interface LightningBinarySection {
  name: 'positions' | 'energy' | 'tsSec' | 'sat'
  type: 'f32' | 'u32' | 'u8'
  size: number
  offset: number
}

export type LightningBinaryHeader = LightningMeta & {
  dataOffset: number
  sections: LightningBinarySection[]
}

/** Decoded lightning payload: parallel typed arrays, [lon, lat] positions. */
export interface DecodedLightning {
  meta: LightningMeta
  count: number
  /** [lon, lat] interleaved */
  positions: Float32Array
  /** flash optical energy, femtojoules */
  energy: Float32Array
  /** granule start, epoch seconds UTC (20 s quantization) */
  tsSec: Uint32Array
  /** satellite index (0 = GOES-West, 1 = GOES-East) */
  sat: Uint8Array
}

/** Lightning render set: lifted positions + derived attributes. */
export interface LightningData extends DecodedLightning {
  /** [lon, lat, liftMeters] interleaved (same depth-fight fix as fires) */
  positionsLifted: Float32Array
  /** RGBA per flash — energy ramp, age-faded alpha (at derive time) */
  colors: Uint8Array
  /** meters, energy-scaled */
  radii: Float32Array
  /** [ageMinAtFetch, energyFJ, satIndex] per flash for the GPU filter */
  filterValues: Float32Array
}

/** A curated named wildfire event from NASA EONET v3. */
export interface EonetEvent {
  id: string
  title: string
  /** EONET API link for the event */
  link: string
  /** most recent geometry date, ISO */
  date: string
  /** [lon, lat] of the most recent geometry point */
  coordinates: [number, number]
  /** e.g. burned area in acres, when the source reports one */
  magnitudeValue: number | null
  magnitudeUnit: string | null
  sources: Array<{ id: string; url: string }>
}
