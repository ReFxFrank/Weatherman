import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { glass } from './ui'

/**
 * Geocoder search (§5.6) via Photon (komoot) — free, keyless, CORS-open.
 * Debounced, keyboard-navigable, silent on failure.
 */

interface Hit {
  label: string
  secondary: string
  lon: number
  lat: number
  zoom: number
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: {
    name?: string
    city?: string
    state?: string
    country?: string
    type?: string
    osm_value?: string
  }
}

function zoomFor(p: PhotonFeature['properties']): number {
  const t = p.type ?? p.osm_value ?? ''
  if (t === 'country') return 3.8
  if (t === 'state' || t === 'region') return 5.5
  if (t === 'county' || t === 'district') return 7
  if (t === 'city' || t === 'town') return 9
  if (t === 'village' || t === 'hamlet') return 11
  return 12
}

function toHit(f: PhotonFeature): Hit | null {
  const p = f.properties
  if (!p.name || !f.geometry?.coordinates) return null
  const secondary = [p.city, p.state, p.country].filter((x) => x && x !== p.name)
  return {
    label: p.name,
    secondary: [...new Set(secondary)].join(', '),
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    zoom: zoomFor(p),
  }
}

export function SearchBox({
  onNavigate,
  className = 'absolute right-4 top-4 z-20 w-60 hidden lg:block',
}: {
  onNavigate: (t: { lon: number; lat: number; zoom: number; label: string }) => void
  className?: string
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [active, setActive] = useState(0)
  const [failed, setFailed] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const pickedRef = useRef<string | null>(null)

  // debounced fetch
  useEffect(() => {
    if (query.trim().length < 2 || query === pickedRef.current) {
      // also kill any in-flight request — its late resolution would reopen
      // the dropdown for an abandoned query (review finding)
      abortRef.current?.abort()
      setHits(null)
      setFailed(false)
      return
    }
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        const res = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(query.trim())}&limit=6&lang=en`,
          { signal: ctrl.signal },
        )
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { features?: PhotonFeature[] }
        const list = (json.features ?? []).map(toHit).filter((h): h is Hit => h !== null)
        setHits(list)
        setActive(0)
        setFailed(false)
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setHits([])
          setFailed(true)
        }
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => () => abortRef.current?.abort(), [])

  // click-outside closes
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setHits(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  const pick = (h: Hit) => {
    pickedRef.current = h.label
    setQuery(h.label)
    setHits(null)
    onNavigate(h)
  }

  return (
    <div ref={rootRef} className={className}>
      <div className={`flex items-center gap-2 px-3 py-2 focus-within:border-amber-500/40 ${glass}`}>
        <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        <input
          value={query}
          onChange={(e) => {
            pickedRef.current = null
            setQuery(e.target.value)
          }}
          onKeyDown={(e) => {
            if (!hits || hits.length === 0) {
              if (e.key === 'Escape') {
                setQuery('')
                ;(e.target as HTMLInputElement).blur()
              }
              return
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => (a + 1) % hits.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => (a - 1 + hits.length) % hits.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(hits[active])
            } else if (e.key === 'Escape') {
              setHits(null)
            }
          }}
          placeholder="Search places…"
          aria-label="Search places"
          className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
        />
      </div>

      {hits !== null && (
        <div className={`mt-1.5 overflow-hidden py-1 ${glass}`}>
          {failed && <p className="px-3 py-1.5 text-[11px] text-slate-500">search unavailable</p>}
          {!failed && hits.length === 0 && (
            <p className="px-3 py-1.5 text-[11px] text-slate-500">no places found</p>
          )}
          {hits.map((h, i) => (
            <button
              key={`${h.label}-${h.lon}-${h.lat}`}
              type="button"
              onClick={() => pick(h)}
              onMouseEnter={() => setActive(i)}
              className={`block w-full px-3 py-1.5 text-left ${
                i === active ? 'bg-amber-500/10 text-amber-200' : 'text-slate-300'
              }`}
            >
              <span className="block truncate text-xs">{h.label}</span>
              {h.secondary && (
                <span className="block truncate text-[10px] text-slate-500">{h.secondary}</span>
              )}
            </button>
          ))}
          <p className="px-3 pt-1 text-[9px] text-slate-600">search © Photon / OpenStreetMap</p>
        </div>
      )}
    </div>
  )
}
