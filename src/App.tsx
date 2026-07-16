import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Flame, Satellite } from 'lucide-react'
import { fetchFireDecoded } from './lib/api'
import { deriveRenderAttributes } from './lib/binary'
import { qualityConfig } from './lib/quality'
import { useFps } from './lib/useFps'
import { EmberMap } from './components/EmberMap'
import { FilterPanel } from './components/FilterPanel'
import { Starfield } from './components/Starfield'
import { glass } from './components/ui'
import { SOURCES, useEmber } from './store'

export default function App() {
  const source = useEmber((s) => s.source)
  const days = useEmber((s) => s.days)
  const tier = useEmber((s) => s.quality)
  const frpMin = useEmber((s) => s.frpMin)
  const confMin = useEmber((s) => s.confMin)
  const dayNight = useEmber((s) => s.dayNight)

  const quality = useMemo(() => {
    const q = qualityConfig(tier)
    // dev/test override: ?stride=N decimates points without changing the tier
    const stride = Number(new URLSearchParams(location.search).get('stride'))
    return Number.isFinite(stride) && stride >= 1 ? { ...q, stride: Math.floor(stride) } : q
  }, [tier])
  const debug = useMemo(() => new URLSearchParams(location.search).has('debug'), [])
  const fps = useFps(debug)

  // Refetch happens ONLY when source/days change (§5.3); filters and quality
  // reuse the cached payload.
  const { data: decoded, isLoading, isError, error, isPlaceholderData } = useQuery({
    queryKey: ['fire', source, days],
    queryFn: () => fetchFireDecoded(source, days),
    placeholderData: keepPreviousData,
  })

  const data = useMemo(
    () => (decoded ? deriveRenderAttributes(decoded, quality.stride) : undefined),
    [decoded, quality.stride],
  )

  // Filtered count for the HUD — the GPU does the visual filtering; this CPU
  // pass only runs when a filter/dataset changes, for the readout.
  const shownCount = useMemo(() => {
    if (!data) return 0
    const wantNight = dayNight === 'all' ? -1 : dayNight === 'night' ? 1 : 0
    if (frpMin <= 0 && confMin === 0 && wantNight === -1) return data.count
    let n = 0
    for (let i = 0; i < data.count; i++) {
      if (data.frp[i] < frpMin) continue
      if (data.conf[i] < confMin) continue
      if (wantNight !== -1 && data.night[i] !== wantNight) continue
      n++
    }
    return n
  }, [data, frpMin, confMin, dayNight])

  const filtersActive = frpMin > 0 || confMin > 0 || dayNight !== 'all'
  const sourceLabel = SOURCES.find((x) => x.id === source)?.label ?? source

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Starfield />
      <EmberMap data={data} quality={quality} />
      <FilterPanel />

      {/* Brand + feed status HUD */}
      <header className={`absolute left-4 top-4 z-10 px-4 py-3 select-none ${glass}`}>
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-amber-500" strokeWidth={2.5} />
          <span className="text-sm font-semibold tracking-[0.25em] text-slate-100">EMBER</span>
          <span className="ml-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium tracking-widest text-amber-400">
            LIVE
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-slate-400">
          <Satellite className="h-3 w-3 shrink-0 text-slate-500" />
          {isLoading && <span className="animate-pulse text-slate-300">ACQUIRING SATELLITE FEED…</span>}
          {isError && (
            <span className="text-red-400">
              FEED ERROR — {error instanceof Error ? error.message.slice(0, 80) : 'unknown'}
            </span>
          )}
          {data && (
            <span className={isPlaceholderData ? 'opacity-50' : ''}>
              {filtersActive ? (
                <>
                  <span className="text-amber-300">{shownCount.toLocaleString()}</span>
                  <span className="text-slate-500"> of {data.meta.count.toLocaleString()}</span>
                </>
              ) : (
                <span className="text-amber-300">{data.meta.count.toLocaleString()}</span>
              )}{' '}
              detections · last {data.meta.coverageDays * 24}h · {sourceLabel} ·{' '}
              {data.meta.mode === 'api' ? 'area API' : 'public feed'}
              {data.meta.stale ? ' · STALE' : ''}
              {isPlaceholderData ? ' · switching…' : ''}
            </span>
          )}
        </div>
        {debug && (
          <div className="mt-1 font-mono text-[10px] text-cyan-500/80">
            {fps} fps · {quality.tier} · rendering {data ? data.count.toLocaleString() : 0}
            {data && data.count !== data.meta.count ? ` of ${data.meta.count.toLocaleString()}` : ''}
          </div>
        )}
      </header>

      {/* Required data attribution (§10 footer) */}
      <footer
        className={`absolute bottom-8 left-4 z-10 px-3 py-1.5 text-[10px] tracking-wide text-slate-500 ${glass}`}
      >
        Active fire data: NASA FIRMS (MODIS/VIIRS) · Named events: NASA EONET
      </footer>
    </div>
  )
}
