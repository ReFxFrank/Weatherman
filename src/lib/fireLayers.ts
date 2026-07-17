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

/** Additive light blending: fire accumulates brightness over the dark earth.
 *  (Shared with the lightning layers — same "light on a dark planet" idiom.) */
export const ADDITIVE_BLEND = {
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
export const DEPTH_RELEASE_ZOOM = 4.5

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
  /** breathing phase 0→1 for the top-FRP pulse halos (§6 restrained motion) */
  pulse?: number
  /** map layer to insert beneath (keeps fires under the EONET reticles) */
  beforeId?: string
}

interface PulsePoint {
  position: [number, number, number]
  color: [number, number, number]
  radius: number
  /** [frp, conf, night, ageDays] — the pulse layer must obey the same GPU
   *  filters as every other fire layer (review finding: halos kept pulsing
   *  on detections the filters had culled) */
  filterValue: [number, number, number, number]
}

/** The ~16 highest-FRP detections get a gentle breathing halo. Cached per dataset. */
const pulseCache = new WeakMap<FireData, PulsePoint[]>()

function topFires(data: FireData): PulsePoint[] {
  let cached = pulseCache.get(data)
  if (cached) return cached
  const N = 16
  const top: number[] = []
  const { frp, positions, colors, radii, filterValues, count } = data
  for (let i = 0; i < count; i++) {
    if (top.length < N) {
      top.push(i)
      if (top.length === N) top.sort((a, b) => frp[b] - frp[a])
      continue
    }
    if (frp[i] <= frp[top[N - 1]]) continue
    let k = N - 1
    while (k > 0 && frp[i] > frp[top[k - 1]]) k--
    top.splice(k, 0, i)
    top.pop()
  }
  cached = top.map((i) => ({
    position: [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]] as [number, number, number],
    color: [colors[i * 4], colors[i * 4 + 1], colors[i * 4 + 2]] as [number, number, number],
    radius: radii[i],
    filterValue: [
      filterValues[i * 4],
      filterValues[i * 4 + 1],
      filterValues[i * 4 + 2],
      filterValues[i * 4 + 3],
    ] as [number, number, number, number],
  }))
  pulseCache.set(data, cached)
  return cached
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
  pulse = 0,
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

  // High-zoom detail (§5.1): FRP-driven size is a far/mid-zoom affordance —
  // close up it slams into the pixel caps and every detection becomes the
  // same giant disc, mushing into its neighbors (VIIRS detections sit only
  // ~375 m apart). Past z≈7 taper radii toward the physical sensor footprint
  // and tighten the caps so detections resolve into crisp separate embers,
  // letting color carry intensity.
  const detail = smoothstep(7, 10, zoom)
  const lerp = (a: number, b: number) => a + (b - a) * detail
  const sizeTaper = 1 - 0.72 * detail

  const sharedData = {
    length: count,
    attributes: {
      getPosition: { value: positions, size: 3 },
      getFillColor: { value: colors, size: 4, normalized: true },
      getRadius: { value: radii, size: 1 },
      // size MUST match the extension's filterSize (4) — a mismatched stride
      // makes the GPU read garbage filter values and cull almost everything
      // (this shipped briefly in Phase 3; caught by Phase 4's visual checks).
      getFilterValue: { value: filterValues, size: 4 },
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
  // instead of popping them (§5.2 "prioritize making it smooth"). Never
  // feather the age=0 edge in live mode — that would fade out precisely the
  // newest detections (review finding).
  const ageFeather = Math.min(0.12, (ageRange[1] - ageRange[0]) / 4)
  const softLo = ageRange[0] <= 0 ? ageRange[0] : ageRange[0] + ageFeather
  const filterSoftRange: [number, number][] = [
    [filters.frpMin, 1e9],
    [filters.confMin, 2],
    nightRange,
    [softLo, ageRange[1] - ageFeather],
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
      radiusScale: o.radiusScale * igniteScale * sizeTaper,
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
        maxPx: lerp(110, 36),
        opacity: 0.04 * glowPresence * pointPresence * (1 - 0.55 * detail),
      }),

    // Inner halo — the main glow body (High + Balanced).
    showPoints &&
      quality.glowPasses >= 1 &&
      glowPresence > 0.02 &&
      splat('fire-glow-inner', {
        radiusScale: 2.6,
        minPx: 2.8,
        maxPx: lerp(46, 18),
        opacity: 0.1 * glowPresence * pointPresence * (1 - 0.4 * detail),
      }),

    // Core points — at world zoom they read as embers inside the heat field;
    // past the swap they are the primary tier.
    showPoints &&
      splat('fire-core', {
        radiusScale: 1,
        minPx: 1.15,
        maxPx: lerp(22, 9),
        opacity: 0.9 * pointPresence,
      }),

    // Gentle breathing halo on the highest-FRP fires (§6). Only 16 instances —
    // the per-frame cost is one tiny uniform-only layer update.
    showPoints &&
      igniteEase >= 1 &&
      new ScatterplotLayer<PulsePoint, DataFilterExtensionProps & { beforeId?: string }>({
        id: 'fire-pulse',
        beforeId,
        data: topFires(data),
        getPosition: (d: PulsePoint) => d.position,
        getFillColor: (d: PulsePoint) => [d.color[0], d.color[1], d.color[2], 255],
        getRadius: (d: PulsePoint) => d.radius,
        getFilterValue: (d: PulsePoint) => d.filterValue,
        radiusUnits: 'meters' as const,
        radiusScale: (2.2 + 0.9 * Math.sin(pulse * Math.PI * 2)) * sizeTaper,
        radiusMinPixels: 5,
        radiusMaxPixels: lerp(64, 26),
        stroked: false,
        pickable: false,
        opacity: 0.1 + 0.05 * Math.sin(pulse * Math.PI * 2),
        parameters: { ...ADDITIVE_BLEND, depthCompare },
        extensions: FILTER_EXTENSIONS,
        filterRange,
        filterSoftRange,
      }),
  ]

  return layers.filter(Boolean) as Layer[]
}
