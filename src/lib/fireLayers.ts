import type { Layer } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { DataFilterExtension, type DataFilterExtensionProps } from '@deck.gl/extensions'
import type { FireData } from './types'
import type { QualityConfig } from './quality'
import type { DayNight } from '../store'

/**
 * The two-tier hotspot renderer (§5.1) with the §5.7 "fires as light" look,
 * built entirely from additive light splats:
 *
 * - Low zoom  → a *heat field*: every detection drawn as a wide, faint,
 *   additive splat. Overlapping splats sum on the GPU into glowing density
 *   blooms — a kernel-density heatmap that works on the globe. (deck.gl's
 *   HeatmapLayer can't render in interleaved mode — its aggregation passes
 *   never bind — so the heat tier is splat-based instead; see DECISIONS.md.)
 * - High zoom → discrete detections: FRP-sized, FRP-colored cores with up to
 *   two halo passes so clusters shimmer and bleed light (the bloom treatment).
 * - The tiers cross-fade over a zoom band around HEAT_TO_POINTS_ZOOM.
 *
 * All filters (§5.3) run on the GPU via DataFilterExtension — a filter change
 * is a uniform update, never an attribute rebuild or refetch.
 */

/** Additive light blending: fire accumulates brightness over the dark earth. */
const ADDITIVE_BLEND = {
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one',
  // Overlapping translucent splats must never mask each other.
  depthWriteEnabled: false,
} as const

/**
 * Depth-test policy: at globe zooms the map's depth buffer is what occludes
 * fires on the far side of the planet — keep testing. Zoomed in, the far side
 * can't be on screen, and large billboard splats would intersect the curved
 * surface's depth and clip into crescents — so release the test there.
 */
const DEPTH_RELEASE_ZOOM = 4.5

/** One shared extension instance: [frp, conf, night, ageDays] per point. */
const FILTER_EXTENSIONS = [new DataFilterExtension({ filterSize: 4 })]

/** 0→1 as x goes from e0→e1. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

export const HEAT_TO_POINTS_ZOOM = 5 // §5.1 swap threshold, cross-faded ±0.7

export interface FireFilters {
  frpMin: number
  confMin: 0 | 1 | 2
  dayNight: DayNight
}

export interface FireLayerOpts {
  data: FireData
  zoom: number
  quality: QualityConfig
  filters: FireFilters
  /** visible detection-age window in days-before-fetch: [newest, oldest] */
  timeRange: [number, number]
  showHeat: boolean
  showPoints: boolean
  /** entrance ignition progress 0→1 (1 once the intro has played) */
  ignite: number
  /** map layer to insert beneath (keeps fires under the EONET reticles) */
  beforeId?: string
}

export function buildFireLayers({
  data,
  zoom,
  quality,
  filters,
  timeRange,
  showHeat,
  showPoints,
  ignite,
  beforeId,
}: FireLayerOpts): Layer[] {
  const { count, positions, colors, radii, filterValues } = data

  // Cross-fade band around the swap threshold (§5.1: no hard cut).
  const swap = smoothstep(HEAT_TO_POINTS_ZOOM - 0.7, HEAT_TO_POINTS_ZOOM + 0.7, zoom)
  const heatPresence = 1 - swap
  const pointPresence = 0.24 + 0.76 * swap
  // Halos are fillrate-heavy; ramp them in as points become the primary tier.
  const glowPresence = smoothstep(3.2, HEAT_TO_POINTS_ZOOM + 0.5, zoom)

  const igniteEase = 1 - Math.pow(1 - Math.min(1, Math.max(0, ignite)), 3)
  const igniteScale = 0.25 + 0.75 * igniteEase

  const sharedData = {
    length: count,
    attributes: {
      getPosition: { value: positions, size: 2 },
      getFillColor: { value: colors, size: 4, normalized: true },
      getRadius: { value: radii, size: 1 },
      getFilterValue: { value: filterValues, size: 3 },
    },
  }

  const nightRange: [number, number] =
    filters.dayNight === 'day' ? [0, 0] : filters.dayNight === 'night' ? [1, 1] : [0, 1]
  const ageRange: [number, number] = [timeRange[0], Math.max(timeRange[1], timeRange[0] + 0.01)]
  const filterRange: [number, number][] = [
    [filters.frpMin, 1e9],
    [filters.confMin, 2],
    nightRange,
    ageRange,
  ]
  // Feather only the age edges so scrubbing dissolves detections in/out
  // instead of popping them (§5.2 "prioritize making it smooth").
  const ageFeather = Math.min(0.12, (ageRange[1] - ageRange[0]) / 4)
  const filterSoftRange: [number, number][] = [
    [filters.frpMin, 1e9],
    [filters.confMin, 2],
    nightRange,
    [ageRange[0] + ageFeather, ageRange[1] - ageFeather],
  ]

  const depthCompare = zoom > DEPTH_RELEASE_ZOOM ? ('always' as const) : ('less-equal' as const)
  const splat = (
    id: string,
    o: { radiusScale: number; minPx: number; maxPx: number; opacity: number },
  ) =>
    // beforeId is a MapboxOverlay interleaved-mode prop, absent from the core
    // layer types — declared via the extra-props generic.
    new ScatterplotLayer<unknown, DataFilterExtensionProps & { beforeId?: string }>({
      id,
      beforeId,
      data: sharedData,
      radiusUnits: 'meters' as const,
      radiusScale: o.radiusScale * igniteScale,
      radiusMinPixels: o.minPx,
      radiusMaxPixels: o.maxPx,
      stroked: false,
      antialiasing: true,
      pickable: false,
      opacity: o.opacity * igniteEase,
      parameters: { ...ADDITIVE_BLEND, depthCompare },
      extensions: FILTER_EXTENSIONS,
      filterRange,
      filterSoftRange,
    })

  const layers: (Layer | false)[] = [
    // -- Tier 1: world-scale heat field — wide faint splats sum into blooms --
    // Alphas are tuned for the full ~190k-point set: dense burn belts should
    // reach white-hot only at their cores, not swallow whole regions.
    showHeat &&
      heatPresence > 0.02 &&
      splat('fire-heatfield', {
        radiusScale: 3.8,
        minPx: quality.heatMinPx,
        maxPx: 56,
        opacity: 0.03 * heatPresence,
      }),

    // -- Tier 2: discrete glowing detections ---------------------------------
    // Outer halo — wide, faint bleed of light around clusters (High only).
    showPoints &&
      quality.glowPasses >= 2 &&
      glowPresence > 0.02 &&
      splat('fire-glow-outer', {
        radiusScale: 6,
        minPx: 6,
        maxPx: 110,
        opacity: 0.04 * glowPresence * pointPresence,
      }),

    // Inner halo — the main glow body (High + Balanced).
    showPoints &&
      quality.glowPasses >= 1 &&
      glowPresence > 0.02 &&
      splat('fire-glow-inner', {
        radiusScale: 2.6,
        minPx: 2.8,
        maxPx: 46,
        opacity: 0.1 * glowPresence * pointPresence,
      }),

    // Core points — at world zoom they read as embers inside the heat field;
    // past the swap they are the primary tier.
    showPoints &&
      splat('fire-core', {
        radiusScale: 1,
        minPx: 1.15,
        maxPx: 22,
        opacity: 0.9 * pointPresence,
      }),
  ]

  return layers.filter(Boolean) as Layer[]
}
