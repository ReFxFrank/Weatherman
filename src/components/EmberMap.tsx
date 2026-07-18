import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { useControl } from 'react-map-gl/maplibre'
import type { MapRef } from 'react-map-gl/maplibre'
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type {
  AuroraPayload,
  DecodedFire,
  EonetEvent,
  FireData,
  HurricanePayload,
  LightningData,
  QuakePayload,
  SeverePayload,
} from '../lib/types'
import type { QualityConfig } from '../lib/quality'
import { buildFireLayers } from '../lib/fireLayers'
import { buildLightningLayers } from '../lib/lightningLayers'
import { attachEonetInteraction, EONET_ICON_LAYER, syncEonetSymbols } from '../lib/eonetSymbols'
import { syncGlmCoverage } from '../lib/coverage'
import {
  HURRICANE_CLICK_LAYERS,
  pickHurricaneFeature,
  syncHurricaneLayers,
} from '../lib/hurricaneLayers'
import { pickSevereFeature, SEVERE_CLICK_LAYERS, syncSevereLayers } from '../lib/severeLayers'
import {
  hideQuakeRipple,
  pickQuakeFeature,
  QUAKE_CLICK_LAYERS,
  setQuakeRipplePhase,
  syncQuakeLayers,
} from '../lib/quakeLayers'
import { setAuroraShimmer, syncAuroraLayers } from '../lib/auroraLayers'
import { syncTerminatorLayers } from '../lib/terminator'
import { syncChoroplethLayer } from '../lib/choropleth'
import { syncPerimetersLayer } from '../lib/perimeters'
import { syncSelectionMarker } from '../lib/selectionMarker'
import { findNearestHotspot } from '../lib/nearestHotspot'
import { mapBus } from '../lib/mapBus'
import {
  ENTRANCE_START,
  HOME_VIEW,
  flyEntrance,
  reducedMotion,
  startIdleRotation,
} from '../lib/cinematics'
import { setEmber, useEmber, type Basemap, type Projection } from '../store'

/** CARTO dark styles — zero-key vector basemaps (decision log: docs/DECISIONS.md). */
const BASEMAP_STYLES: Record<Basemap, string> = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  'dark-nolabels': 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json',
}

const IGNITE_DELAY_MS = 600
const IGNITE_MS = 2200
const PULSE_PERIOD_MS = 2600

/** Dev/test camera override: ?lat=&lon=&z= jumps straight there, no entrance. */
function cameraOverride(): { lon: number; lat: number; z: number } | null {
  const q = new URLSearchParams(location.search)
  const raw = { lat: q.get('lat'), lon: q.get('lon'), z: q.get('z') }
  if (raw.lat === null || raw.lon === null || raw.z === null) return null
  const lat = Number(raw.lat)
  const lon = Number(raw.lon)
  const z = Number(raw.z)
  return Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(z) ? { lon, lat, z } : null
}

function DeckGLOverlay(props: ConstructorParameters<typeof MapboxOverlay>[0]) {
  // MapboxOverlay implements maplibre's IControl, so react-map-gl can mount it.
  const overlay = useControl(() => new MapboxOverlay(props)) as unknown as MapboxOverlay
  overlay.setProps(props)
  if (import.meta.env.DEV) {
    ;(window as unknown as { __emberOverlay?: MapboxOverlay }).__emberOverlay = overlay
  }
  return null
}

