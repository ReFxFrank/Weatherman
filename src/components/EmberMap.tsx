import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { useControl } from 'react-map-gl/maplibre'
import type { MapRef } from 'react-map-gl/maplibre'
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { DecodedFire, EonetEvent, FireData } from '../lib/types'
import type { QualityConfig } from '../lib/quality'
import { buildFireLayers } from '../lib/fireLayers'
import { attachEonetInteraction, EONET_ICON_LAYER, syncEonetSymbols } from '../lib/eonetSymbols'
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

  // Everything the style.load handler must restore after a basemap swap
  // (which wipes projection, sky, tint and all native layers), readable
  // without re-registering the handler.
  const styleStateRef = useRef({
    projection,
    events,
    selectedEventId,
    showEvents,
    showTerminator,
    selectedPoint,
    choropleth,
    showChoropleth,
    perimeters,
    showPerimeters,
  })
  styleStateRef.current = {
    projection,
    events,
    selectedEventId,
    showEvents,
    showTerminator,
    selectedPoint,
    choropleth,
    showChoropleth,
    perimeters,
    showPerimeters,
  }

  /** Recreate every native layer in stack order (bottom→top: choropleth,
   *  terminator, perimeters, [deck fires], eonet symbols, selection ring). */
  const syncNativeLayers = (map: MapLibreMap) => {
    const s = styleStateRef.current
    // eonet first: its icon layer is the beforeId anchor for deck + the rest
    syncEonetSymbols(map, s.events ?? [], s.selectedEventId, s.showEvents)
    syncTerminatorLayers(map, { beforeId: EONET_ICON_LAYER, visible: s.showTerminator })
    syncChoroplethLayer(map, s.choropleth, s.showChoropleth)
    syncPerimetersLayer(map, s.perimeters, s.showPerimeters)
    syncSelectionMarker(map, s.selectedPoint)
  }

  // Entrance: once the globe is up and data has arrived, ease down from orbit
  // onto the North America home view while the fires ignite (§5.7).
  useEffect(() => {
    if (!mapLoaded || !full || entranceStarted.current) return
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
    let raf = requestAnimationFrame(function tick(now: number) {
      const p = Math.min(1, Math.max(0, (now - t0) / IGNITE_MS))
      setIgnite(p)
      if (p < 1) raf = requestAnimationFrame(tick)
    })
    // Settle when the ease actually ends (robust on slow renderers), not on a
    // wall-clock guess. A user interrupting the entrance also settles it.
    const onMoveEnd = () => setCameraSettled(true)
    map.once('moveend', onMoveEnd)
    return () => {
      map.off('moveend', onMoveEnd)
      cancelFly()
      cancelAnimationFrame(raf)
    }
  }, [mapLoaded, full, jump])

  // Idle auto-rotation, armed only after the entrance has settled.
  useEffect(() => {
    if (!cameraSettled) return
    const map = mapRef.current?.getMap()
    if (!map) return
    return startIdleRotation(map)
  }, [cameraSettled])

  // Gentle pulse driver for the top-FRP halos — ~30fps, paused when hidden.
  useEffect(() => {
    if (!cameraSettled || ignite < 1) return
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
  }, [cameraSettled, ignite])

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
    events,
    selectedEventId,
    showEvents,
    showTerminator,
    selectedPoint,
    choropleth,
    showChoropleth,
    perimeters,
    showPerimeters,
  ])

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

  const pickStateRef = useRef({ full, frpMin, confMin, dayNight, timeRange })
  pickStateRef.current = { full, frpMin, confMin, dayNight, timeRange }
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return // an EONET marker claimed this click
      const s = pickStateRef.current
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

  const layers = useMemo(
    () =>
      data
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
            // fires render beneath the event reticles once those layers exist
            beforeId: mapLoaded ? EONET_ICON_LAYER : undefined,
          })
        : [],
    [data, zoom, quality, frpMin, confMin, dayNight, timeRange, showHeat, showPoints, ignite, pulse, mapLoaded],
  )

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
