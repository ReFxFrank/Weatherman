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
  /** day window 1–10 (slider UI arrives in Phase 3) */
  days: number
  /** hide detections below this FRP (MW); 0 = show all */
  frpMin: number
  /** minimum normalized confidence: 0 = all, 1 = nominal+, 2 = high only */
  confMin: 0 | 1 | 2
  dayNight: DayNight
  showHeat: boolean
  showPoints: boolean
  projection: Projection
  basemap: Basemap
  quality: QualityTier
  panelOpen: boolean
}

export const useEmber = create<EmberState>(() => ({
  source: 'VIIRS_NOAA20_NRT',
  days: 1,
  frpMin: 0,
  confMin: 0,
  dayNight: 'all',
  showHeat: true,
  showPoints: true,
  projection: 'globe',
  basemap: 'dark',
  quality: detectQualityTier(),
  panelOpen: true,
}))

export function setEmber(partial: Partial<EmberState>) {
  if (partial.quality) localStorage.setItem('ember-quality', partial.quality)
  useEmber.setState(partial)
}

if (import.meta.env.DEV) {
  // test hook: lets headless verification drive state without UI gestures
  ;(window as unknown as { __emberStore?: typeof useEmber }).__emberStore = useEmber
}
