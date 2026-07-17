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

// ---------------------------------------------------------------------------
// Severe weather (NWS/SPC) — mirrors server/severe.ts
// ---------------------------------------------------------------------------

export type SevereKind = 'tornado-warning' | 'severe-warning' | 'tornado-watch' | 'severe-watch'

export interface SevereReport {
  time: string
  lat: number
  lon: number
  mag: string
  location: string
  state: string
}

export interface SevereCounts {
  tornadoWarnings: number
  severeWarnings: number
  tornadoWatches: number
  severeWatches: number
  reports: number
  /** alerts in the feed whose geometry could not be resolved (not drawn) */
  unmapped: number
}

export interface SeverePayload {
  source: 'nws-spc'
  mode: 'live' | 'baked'
  fetchedAt: string
  alerts: GeoJSON.FeatureCollection
  outlook: GeoJSON.FeatureCollection | null
  reports: { torn: SevereReport[]; wind: SevereReport[]; hail: SevereReport[] }
  counts: SevereCounts
  stale?: boolean
  /** sub-sources that failed this build (e.g. 'outlook', 'reports') — empty
   *  sections there mean "source down", NOT "quiet day"; never render an
   *  all-clear over these */
  degraded?: string[]
  /** client-derived setData key (expiry filtering re-keys between fetches) */
  renderKey?: string
}

/** Trimmed NWS alert properties as the severe payload carries them. */
export interface SevereAlertProps {
  kind: SevereKind
  event: string
  severity: string | null
  headline: string | null
  areaDesc: string
  onset: string | null
  expires: string | null
}

/** A clicked feature on the severe globe. Alerts carry no stable upstream
 *  id, so the selection is a SNAPSHOT of the clicked feature's properties —
 *  validated at render time (expired alerts drop their card, mirroring the
 *  expiry filter on the polygons). */
export type SevereSelection =
  | { type: 'alert'; props: SevereAlertProps }
  | { type: 'report'; rtype: 'torn' | 'wind' | 'hail'; report: SevereReport }

// ---------------------------------------------------------------------------
// Tropical cyclones (NHC + EONET) — mirrors server/hurricanes.ts
// ---------------------------------------------------------------------------

export interface ActiveStorm {
  id: string
  name: string
  /** TD | TS | HU | PTC … as NHC classifies it */
  classification: string
  /** max sustained wind, kt */
  intensityKt: number
  pressureMb: number | null
  lat: number
  lon: number
  movementDir: number | null
  movementSpeedKt: number | null
  advisoryNum: string
  lastUpdate: string
}

export interface GlobalStorm {
  title: string
  /** oldest → newest [lon, lat, iso] */
  track: Array<[number, number, string]>
  lastDate: string
}

export interface HurricaneCounts {
  nhcActive: number
  globalActive: number
  strongestName: string | null
  strongestKt: number
}

export interface HurricanePayload {
  source: 'nhc-eonet'
  mode: 'live' | 'baked'
  fetchedAt: string
  storms: ActiveStorm[]
  /** forecast cones/tracks/points + past tracks — trimmed NHC GeoJSON */
  cones: GeoJSON.FeatureCollection
  tracks: GeoJSON.FeatureCollection
  points: GeoJSON.FeatureCollection
  pastTracks: GeoJSON.FeatureCollection
  /** non-NHC storms from EONET, freshness-filtered */
  global: GlobalStorm[]
  counts: HurricaneCounts
  stale?: boolean
  /** sources that failed this build — empty sections there mean "source
   *  down", NOT "no storms"; never render an all-clear over these */
  degraded?: string[]
}

/** Snapshot of a clicked NHC forecast point's per-tau properties. */
export interface ForecastPointProps {
  stormname: string | null
  datelbl: string | null
  validtime: string | null
  tau: number | null
  maxwind: number | null
  gust: number | null
  mslp: number | null
  ssnum: number | null
  advisnum: string | null
  basin: string | null
}

/** A clicked feature on the hurricanes globe. Storm heads reference the
 *  payload by stable key (NHC id / EONET title) and are re-validated against
 *  the current payload at render time; forecast points are snapshots. */
export type HurricaneSelection =
  | { type: 'storm'; id: string }
  | { type: 'global'; title: string }
  | { type: 'forecast'; props: ForecastPointProps }

// ---------------------------------------------------------------------------
// Earthquakes (USGS) — fetched straight from the client (keyless, CORS-open,
// public domain), no proxy/bake. Small JSON, native MapLibre layers.
// ---------------------------------------------------------------------------

export interface Quake {
  /** USGS event id (stable) */
  id: string
  /** magnitude (USGS reports a mix of scales; treated uniformly for scale) */
  mag: number
  /** USGS place description, e.g. "79 km SW of Puerto Madero, Mexico" */
  place: string
  /** origin time, epoch ms UTC */
  time: number
  lon: number
  lat: number
  /** hypocenter depth, km (null when USGS omits it) */
  depthKm: number | null
  /** USGS-flagged tsunami potential for oceanic events */
  tsunami: boolean
  /** DYFI "felt" report count, null when nobody has reported */
  felt: number | null
  /** event type — usually "earthquake", sometimes "quarry blast"/"explosion" */
  type: string
  /** USGS event page */
  url: string
}

export interface QuakeCounts {
  total: number
  /** events at or above M4.5 (roughly the globally-complete threshold) */
  significant: number
  strongestMag: number
  strongestPlace: string | null
}

export interface QuakePayload {
  source: 'usgs'
  /** hours of history the feed covers (24 for all_day) */
  windowHours: number
  /** USGS feed generation time (metadata.generated), ISO */
  fetchedAt: string
  quakes: Quake[]
  counts: QuakeCounts
}

/** A clicked earthquake: a stable USGS id resolved against the current
 *  payload at render time (an event aging out of the window closes its card). */
export type QuakeSelection = { id: string }

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
