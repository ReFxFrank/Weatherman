import { create } from 'zustand'
import type { QualityTier } from './lib/quality'
import { detectQualityTier } from './lib/quality'

/**
 * UI state (§5.3): filters apply as GPU uniform updates — only `source` and
 * `days` changes trigger a refetch (enforced by the react-query key in App).
 */

export const SOURCES = [
  { id: 'VIIRS_NOAA20_NRT', label: 'VIIRS · NOAA-20', note: '375 m' },
  { id: 'VIIRS_NOAA21_NRT', label: 'VIIRS · NOAA-21', note: '375 m' },
  { id: 'VIIRS_SNPP_NRT', label: 'VIIRS · Suomi NPP', note: '375 m' },
  { id: 'MODIS_NRT', label: 'MODIS · Terra/Aqua', note: '1 km' },
  { id: 'LANDSAT_NRT', label: 'Landsat · 8/9', note: '30 m · US/CA', needsKey: true },
] as const

export type SourceId = (typeof SOURCES)[number]['id']

export type DayNight = 'all' | 'day' | 'night'
export type Projection = 'globe' | 'mercator'
export type Basemap = 'dark' | 'dark-nolabels'
/** Which data globe is on screen: fire watch, lightning, or severe weather. */
export type GlobeId = 'fire' | 'lightning' | 'severe'

export interface EmberState {
  /** active globe — the shell (camera, terminator, search) is shared */
  globe: GlobeId
  source: SourceId
  /** fetched day window 1–10 (§5.2 time-range slider) */
  days: number
  /** hide detections below this FRP (MW); 0 = show all */
  frpMin: number
  /** minimum normalized confidence: 0 = all, 1 = nominal+, 2 = high only */
  confMin: 0 | 1 | 2
  dayNight: DayNight
  showHeat: boolean
  showPoints: boolean
  showEvents: boolean
  /** country-level fire-count choropleth (Phase 5, lazy-loaded) */
  showChoropleth: boolean
  /** US wildfire perimeters from NIFC/WFIGS (Phase 5, lazy-loaded) */
  showPerimeters: boolean
  projection: Projection
  basemap: Basemap
  quality: QualityTier
  panelOpen: boolean
  /**
   * Time playback (§5.2): null = live view of the whole window; a number is
   * the trailing edge (days ago) of a 24h slice being scrubbed/played.
   */
  playhead: number | null
  playing: boolean
  /** id of the EONET event whose detail card is open */
  selectedEventId: string | null
  /** index into the current FireData of the hotspot whose card is open */
  selectedHotspot: number | null
  /** right-hand stats panel expanded (§5.4) */
  statsOpen: boolean
  /** real-time day/night terminator shading (§5.7) */
  showTerminator: boolean
  /** which mobile bottom-sheet tab is open (null = closed) */
  sheet: 'filters' | 'stats' | null
  /** bumped (throttled) when the viewport settles — recomputes in-view stats */
  viewEpoch: number
}

/** Shareable deep links (Phase 5): filters/source/window read from the URL.
 *  The camera (?lat/lon/z) is handled by EmberMap's cameraOverride. */
function stateFromUrl(): Partial<EmberState> {
  const q = new URLSearchParams(location.search)
  const out: Partial<EmberState> = {}
  const source = q.get('source')
  if (source && SOURCES.some((s) => s.id === source)) out.source = source as SourceId
  const days = Number(q.get('days'))
  if (Number.isInteger(days) && days >= 1 && days <= 10) out.days = days
  const frp = Number(q.get('frp'))
  if (Number.isFinite(frp) && frp > 0) out.frpMin = Math.min(frp, 1000)
  const conf = q.get('conf')
  if (conf === '1' || conf === '2') out.confMin = Number(conf) as 1 | 2
  const dn = q.get('dn')
  if (dn === 'day' || dn === 'night') out.dayNight = dn
  const g = q.get('globe')
  if (g === 'lightning' || g === 'severe') out.globe = g
  return out
}

export const useEmber = create<EmberState>(() => ({
  globe: 'fire',
  source: 'VIIRS_NOAA20_NRT',
  days: 1,
  frpMin: 0,
  confMin: 0,
  dayNight: 'all',
  showHeat: true,
  showPoints: true,
  showEvents: true,
  showChoropleth: false,
  showPerimeters: false,
  projection: 'globe',
  basemap: 'dark',
  quality: detectQualityTier(),
  panelOpen: true,
  playhead: null,
  playing: false,
  selectedEventId: null,
  selectedHotspot: null,
  statsOpen: true,
  showTerminator: true,
  sheet: null,
  viewEpoch: 0,
  ...stateFromUrl(),
}))

export function setEmber(partial: Partial<EmberState>) {
  if (partial.quality) localStorage.setItem('ember-quality', partial.quality)
  // Changing the fetch window invalidates any slice position within it.
  if (partial.days !== undefined) {
    partial = { playhead: null, playing: false, ...partial }
  }
  // Selections and sheets belong to the globe they were made on.
  if (partial.globe !== undefined) {
    partial = { selectedHotspot: null, selectedEventId: null, sheet: null, ...partial }
  }
  useEmber.setState(partial)
}

if (import.meta.env.DEV) {
  // test hook: lets headless verification drive state without UI gestures
  ;(window as unknown as { __emberStore?: typeof useEmber }).__emberStore = useEmber
}
