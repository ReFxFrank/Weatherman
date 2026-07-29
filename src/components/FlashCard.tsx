import { useEffect, useState } from 'react'
import { CalendarDays, Crosshair, MapPin, Satellite, X, Zap } from 'lucide-react'
import type { DecodedLightning, LightningData } from '../lib/types'
import { glass } from './ui'

/**
 * Detail card for a clicked lightning flash: live-ticking "struck N ago",
 * absolute UTC + local time, optical energy with its rank in the current
 * window, the satellite that saw it, and a reverse-geocoded nearest place.
 *
 * Honesty notes baked into the copy: GLM flash times are quantized to the
 * 20 s granule start; energy is optical energy at cloud top (what the
 * sensor measures), not stroke current; Photon's nearest feature can be far
 * from an offshore flash, so distant matches render as "open water".
 */

/** Sorted-energy cache per payload for percentile ranks (lazy, ~1 sort). */
const sortedEnergyCache = new WeakMap<DecodedLightning, Float32Array>()
function energyRank(full: DecodedLightning, e: number): number {
  let sorted = sortedEnergyCache.get(full)
  if (!sorted) {
    sorted = Float32Array.from(full.energy).sort()
    sortedEnergyCache.set(full, sorted)
  }
  // binary search: fraction of window flashes with energy below e
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < e) lo = mid + 1
    else hi = mid
  }
  return sorted.length ? lo / sorted.length : 0
}

/** "3m 41s ago" / "41s ago" / "1h 02m ago" */
function fmtAgo(sec: number): string {
  if (sec < 0) sec = 0
  if (sec < 60) return `${Math.floor(sec)}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${String(Math.floor(sec % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const fmtEnergy = (fj: number) =>
  fj >= 10_000 ? `${(fj / 1000).toFixed(1)}k` : fj >= 100 ? Math.round(fj).toLocaleString() : fj.toFixed(1)

interface Place {
  /** null = Photon answered and no feature is within range (open water) */
  label: string | null
  /** lookup failed (HTTP error / network) — say so, never claim open water
   *  ("empty ≠ degraded"); errors are never cached so recovery repairs it */
  error?: boolean
}

const placeCache = new Map<string, Place>()

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(a))
}

/** Reverse-geocode via Photon (keyless, CORS-open — same service as search). */
function usePlace(lat: number, lon: number): Place | undefined {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`
  const [place, setPlace] = useState<Place | undefined>(placeCache.get(key))
  useEffect(() => {
    const cached = placeCache.get(key)
    if (cached) {
      setPlace(cached)
      return
    }
    setPlace(undefined)
    let cancelled = false
    fetch(`https://photon.komoot.io/reverse?lon=${lon.toFixed(4)}&lat=${lat.toFixed(4)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`photon ${r.status}`)
        return r.json()
      })
      .then(
        (j: {
          features?: Array<{
            properties?: { name?: string; city?: string; state?: string; country?: string }
            geometry?: { coordinates?: [number, number] }
          }>
        }) => {
          if (cancelled) return
          const f = j?.features?.[0]
          let label: string | null = null
          if (f?.properties) {
            const p = f.properties
            const parts = [p.city ?? p.name, p.state, p.country].filter(
              (x, i, a) => x && a.indexOf(x) === i,
            )
            const c = f.geometry?.coordinates
            const distKm = c ? haversineKm(lat, lon, c[1], c[0]) : 0
            // a "nearest feature" hundreds of km away means open water
            if (parts.length && distKm < 150) {
              label = distKm >= 3 ? `≈${Math.round(distKm)} km from ${parts.join(', ')}` : parts.join(', ')
            }
          }
          // only a SUCCESSFUL answer is cached — and only a successful
          // answer may render as "open water"
          const resolved = { label }
          placeCache.set(key, resolved)
          setPlace(resolved)
        },
      )
      .catch(() => {
        if (!cancelled) setPlace({ label: null, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [key, lat, lon])
  return place
}

export function FlashCard({
  data,
  full,
  index,
  onClose,
  className = 'w-72',
}: {
  /** rendered set — `index` addresses these arrays */
  data: LightningData
  /** full decoded payload — percentile rank base (undecimated) */
  full: DecodedLightning
  index: number
  onClose: () => void
  className?: string
}) {
  const lon = data.positions[index * 2]
  const lat = data.positions[index * 2 + 1]
  const energy = data.energy[index]
  const tsSec = data.tsSec[index]
  const sat = data.meta.sats[data.sat[index]]
  const isMtg = sat?.id.startsWith('MTI')

  // tick every second — "how long ago" is the card's headline
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const ageSec = Date.now() / 1000 - tsSec
  const struck = new Date(tsSec * 1000)

  const rank = energyRank(full, energy)
  const rankLabel =
    rank >= 0.99 ? 'top 1%' : rank >= 0.9 ? `top ${Math.max(1, Math.round((1 - rank) * 100))}%` : `stronger than ${Math.round(rank * 100)}%`

  const place = usePlace(lat, lon)

  return (
    <aside className={`${className} border-sky-400/20 ${glass}`}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <h2 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em] text-sky-300/90">
          <Zap className="h-3.5 w-3.5" /> LIGHTNING DETECTION
        </h2>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="mt-0.5 rounded p-0.5 text-slate-500 hover:bg-white/5 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="px-4 pb-3 pt-2">
        <div className="font-mono text-2xl font-semibold leading-none text-sky-300">
          {fmtAgo(ageSec)} <span className="text-sm text-sky-500/70">ago</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-500">
          time since detection{isMtg ? '' : ' · GLM times snap to 20 s granules'}
        </p>

        <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
          <div className="flex items-start gap-2">
            <CalendarDays className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
            <div>
              <div>{struck.toISOString().slice(0, 19).replace('T', ' ')}Z</div>
              <div className="text-[10px] text-slate-500">
                {struck.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} local
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="h-3 w-3 shrink-0 text-slate-600" />
            {fmtEnergy(energy)} fJ{' '}
            <span className="rounded border border-sky-400/30 bg-sky-400/10 px-1.5 py-px text-[10px] text-sky-300">
              {rankLabel}
            </span>
          </div>
          <p className="pl-5 text-[10px] leading-snug text-slate-600">
            flash optical energy at cloud top · rank within the fetched {full.meta.windowMin || 60}-min window
          </p>
          <div className="flex items-center gap-2">
            <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
            {Math.abs(lat).toFixed(3)}°{lat >= 0 ? 'N' : 'S'}, {Math.abs(lon).toFixed(3)}°
            {lon >= 0 ? 'E' : 'W'}
          </div>
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
            <span className="min-w-0 text-[10px] text-slate-500">
              {place === undefined
                ? 'locating…'
                : place.error
                  ? 'location lookup unavailable'
                  : (place.label ?? 'open water / remote')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Satellite className="h-3 w-3 shrink-0 text-slate-600" />
            {sat?.name ?? 'unknown satellite'}{' '}
            <span className="text-[10px] text-slate-600">{isMtg ? 'MTG-LI' : 'GLM'}</span>
          </div>
          <p className="pl-5 text-[10px] leading-snug text-slate-600">
            {isMtg
              ? 'optical imager, ~4.5 km pixels — position is cloud-top light, not the ground strike point'
              : 'optical mapper, ~8–14 km pixels — position is cloud-top light, not the ground strike point'}
          </p>
        </div>
      </div>
    </aside>
  )
}
