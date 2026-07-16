import { mapBus } from './mapBus'
import { useEmber } from '../store'

/**
 * Shareable deep links (Phase 5): the URL mirrors camera + source + window +
 * filters via history.replaceState, so copying the address bar shares the
 * exact view. Loading such a URL jumps straight there (EmberMap's
 * cameraOverride) with filters applied (store's stateFromUrl).
 */

const DEFAULTS = { source: 'VIIRS_NOAA20_NRT', days: 1 }

function syncUrl() {
  const cam = mapBus.getCamera?.()
  if (!cam) return
  const s = useEmber.getState()
  // Preserve unrelated params (?debug, ?quality, ?stride…)
  const q = new URLSearchParams(location.search)
  q.set('lat', cam.lat.toFixed(3))
  q.set('lon', cam.lon.toFixed(3))
  q.set('z', cam.zoom.toFixed(2))
  const setOrDelete = (key: string, value: string | null) =>
    value === null ? q.delete(key) : q.set(key, value)
  setOrDelete('source', s.source === DEFAULTS.source ? null : s.source)
  setOrDelete('days', s.days === DEFAULTS.days ? null : String(s.days))
  setOrDelete('frp', s.frpMin > 0 ? s.frpMin.toFixed(1) : null)
  setOrDelete('conf', s.confMin > 0 ? String(s.confMin) : null)
  setOrDelete('dn', s.dayNight !== 'all' ? s.dayNight : null)
  history.replaceState(null, '', `${location.pathname}?${q.toString()}`)
}

/** Debounced store subscription — viewEpoch bumps carry camera changes. */
export function startDeepLinkSync(): () => void {
  let timer: number | null = null
  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      syncUrl()
    }, 800)
  }
  const unsub = useEmber.subscribe(schedule)
  return () => {
    unsub()
    if (timer !== null) clearTimeout(timer)
  }
}
