import type { Layer } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { DataFilterExtension, type DataFilterExtensionProps } from '@deck.gl/extensions'
import type { LightningData } from './types'
import type { QualityConfig } from './quality'
import { ADDITIVE_BLEND, DEPTH_RELEASE_ZOOM } from './fireLayers'
import { FRESH_MIN } from './lightningBinary'

export { FRESH_MIN }

/**
 * The lightning globe's render stack — the fire globe's "light on a dark
 * planet" idiom in a cold palette:
 *
 * - trail core + glow: every flash in the rolling window, energy-colored,
 *   alpha pre-faded by age (see lightningBinary.ts) so storm cells read as
 *   glowing embers of recent activity.
 * - fresh bloom: strikes younger than FRESH_MIN get a wide flickering bloom —
 *   the "it's happening right now" tier. The age filter slides with the wall
 *   clock between payload refreshes (a uniform update per frame, no rebuild).
 *
 * All age math runs on the GPU via DataFilterExtension over
 * [ageMinAtFetch, energyFJ, satIndex]: current age = ageMinAtFetch + minutes
 * since fetch, so the filter ranges are simply shifted by elapsed time.
 */

const FILTER_EXTENSIONS = [new DataFilterExtension({ filterSize: 3 })]

/** Referentially-stable binary-attribute descriptor per payload — a fresh
 *  descriptor object every pulse tick would make deck re-upload every GPU
 *  buffer every tick (review finding; same fix as fireLayers.ts). */
const sharedDataCache = new WeakMap<
  LightningData,
  { length: number; attributes: Record<string, { value: Float32Array | Uint8Array; size: number; normalized?: boolean }> }
>()

function sharedDataFor(data: LightningData) {
  let sd = sharedDataCache.get(data)
  if (!sd) {
    sd = {
      length: data.count,
      attributes: {
        getPosition: { value: data.positionsLifted, size: 3 },
        getFillColor: { value: data.colors, size: 4, normalized: true },
        getRadius: { value: data.radii, size: 1 },
        // size MUST match the extension's filterSize (3) — see the fire
        // layers' Phase-3 postmortem for what a mismatched stride does.
        getFilterValue: { value: data.filterValues, size: 3 },
      },
    }
    sharedDataCache.set(data, sd)
  }
  return sd
}

export interface LightningLayerOpts {
  data: LightningData
  zoom: number
  quality: QualityConfig
  /** wall clock, epoch seconds — slides the age window between refetches */
  nowSec: number
  /** entrance ignition progress 0→1 */
  ignite: number
  /** flicker phase 0→1 (shared with the fire pulse driver) */
  pulse?: number
  /** user age-window cap, minutes (store.lightningWindowMin); null = full */
  windowMin?: number | null
  beforeId?: string
}

export function buildLightningLayers({
  data,
  zoom,
  quality,
  nowSec,
  ignite,
  pulse = 0,
  windowMin: userWindowMin = null,
  beforeId,
}: LightningLayerOpts): Layer[] {
  const { meta } = data

  const fetchSec = Math.floor(Date.parse(meta.fetchedAt) / 1000) || nowSec
  // Live payloads slide their window with the wall clock. Baked payloads
  // (Pages, minutes-to-tens-of-minutes old) freeze at the bake instant: the
  // full baked hour stays visible and the HUD labels it "60 min to HH:MMZ" —
  // sliding would silently age out data and empty the fresh tier while the
  // header still said "live" (review finding).
  const elapsedMin = meta.mode === 'live' ? Math.max(0, (nowSec - fetchSec) / 60) : 0
  // The strip's age-window buttons narrow the visible window — purely a GPU
  // filter-range change, never a refetch (same idiom as fire playback).
  const windowMin = Math.min(meta.windowMin || 60, userWindowMin ?? Number.POSITIVE_INFINITY)

  // Sliding window: a flash with ageAtFetch v is currently v + elapsed old.
  const trailHi = windowMin - elapsedMin
  const freshHi = Math.max(-1, FRESH_MIN - elapsedMin)

  const igniteEase = 1 - Math.pow(1 - Math.min(1, Math.max(0, ignite)), 3)

  const sharedData = sharedDataFor(data)

  // No UI filters energy yet — the range exists only to fill the filter
  // triplet, so it must never cull (a floor of 0 would drop any flash whose
  // decoded energy rounds at-or-below zero; review finding).
  const energyRange: [number, number] = [-1e12, 1e12]
  const satRange: [number, number] = [0, 8]
  const trailRange: [number, number][] = [[-1, trailHi], energyRange, satRange]
  const trailSoft: [number, number][] = [
    // fade the oldest ~8 minutes toward the window edge instead of popping
    [-1, Math.max(-0.9, trailHi - 8)],
    energyRange,
    satRange,
  ]
  const freshRange: [number, number][] = [[-1, freshHi], energyRange, satRange]
  const freshSoft: [number, number][] = [
    [-1, Math.max(-0.9, freshHi - 1.2)],
    energyRange,
    satRange,
  ]

  const depthCompare = zoom > DEPTH_RELEASE_ZOOM ? ('always' as const) : ('less-equal' as const)
  const splat = (
    id: string,
    o: {
      radiusScale: number
      minPx: number
      maxPx: number
      opacity: number
      filterRange: [number, number][]
      filterSoftRange: [number, number][]
    },
  ) =>
    new ScatterplotLayer<unknown, DataFilterExtensionProps & { beforeId?: string }>({
      id,
      beforeId,
      data: sharedData,
      radiusUnits: 'meters' as const,
      radiusScale: o.radiusScale,
      radiusMinPixels: o.minPx,
      radiusMaxPixels: o.maxPx,
      stroked: false,
      antialiasing: true,
      pickable: false,
      opacity: o.opacity * igniteEase,
      parameters: { ...ADDITIVE_BLEND, depthCompare },
      extensions: FILTER_EXTENSIONS,
      filterRange: o.filterRange,
      filterSoftRange: o.filterSoftRange,
    })

  const flicker = 0.8 + 0.2 * Math.sin(pulse * Math.PI * 2)

  const layers: (Layer | false)[] = [
    // wide faint glow — overlapping cells sum into storm blooms
    quality.glowPasses >= 1 &&
      splat('lightning-glow', {
        radiusScale: 5.5,
        minPx: 4,
        maxPx: 44,
        opacity: 0.09,
        filterRange: trailRange,
        filterSoftRange: trailSoft,
      }),

    // per-flash cores
    splat('lightning-core', {
      radiusScale: 1,
      minPx: 1.3,
      maxPx: 9,
      opacity: 0.85,
      filterRange: trailRange,
      filterSoftRange: trailSoft,
    }),

    // fresh strikes (< FRESH_MIN old) flare wide and flicker
    splat('lightning-fresh', {
      radiusScale: 7,
      minPx: 5,
      maxPx: 52,
      opacity: 0.34 * flicker,
      filterRange: freshRange,
      filterSoftRange: freshSoft,
    }),
  ]

  return layers.filter(Boolean) as Layer[]
}
