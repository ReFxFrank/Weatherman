import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Flame, Satellite } from 'lucide-react'
import { fetchEonetEvents, fetchFireDecoded, REFRESH_MS } from './lib/api'
import { deriveRenderAttributes } from './lib/binary'
import { qualityConfig } from './lib/quality'
import { useFps } from './lib/useFps'
import { EmberMap } from './components/EmberMap'
import { EventCard } from './components/EventCard'
import { FilterPanel } from './components/FilterPanel'
import { Starfield } from './components/Starfield'
import { TimeControl } from './components/TimeControl'
import { glass } from './components/ui'
import { SOURCES, useEmber } from './store'

export default function App() {
  const source = useEmber((s) => s.source)
  const days = useEmber((s) => s.days)
  const tier = useEmber((s) => s.quality)
  const frpMin = useEmber((s) => s.frpMin)
  const confMin = useEmber((s) => s.confMin)
  const dayNight = useEmber((s) => s.dayNight)

  const quality = useMemo(() => qualityConfig(tier), [tier])
  const debug = useMemo(() => new URLSearchParams(location.search).has('debug'), [])
  const fps = useFps(debug)

  // Refetch happens ONLY when source/days change (§5.3) — plus the §5.2
  // auto-refresh tick, which swaps data in place without any reload.
  const { data: decoded, isLoading, isError, error, isPlaceholderData, dataUpdatedAt } = useQuery({
    queryKey: ['fire', source, days],
    queryFn: () => fetchFireDecoded(source, days),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  })

  // EONET named events — keyless + CORS-friendly, fetched straight from the
  // client (§3.2), refreshed on the same cadence.
  const { data: events } = useQuery({
    queryKey: ['eonet'],
    queryFn: fetchEonetEvents,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  })

  // Decimation stride: the tier baseline, scaled up so multi-day windows stay
  // under the tier's rendered-point cap. ?stride=N (dev/test) wins outright.
  const stride = useMemo(() => {
    const override = Number(new URLSearchParams(location.search).get('stride'))
    if (Number.isFinite(override) && override >= 1) return Math.floor(override)
    if (!decoded) return quality.stride
    return Math.max(quality.stride, Math.ceil(decoded.count / quality.maxPoints))
  }, [decoded, quality])

  const data = useMemo(
    () => (decoded ? deriveRenderAttributes(decoded, stride) : undefined),
    [decoded, stride],
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

  if (import.meta.env.DEV) {
    // test hook: lets headless verification locate real event markers
    ;(window as unknown as { __emberEvents?: typeof events }).__emberEvents = events
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Starfield />
      <EmberMap data={data} events={events} quality={quality} />
      <FilterPanel eventsCount={events?.length} />
      <TimeControl data={data} dataUpdatedAt={dataUpdatedAt} />
      <EventCard events={events} />

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
        className={`absolute bottom-1 left-2 z-0 px-2 py-1 text-[9px] tracking-wide text-slate-600 ${glass}`}
      >
        Active fire data: NASA FIRMS (MODIS/VIIRS) · Named events: NASA EONET
      </footer>
    </div>
  )
}
