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

export interface EmberState {
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

export const useEmber = create<EmberState>(() => ({
  source: 'VIIRS_NOAA20_NRT',
  days: 1,
  frpMin: 0,
  confMin: 0,
  dayNight: 'all',
  showHeat: true,
  showPoints: true,
  showEvents: true,
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
}))

export function setEmber(partial: Partial<EmberState>) {
  if (partial.quality) localStorage.setItem('ember-quality', partial.quality)
  // Changing the fetch window invalidates any slice position within it.
  if (partial.days !== undefined) {
    partial = { playhead: null, playing: false, ...partial }
  }
  useEmber.setState(partial)
}

if (import.meta.env.DEV) {
  // test hook: lets headless verification drive state without UI gestures
  ;(window as unknown as { __emberStore?: typeof useEmber }).__emberStore = useEmber
}
