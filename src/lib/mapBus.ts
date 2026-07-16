/**
 * Tiny imperative bridge between the map (owned by EmberMap) and UI outside
 * it (stats jump-to, search navigation, viewport-bounds reads) — avoids
 * threading refs through the tree for three call sites.
 */
export interface MapBus {
  flyTo: ((t: { lon: number; lat: number; zoom: number }) => void) | null
  getBounds: (() => { west: number; south: number; east: number; north: number } | null) | null
  getCamera: (() => { lon: number; lat: number; zoom: number }) | null
}

export const mapBus: MapBus = {
  flyTo: null,
  getBounds: null,
  getCamera: null,
}
