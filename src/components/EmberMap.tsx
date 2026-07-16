import { useMemo } from 'react'
import Map, { useControl } from 'react-map-gl/maplibre'
import type { MapLibreEvent } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { ScatterplotLayer } from '@deck.gl/layers'
import type { HotspotResponse } from '../lib/types'
import { frpColor, frpRadiusPx } from '../lib/colors'

/** CARTO dark-matter — zero-key vector basemap (decision log: docs/DECISIONS.md). */
const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

function DeckGLOverlay(props: ConstructorParameters<typeof MapboxOverlay>[0]) {
  // MapboxOverlay implements maplibre's IControl, so react-map-gl can mount it.
  const overlay = useControl(() => new MapboxOverlay(props)) as unknown as MapboxOverlay
  overlay.setProps(props)
  return null
}

function onMapLoad(e: MapLibreEvent) {
  const map = e.target

  // Globe is the default and primary view (§5.1), with the atmosphere halo.
  map.setProjection({ type: 'globe' })
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

export function EmberMap({ data }: { data: HotspotResponse | undefined }) {
  const layers = useMemo(() => {
    if (!data) return []
    const { columns, count } = data
    return [
      // Phase 0: raw dump of every detection. Heatmap↔scatter swap, additive
      // "fires as light" blending and bloom arrive in Phase 1.
      new ScatterplotLayer({
        id: 'firms-hotspots',
        data: { length: count },
        getPosition: (_: unknown, { index }: { index: number }) => [columns.lon[index], columns.lat[index]],
        getFillColor: (_: unknown, { index }: { index: number }) => frpColor(columns.frp[index]),
        getRadius: (_: unknown, { index }: { index: number }) => frpRadiusPx(columns.frp[index]),
        radiusUnits: 'pixels',
        radiusMinPixels: 1,
        stroked: false,
        pickable: false,
        opacity: 0.85,
      }),
    ]
  }, [data])

  return (
    <Map
      initialViewState={{ longitude: 15, latitude: 12, zoom: 1.6 }}
      minZoom={0.8}
      maxZoom={15}
      mapStyle={BASEMAP_STYLE}
      onLoad={onMapLoad}
      attributionControl={{ compact: true }}
      style={{ position: 'absolute', inset: 0, background: 'transparent' }}
    >
      <DeckGLOverlay layers={layers} interleaved />
    </Map>
  )
}
