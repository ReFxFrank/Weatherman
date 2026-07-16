import { useQuery } from '@tanstack/react-query'
import { Flame, Satellite } from 'lucide-react'
import { fetchHotspots, DEFAULT_SOURCE } from './lib/api'
import { EmberMap } from './components/EmberMap'
import { Starfield } from './components/Starfield'

const glass =
  'rounded-lg border border-white/10 bg-[#0a0e1a]/60 backdrop-blur-md shadow-[0_4px_24px_rgba(0,0,0,0.45)]'

export default function App() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['hotspots', DEFAULT_SOURCE, 1],
    queryFn: () => fetchHotspots(DEFAULT_SOURCE, 1),
  })

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Starfield />
      <EmberMap data={data} />

      {/* Brand + feed status HUD */}
      <header className={`absolute left-4 top-4 px-4 py-3 select-none ${glass}`}>
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-amber-500" strokeWidth={2.5} />
          <span className="text-sm font-semibold tracking-[0.25em] text-slate-100">EMBER</span>
          <span className="ml-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium tracking-widest text-amber-400">
            LIVE
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-slate-400">
          <Satellite className="h-3 w-3 text-slate-500" />
          {isLoading && <span className="animate-pulse text-slate-300">ACQUIRING SATELLITE FEED…</span>}
          {isError && (
            <span className="text-red-400">
              FEED ERROR — {error instanceof Error ? error.message.slice(0, 80) : 'unknown'}
            </span>
          )}
          {data && (
            <span>
              <span className="text-amber-300">{data.count.toLocaleString()}</span> detections · last{' '}
              {data.coverageDays * 24}h · VIIRS NOAA-20 ·{' '}
              {data.mode === 'api' ? 'area API' : 'public feed'}
              {data.stale ? ' · STALE' : ''}
            </span>
          )}
        </div>
      </header>

      {/* Required data attribution (§10 footer) */}
      <footer
        className={`absolute bottom-8 left-4 px-3 py-1.5 text-[10px] tracking-wide text-slate-500 ${glass}`}
      >
        Active fire data: NASA FIRMS (MODIS/VIIRS) · Named events: NASA EONET
      </footer>
    </div>
  )
}