/** Space look: globe (or flat) projection, atmosphere, deep-navy re-tint. */
function styleMapForSpace(map: MapLibreMap, projection: Projection) {
  map.setProjection({ type: projection })
  map.setSky({
    'sky-color': '#0a1430',
    'sky-horizon-blend': 0.6,
    'horizon-color': '#7da7dd',
    'horizon-fog-blend': 0.6,
    'fog-color': '#04070f',
    'fog-ground-blend': 0.6,
    // strong halo from orbit, fading as you zoom toward the surface
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.5, 9, 0] as never,
  })

  // Re-tint CARTO dark-matter toward the deep-navy §6 palette so land reads
  // as a dark planet surface and oceans go near-black.
  for (const layer of map.getStyle().layers ?? []) {
    try {
      if (layer.type === 'background') {
        map.setPaintProperty(layer.id, 'background-color', '#0d1322')
      } else if (layer.type === 'fill' && /water/i.test(layer.id) && !/label|name/i.test(layer.id)) {
        map.setPaintProperty(layer.id, 'fill-color', '#050912')
      } else if (layer.type === 'line' && /waterway/i.test(layer.id)) {
        map.setPaintProperty(layer.id, 'line-color', '#050912')
      }
    } catch {
      // best-effort restyle; an unknown layer never blocks boot
    }
  }
}

