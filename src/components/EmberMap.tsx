import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { useControl } from 'react-map-gl/maplibre'
import type { MapRef } from 'react-map-gl/maplibre'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { FireData } from '../lib/types'
import type { QualityConfig } from '../lib/quality'
import { buildFireLayers } from '../lib/fireLayers'
import {
  ENTRANCE_START,
  fireCenter,
  flyEntrance,
  reducedMotion,
  startIdleRotation,
} from '../lib/cinematics'
import { useEmber, type Basemap, type Projection } from '../store'

/** CARTO dark styles — zero-key vector basemaps (decision log: docs/DECISIONS.md). */
const BASEMAP_STYLES: Record<Basemap, string> = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  'dark-nolabels': 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json',
}

const IGNITE_DELAY_MS = 600
const IGNITE_MS = 2200

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

export function EmberMap({ data, quality }: { data: FireData | undefined; quality: QualityConfig }) {
  const mapRef = useRef<MapRef>(null)
  const jump = useMemo(cameraOverride, [])
  const [mapLoaded, setMapLoaded] = useState(false)
  const [zoom, setZoom] = useState(jump ? jump.z : ENTRANCE_START.zoom)
  const [ignite, setIgnite] = useState(jump ? 1 : 0)
  const [cameraSettled, setCameraSettled] = useState(Boolean(jump))
  const entranceStarted = useRef(false)

  const frpMin = useEmber((s) => s.frpMin)
  const confMin = useEmber((s) => s.confMin)
  const dayNight = useEmber((s) => s.dayNight)
  const showHeat = useEmber((s) => s.showHeat)
  const showPoints = useEmber((s) => s.showPoints)
  const projection = useEmber((s) => s.projection)
  const basemap = useEmber((s) => s.basemap)

  // Keep the current projection visible to the style.load handler without
  // re-registering it (a basemap switch replaces the whole style, wiping the
  // projection, sky and our re-tint — they must be re-applied).
  const projectionRef = useRef(projection)
  projectionRef.current = projection

  // Entrance: once the globe is up and data has arrived, ease down from orbit
  // onto the hardest-burning longitude while the fires ignite (§5.7).
  useEffect(() => {
    if (!mapLoaded || !data || entranceStarted.current) return
    const map = mapRef.current?.getMap()
    if (!map) return
    entranceStarted.current = true

    if (jump) return // dev override: already in place, fully ignited

    const target = fireCenter(data.positions, data.frp)
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
  }, [mapLoaded, data, jump])

  // Idle auto-rotation, armed only after the entrance has settled.
  useEffect(() => {
    if (!cameraSettled) return
    const map = mapRef.current?.getMap()
    if (!map) return
    return startIdleRotation(map)
  }, [cameraSettled])

  // Projection toggle (§5.1: globe default, flat for regional drill-down).
  useEffect(() => {
    if (!mapLoaded) return
    mapRef.current?.getMap()?.setProjection({ type: projection })
  }, [projection, mapLoaded])

  const layers = useMemo(
    () =>
      data
        ? buildFireLayers({
            data,
            zoom,
            quality,
            filters: { frpMin, confMin, dayNight },
            showHeat,
            showPoints,
            ignite,
          })
        : [],
    [data, zoom, quality, frpMin, confMin, dayNight, showHeat, showPoints, ignite],
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
      mapStyle={BASEMAP_STYLES[basemap]}
      onLoad={(e) => {
        const map = e.target as MapLibreMap
        styleMapForSpace(map, projectionRef.current)
        // Any later style swap (basemap switch) rebuilds from scratch —
        // re-apply projection, sky and tint when the new style lands.
        map.on('style.load', () => styleMapForSpace(map, projectionRef.current))
        if (import.meta.env.DEV) {
          // test hook: lets headless verification read camera state
          ;(window as unknown as { __emberMap?: MapLibreMap }).__emberMap = map
        }
        setMapLoaded(true)
      }}
      onMove={(e) => setZoom(e.viewState.zoom)}
      attributionControl={{ compact: true }}
      style={{ position: 'absolute', inset: 0, background: 'transparent' }}
    >
      <DeckGLOverlay layers={layers} interleaved />
    </Map>
  )
}