export function EmberMap({
  data,
  full,
  lightning,
  severe,
  hurricanes,
  quakes,
  quakesStale,
  aurora,
  entranceReady,
  events,
  quality,
  selectedIndex,
  choropleth,
  perimeters,
}: {
  /** decimated render set (what deck draws) */
  data: FireData | undefined
  /** full decoded payload — picking/selection index space (matches stats) */
  full: DecodedFire | undefined
  /** lightning render set (Phase 6), undefined until its globe is active */
  lightning: LightningData | undefined
  /** severe-weather payload (NWS/SPC), undefined until its globe is active */
  severe: SeverePayload | undefined
  /** tropical-cyclone payload (NHC/EONET), undefined until its globe is active */
  hurricanes: HurricanePayload | undefined
  /** earthquake payload (USGS), undefined until its globe is active */
  quakes: QuakePayload | undefined
  /** the USGS feed is erroring while showing last-good data — withdraw the
   *  ripple's "last hour" recency cue */
  quakesStale: boolean
  /** aurora forecast field (NOAA OVATION), undefined until its globe is active */
  aurora: AuroraPayload | undefined
  /** active globe's data arrived OR its query errored — the entrance must
   *  not wait forever on a feed that is down (review finding); App owns the
   *  per-globe query state, so App computes this */
  entranceReady: boolean
  events: EonetEvent[] | undefined
  quality: QualityConfig
  /** validated selection (App checks payload identity + active filters) */
  selectedIndex: number | null
  /** country fire-count features (Phase 5), null while off/loading */
  choropleth: GeoJSON.FeatureCollection | null
  /** NIFC US perimeter features (Phase 5), null while off/loading */
  perimeters: GeoJSON.FeatureCollection | null
}) {
  const mapRef = useRef<MapRef>(null)
  const jump = useMemo(cameraOverride, [])
  const [mapLoaded, setMapLoaded] = useState(false)
  const [zoom, setZoom] = useState(jump ? jump.z : ENTRANCE_START.zoom)
  const [ignite, setIgnite] = useState(jump ? 1 : 0)
  const [pulse, setPulse] = useState(0)
  const [cameraSettled, setCameraSettled] = useState(Boolean(jump))
  const entranceStarted = useRef(false)
  // Idle rotation emits moveend every frame — throttle in-view stat refreshes.
  const lastEpochBump = useRef(0)
  const epochTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (epochTimer.current !== null) clearTimeout(epochTimer.current)
    },
    [],
  )

  const globe = useEmber((s) => s.globe)
  const frpMin = useEmber((s) => s.frpMin)
  const confMin = useEmber((s) => s.confMin)
  const dayNight = useEmber((s) => s.dayNight)
  const showHeat = useEmber((s) => s.showHeat)
  const showPoints = useEmber((s) => s.showPoints)
  const showEvents = useEmber((s) => s.showEvents)
  const showTerminator = useEmber((s) => s.showTerminator)
  const showChoropleth = useEmber((s) => s.showChoropleth)
  const showPerimeters = useEmber((s) => s.showPerimeters)
  const projection = useEmber((s) => s.projection)
  const basemap = useEmber((s) => s.basemap)
  const days = useEmber((s) => s.days)
  const playhead = useEmber((s) => s.playhead)
  const selectedEventId = useEmber((s) => s.selectedEventId)
  const selectedHurricane = useEmber((s) => s.selectedHurricane)
  const selectedQuake = useEmber((s) => s.selectedQuake)

  // Storm-head highlight key (NHC id / EONET title); forecast-point
  // selections have no head to emphasize.
  const hurricaneSelKey =
    selectedHurricane?.type === 'storm'
      ? selectedHurricane.id
      : selectedHurricane?.type === 'global'
        ? selectedHurricane.title
        : null
  const quakeSelId = selectedQuake?.id ?? null

  // Live mode shows the whole fetched window; a playhead shows a 24h slice
  // ending `playhead` days ago. Either way it's one GPU uniform.
  const timeRange = useMemo<[number, number]>(
    () => (playhead === null ? [0, days] : [Math.max(0, playhead - 1), playhead]),
    [playhead, days],
  )

  const selectedPoint = useMemo(
    () =>
      full && selectedIndex !== null && selectedIndex < full.count
        ? { lon: full.positions[selectedIndex * 2], lat: full.positions[selectedIndex * 2 + 1] }
        : null,
    [full, selectedIndex],
  )

  // Coverage rings come from the payload's satellite list (GOES always;
  // Meteosat when configured). A dark satellite's ring restyles red.
  const coverageSats = useMemo(
    () =>
      lightning?.meta.sats.map((s) => ({
        lonSubSat: s.lonSubSat,
        dark: s.everListed && s.pendingKeys === 0 && !s.lastGranuleSec,
      })) ?? [],
    [lightning],
  )

  // Fire-specific dressing (event reticles, choropleth, perimeters, the
  // selection ring) only exists on the fire globe; the terminator and the
  // GLM coverage rings are shell/lightning concerns.
  const fireGlobe = globe === 'fire'

  // Everything the style.load handler must restore after a basemap swap
  // (which wipes projection, sky, tint and all native layers), readable
  // without re-registering the handler.
  const styleStateRef = useRef({
    projection,
    globe,
    events,
    selectedEventId,
    showEvents: showEvents && fireGlobe,
    showTerminator,
    selectedPoint: fireGlobe ? selectedPoint : null,
    choropleth,
    showChoropleth: showChoropleth && fireGlobe,
    perimeters,
    showPerimeters: showPerimeters && fireGlobe,
    coverageSats,
    severe,
    hurricanes,
    hurricaneSelKey,
    quakes,
    quakeSelId,
    aurora,
  })
  styleStateRef.current = {
    projection,
    globe,
    events,
    selectedEventId,
    showEvents: showEvents && fireGlobe,
    showTerminator,
    selectedPoint: fireGlobe ? selectedPoint : null,
    choropleth,
    showChoropleth: showChoropleth && fireGlobe,
    perimeters,
    showPerimeters: showPerimeters && fireGlobe,
    coverageSats,
    severe,
    hurricanes,
    hurricaneSelKey,
    quakes,
    quakeSelId,
    aurora,
  }

  /** Recreate every native layer in stack order (bottom→top: choropleth,
   *  terminator, coverage rings, perimeters, [deck splats], eonet symbols,
   *  selection ring). */
  const syncNativeLayers = (map: MapLibreMap) => {
    const s = styleStateRef.current
    // eonet first: its icon layer is the beforeId anchor for deck + the rest
    syncEonetSymbols(map, s.events ?? [], s.selectedEventId, s.showEvents)
    syncTerminatorLayers(map, { beforeId: EONET_ICON_LAYER, visible: s.showTerminator })
    syncGlmCoverage(map, {
      beforeId: EONET_ICON_LAYER,
      visible: s.globe === 'lightning',
      sats: s.coverageSats,
    })
    syncSevereLayers(map, s.severe ?? null, {
      beforeId: EONET_ICON_LAYER,
      visible: s.globe === 'severe',
    })
    syncHurricaneLayers(map, s.hurricanes ?? null, {
      beforeId: EONET_ICON_LAYER,
      visible: s.globe === 'hurricanes',
      selectedKey: s.hurricaneSelKey,
    })
    syncQuakeLayers(map, s.quakes ?? null, {
      beforeId: EONET_ICON_LAYER,
      visible: s.globe === 'quakes',
      selectedId: s.quakeSelId,
    })
    syncAuroraLayers(map, s.aurora ?? null, {
      beforeId: EONET_ICON_LAYER,
      visible: s.globe === 'aurora',
    })
    syncChoroplethLayer(map, s.choropleth, s.showChoropleth)
    syncPerimetersLayer(map, s.perimeters, s.showPerimeters)
    syncSelectionMarker(map, s.selectedPoint)
  }

  // Entrance: once the globe is up and the ACTIVE globe's data has arrived
  // (or its feed has definitively errored — never wait forever), ease down
  // from orbit onto the North America home view while the layers ignite
  // (§5.7). App computes entranceReady from the active globe's query.
  useEffect(() => {
    if (!mapLoaded || !entranceReady || entranceStarted.current) return
    const map = mapRef.current?.getMap()
    if (!map) return
    entranceStarted.current = true

    if (jump) return // dev override: already in place, fully ignited

    const target = HOME_VIEW
    if (reducedMotion()) {
      map.jumpTo({ center: [target.lon, target.lat], zoom: 1.95 })
      setIgnite(1)
      setCameraSettled(true)
      return
    }

    const cancelFly = flyEntrance(map, target)
    const t0 = performance.now() + IGNITE_DELAY_MS
    let igniteDone = false
    let raf = requestAnimationFrame(function tick(now: number) {
      const p = Math.min(1, Math.max(0, (now - t0) / IGNITE_MS))
      setIgnite(p)
      if (p < 1) raf = requestAnimationFrame(tick)
      else igniteDone = true
    })
    // Settle when the ease actually ends (robust on slow renderers), not on a
    // wall-clock guess. A user interrupting the entrance also settles it.
    let settled = false
    const onMoveEnd = () => {
      settled = true
      setCameraSettled(true)
    }
    map.once('moveend', onMoveEnd)
    // This cleanup can fire long after the entrance finished (any deps change
    // re-runs the effect — e.g. a globe switch). Only interrupt what is still
    // in flight, and always leave the scene fully lit: a mid-entrance switch
    // must not freeze ignite/cameraSettled at partial values (review finding),
    // and a post-entrance switch must not map.stop() an unrelated animation.
    return () => {
      map.off('moveend', onMoveEnd)
      cancelAnimationFrame(raf)
      if (!settled || !igniteDone) {
        if (!settled) cancelFly()
        setIgnite(1)
        setCameraSettled(true)
      }
    }
  }, [mapLoaded, entranceReady, jump])

  // Idle auto-rotation, armed only after the entrance has settled.
  useEffect(() => {
    if (!cameraSettled) return
    const map = mapRef.current?.getMap()
    if (!map) return
    return startIdleRotation(map)
  }, [cameraSettled])

  // Gentle pulse driver for the top-FRP halos — ~30fps, paused when hidden.
  // The severe/hurricanes globes render no deck layers, so don't burn 30
  // renders/s on them (review finding).
  useEffect(() => {
    if (
      !cameraSettled ||
      ignite < 1 ||
      globe === 'severe' ||
      globe === 'hurricanes' ||
      globe === 'quakes' ||
      globe === 'aurora'
    )
      return
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (document.hidden || now - last < 33) return
      last = now
      setPulse((now / PULSE_PERIOD_MS) % 1)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [cameraSettled, ignite, globe])

  // Projection toggle (§5.1: globe default, flat for regional drill-down).
  useEffect(() => {
    if (!mapLoaded) return
    mapRef.current?.getMap()?.setProjection({ type: projection })
  }, [projection, mapLoaded])

  // Native layers re-sync on every relevant change (idempotent).
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    syncNativeLayers(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mapLoaded,
    globe,
    events,
    selectedEventId,
    showEvents,
    showTerminator,
    selectedPoint,
    choropleth,
    showChoropleth,
    perimeters,
    showPerimeters,
    coverageSats,
  ])

  // The severe payload refreshes every ~60 s — re-sync ONLY its own layers,
  // not the whole native stack (EONET re-serialize + terminator trig for
  // zero visual change; review finding).
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    syncSevereLayers(map, severe ?? null, {
      beforeId: EONET_ICON_LAYER,
      visible: globe === 'severe',
    })
  }, [mapLoaded, severe, globe])

  // Same dedicated re-sync for the hurricanes payload (5-min refresh) —
  // also re-runs on selection change to restyle the highlighted storm head.
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    syncHurricaneLayers(map, hurricanes ?? null, {
      beforeId: EONET_ICON_LAYER,
      visible: globe === 'hurricanes',
      selectedKey: hurricaneSelKey,
    })
  }, [mapLoaded, hurricanes, globe, hurricaneSelKey])

  // Dedicated re-sync for the quakes payload (60 s refresh) + selection.
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    syncQuakeLayers(map, quakes ?? null, {
      beforeId: EONET_ICON_LAYER,
      visible: globe === 'quakes',
      selectedId: quakeSelId,
    })
  }, [mapLoaded, quakes, globe, quakeSelId])

  // Dedicated re-sync for the aurora field (5-min forecast refresh).
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    syncAuroraLayers(map, aurora ?? null, {
      beforeId: EONET_ICON_LAYER,
      visible: globe === 'aurora',
    })
  }, [mapLoaded, aurora, globe])

  // Aurora shimmer: a self-contained rAF gently breathes the glow opacity,
  // mounted only on the aurora globe (same idiom as the quake ripple — its own
  // loop, no React re-render). document.hidden pauses it.
  useEffect(() => {
    if (!mapLoaded || globe !== 'aurora') return
    const map = mapRef.current?.getMap()
    if (!map) return
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (document.hidden || now - last < 50) return
      last = now
      setAuroraShimmer(map, now)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mapLoaded, globe])

  // Ripple animation: a self-contained rAF drives the sonar-ping ring via
  // setPaintProperty, mounted only on the quakes globe (so it never re-renders
  // React, unlike the deck pulse). document.hidden pauses it; cleanup just
  // cancels the rAF (the phase is derived from the global clock, so it resumes
  // in sync, and on globe switch the sync effect hides every eq-* layer, so a
  // frozen ring never shows). During a USGS outage (quakesStale) the ripple is
  // withdrawn instead of animated — the frozen payload can't back a "last
  // hour" claim (review finding).
  useEffect(() => {
    if (!mapLoaded || globe !== 'quakes') return
    const map = mapRef.current?.getMap()
    if (!map) return
    if (quakesStale) {
      hideQuakeRipple(map)
      return
    }
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (document.hidden || now - last < 33) return
      last = now
      setQuakeRipplePhase(map, now)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mapLoaded, globe, quakesStale])

  // The terminator moves with the sun — refresh its geometry every minute.
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const id = window.setInterval(() => {
      syncTerminatorLayers(map, {
        beforeId: EONET_ICON_LAYER,
        visible: styleStateRef.current.showTerminator,
      })
    }, 60_000)
    return () => clearInterval(id)
  }, [mapLoaded])

  // EONET selection (native symbol hit-testing) + hotspot picking: on any
  // unclaimed click, nearest-detection search over the typed arrays.
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    return attachEonetInteraction(map, (id) =>
      setEmber(id ? { selectedEventId: id, selectedHotspot: null } : { selectedEventId: null }),
    )
  }, [mapLoaded])

  const pickStateRef = useRef({ full, frpMin, confMin, dayNight, timeRange, fireGlobe, globe })
  pickStateRef.current = { full, frpMin, confMin, dayNight, timeRange, fireGlobe, globe }
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return // an EONET marker claimed this click
      const s = pickStateRef.current
      // severe/hurricanes: native-layer hit-testing (their features are
      // MapLibre polygons/points, not deck splats); empty space deselects
      if (s.globe === 'severe') {
        setEmber({ selectedSevere: pickSevereFeature(map, e.point) })
        return
      }
      if (s.globe === 'hurricanes') {
        setEmber({ selectedHurricane: pickHurricaneFeature(map, e.point) })
        return
      }
      if (s.globe === 'quakes') {
        setEmber({ selectedQuake: pickQuakeFeature(map, e.point) })
        return
      }
      if (!s.fireGlobe) return // hotspot picking is a fire-globe affordance
      if (!s.full) return
      const idx = findNearestHotspot(
        s.full,
        e.lngLat,
        map.getZoom(),
        { frpMin: s.frpMin, confMin: s.confMin, dayNight: s.dayNight },
        s.timeRange,
      )
      setEmber(idx !== null ? { selectedHotspot: idx, selectedEventId: null } : { selectedHotspot: null })
    }
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
    }
  }, [mapLoaded])

  // Pointer cursor over clickable severe/hurricane features. A single
  // mousemove hit-test (scoped to the active globe's click layers) instead of
  // per-layer mouseenter/mouseleave: the report and storm-head stacks
  // overlap, so independent enter/leave handlers drop the pointer while still
  // hovering a clickable feature (review finding). Only attached on the two
  // native-picking globes, so it never fights EONET's own cursor handling.
  useEffect(() => {
    if (!mapLoaded || (globe !== 'severe' && globe !== 'hurricanes' && globe !== 'quakes')) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const clickLayers = (
      globe === 'severe'
        ? SEVERE_CLICK_LAYERS
        : globe === 'hurricanes'
          ? HURRICANE_CLICK_LAYERS
          : QUAKE_CLICK_LAYERS
    ) as readonly string[]
    const onMove = (e: MapMouseEvent) => {
      const present = clickLayers.filter((l) => map.getLayer(l))
      const hit = present.length > 0 && map.queryRenderedFeatures(e.point, { layers: present }).length > 0
      map.getCanvas().style.cursor = hit ? 'pointer' : ''
    }
    map.on('mousemove', onMove)
    return () => {
      map.off('mousemove', onMove)
      map.getCanvas().style.cursor = ''
    }
  }, [mapLoaded, globe])

  // Imperative bridge for search/stats navigation + viewport stats.
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    mapBus.flyTo = ({ lon, lat, zoom: z }) =>
      map.flyTo({ center: [lon, lat], zoom: z, duration: 1800, essential: false })
    mapBus.getCamera = () => {
      const c = map.getCenter()
      return { lon: c.lng, lat: c.lat, zoom: map.getZoom() }
    }
    mapBus.getBounds = () => {
      try {
        const b = map.getBounds()
        const west = b.getWest()
        const east = b.getEast()
        // maplibre reports unwrapped longitudes across the antimeridian
        // (west 170, east 210) — normalize to [-180,180] so a west>east
        // result means "crosses the antimeridian" downstream.
        if (east - west >= 360) return { west: -180, south: -90, east: 180, north: 90 }
        const wrap = (x: number) => {
          const w = ((((x + 180) % 360) + 360) % 360) - 180
          return w === -180 && x > 0 ? 180 : w
        }
        return { west: wrap(west), south: b.getSouth(), east: wrap(east), north: b.getNorth() }
      } catch {
        return null
      }
    }
    return () => {
      mapBus.flyTo = null
      mapBus.getBounds = null
      mapBus.getCamera = null
    }
  }, [mapLoaded])

  const layers = useMemo(() => {
    // splats render beneath the event reticles once those layers exist
    const beforeId = mapLoaded ? EONET_ICON_LAYER : undefined
    // all-native globes (polygons/lines/points/field — no deck splats)
    if (globe === 'severe' || globe === 'hurricanes' || globe === 'quakes' || globe === 'aurora')
      return []
    if (globe === 'lightning') {
      return lightning
        ? buildLightningLayers({
            data: lightning,
            zoom,
            quality,
            // pulse ticks ~30fps, so the sliding age window follows the clock
            nowSec: Date.now() / 1000,
            ignite,
            pulse,
            beforeId,
          })
        : []
    }
    return data
      ? buildFireLayers({
          data,
          zoom,
          quality,
          filters: { frpMin, confMin, dayNight },
          timeRange,
          showHeat,
          showPoints,
          ignite,
          pulse,
          beforeId,
        })
      : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globe, lightning, data, zoom, quality, frpMin, confMin, dayNight, timeRange, showHeat, showPoints, ignite, pulse, mapLoaded])

  return (
    <Map
      ref={mapRef}
      initialViewState={
        jump
          ? { longitude: jump.lon, latitude: jump.lat, zoom: jump.z }
          : ENTRANCE_START
      }
      minZoom={0.4}
      maxZoom={15}
      // The camera is locked north-up and unpitched: deck.gl's globe viewport
      // has no bearing/pitch support (its view matrix is built from
      // latitude/longitude only), so any rotation MapLibre applied would
      // detach the fire field from the basemap — fires rendered north-up over
      // a rotated globe (user bug report). Nothing in Ember uses bearing or
      // pitch, so constrain the gestures instead of the renderer.
      maxPitch={0}
      dragRotate={false}
      pitchWithRotate={false}
      touchPitch={false}
      mapStyle={BASEMAP_STYLES[basemap]}
      onLoad={(e) => {
        const map = e.target as MapLibreMap
        // Constructor props above cover drag/pitch; these two handlers keep
        // two-finger twist and Shift+arrow keys from setting a bearing.
        map.touchZoomRotate.disableRotation()
        map.keyboard.disableRotation()
        styleMapForSpace(map, styleStateRef.current.projection)
        // Native layers must exist before deck layers anchor to them via
        // beforeId — create them (empty if data is pending) pre-render.
        syncNativeLayers(map)
        // Any later style swap (basemap switch) rebuilds from scratch —
        // re-apply everything when the new style lands ('style.load' fires
        // before deck re-resolves its layer groups).
        map.on('style.load', () => {
          styleMapForSpace(map, styleStateRef.current.projection)
          syncNativeLayers(map)
        })
        if (import.meta.env.DEV) {
          // Tripwire (review finding): gestures are locked above, but nothing
          // clamps a programmatic easeTo/jumpTo({bearing}) — which would
          // silently detach the deck fire layers again. Make that loud.
          map.on('rotate', () => {
            if (map.getBearing() !== 0)
              console.warn(
                '[ember] bearing set on the north-up-locked map — deck globe layers will detach from the basemap (see DECISIONS.md)',
              )
          })
          // test hook: lets headless verification read camera state
          ;(window as unknown as { __emberMap?: MapLibreMap }).__emberMap = map
        }
        setMapLoaded(true)
      }}
      onMove={(e) => setZoom(e.viewState.zoom)}
      onMoveEnd={() => {
        // Throttle with a trailing edge: a moveend inside the window is
        // deferred, never dropped, so the final camera position always
        // refreshes the in-view stats (review finding).
        const bump = () => {
          lastEpochBump.current = Date.now()
          setEmber({ viewEpoch: (useEmber.getState().viewEpoch + 1) % 1_000_000 })
        }
        const since = Date.now() - lastEpochBump.current
        if (since >= 1200) {
          bump()
        } else if (epochTimer.current === null) {
          epochTimer.current = window.setTimeout(() => {
            epochTimer.current = null
            bump()
          }, 1200 - since)
        }
      }}
      attributionControl={{ compact: true }}
      style={{ position: 'absolute', inset: 0, background: 'transparent' }}
    >
      {/* Event selection is handled by maplibre symbol-layer listeners
          (attachEonetInteraction); hotspot picking by nearest-search. */}
      <DeckGLOverlay layers={layers} interleaved />
    </Map>
  )
}
