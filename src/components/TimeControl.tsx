import { useEffect, useMemo, useState } from 'react'
import { Pause, Play, Radio } from 'lucide-react'
import { REFRESH_MS } from '../lib/api'
import type { FireData } from '../lib/types'
import { setEmber, useEmber } from '../store'
import { glass } from './ui'

/**
 * The §5.2 time control: a 1–10 day window slider, an activity histogram
 * timeline, and day-by-day playback that sweeps a 24h slice through the
 * window. Scrubbing/playing only moves the GPU age-filter uniform.
 */

const DAY_MS = 2400 // playback pace: one day of fire in 2.4s

const fmtUtc = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}

const fmtSliceDate = (fetchedAt: string, agedays: number) => {
  const d = new Date(Date.parse(fetchedAt) - agedays * 86400_000)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function RefreshReadout({ fetchedAt, dataUpdatedAt }: { fetchedAt: string; dataUpdatedAt: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const remain = Math.max(0, dataUpdatedAt + REFRESH_MS - Date.now())
  const m = Math.floor(remain / 60000)
  const s = String(Math.floor((remain % 60000) / 1000)).padStart(2, '0')
  return (
    <div className="text-right font-mono text-[10px] leading-tight text-slate-500">
      <div>
        upd <span className="text-slate-400">{fmtUtc(fetchedAt)}</span>
      </div>
      <div>
        next <span className="text-slate-400">{m}:{s}</span>
      </div>
    </div>
  )
}

export function TimeControl({ data, dataUpdatedAt }: { data: FireData | undefined; dataUpdatedAt: number }) {
  const days = useEmber((s) => s.days)
  const playhead = useEmber((s) => s.playhead)
  const playing = useEmber((s) => s.playing)

  // Playback driver: sweep the slice's trailing edge from oldest → newest,
  // then loop. rAF-paced so the GPU filter animates every frame.
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let raf = requestAnimationFrame(function tick(now: number) {
      const dt = Math.min(now - last, 100)
      last = now
      const st = useEmber.getState()
      const cur = st.playhead ?? st.days
      const next = cur - dt / DAY_MS
      useEmber.setState({ playhead: next <= 1 ? st.days : next })
      raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // Detections per 6h bucket across the window, oldest → newest, for the
  // timeline sparkline. Recomputed only when the dataset or window changes.
  const hist = useMemo(() => {
    if (!data) return [] as number[]
    const buckets = new Array(Math.max(4, Math.round(days * 4))).fill(0) as number[]
    const fetchSec = Date.parse(data.meta.fetchedAt) / 1000
    for (let i = 0; i < data.count; i++) {
      const age = (fetchSec - data.tsSec[i]) / 86400
      if (age < 0 || age >= days) continue
      const b = Math.min(buckets.length - 1, Math.floor((1 - age / days) * buckets.length))
      buckets[b]++
    }
    const max = Math.max(...buckets, 1)
    return buckets.map((v) => v / max)
  }, [data, days])

  if (!data) return null

  const sliceActive = playhead !== null
  // Scrub position p ∈ [0,1]: 0 = oldest slice, 1 = most recent slice.
  const p = sliceActive ? (days - playhead) / Math.max(days - 1, 0.0001) : 1
  const bandLeft = sliceActive ? `${((days - playhead) / days) * 100}%` : '0%'
  const bandWidth = sliceActive ? `${(1 / days) * 100}%` : '100%'
  const underCovered = data.meta.mode === 'public-feed' && days > data.meta.coverageDays

  return (
    <div
      className={`absolute bottom-6 left-1/2 z-10 w-[min(660px,92vw)] -translate-x-1/2 px-4 py-2.5 ${glass}`}
    >
      <div className="flex items-center gap-3">
        {/* transport */}
        <button
          type="button"
          disabled={days < 2}
          title={days < 2 ? 'Extend the window to animate' : playing ? 'Pause' : 'Play day by day'}
          onClick={() =>
            setEmber(playing ? { playing: false } : { playing: true, playhead: playhead ?? days })
          }
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
            days < 2
              ? 'cursor-not-allowed border-white/10 text-slate-600'
              : playing
                ? 'border-amber-500/60 bg-amber-500/20 text-amber-300 shadow-[0_0_14px_rgba(245,158,11,0.35)]'
                : 'border-white/15 text-slate-300 hover:border-amber-500/40 hover:text-amber-300'
          }`}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="ml-0.5 h-3.5 w-3.5" />}
        </button>

        {/* timeline: histogram + slice band + scrubber */}
        <div className="relative h-9 min-w-0 flex-1">
          <div className="absolute inset-x-0 bottom-1 top-1 overflow-hidden rounded">
            <div className="flex h-full items-end gap-px">
              {hist.map((h, i) => (
                <div
                  key={i}
                  className="min-w-0 flex-1 rounded-t-[1px] bg-gradient-to-t from-amber-700/70 to-amber-400/80"
                  style={{ height: `${Math.max(h * 100, 4)}%`, opacity: 0.35 + h * 0.65 }}
                />
              ))}
            </div>
            {/* active slice / live window band */}
            <div
              className={`pointer-events-none absolute inset-y-0 rounded-sm border ${
                sliceActive ? 'border-amber-300/70 bg-amber-300/15' : 'border-transparent'
              }`}
              style={{ left: bandLeft, width: bandWidth }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(p * 1000)}
            onChange={(e) => {
              const pos = Number(e.target.value) / 1000
              setEmber({ playing: false, playhead: days - pos * Math.max(days - 1, 0.0001) })
            }}
            aria-label="Scrub through the time window"
            className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
          />
          <div className="pointer-events-none absolute -bottom-1.5 left-0 font-mono text-[9px] text-slate-600">
            −{days}d
          </div>
          <div className="pointer-events-none absolute -bottom-1.5 right-0 font-mono text-[9px] text-slate-600">
            now
          </div>
        </div>

        {/* status: live vs slice */}
        <button
          type="button"
          onClick={() => setEmber({ playhead: null, playing: false })}
          title="Show the whole window live"
          className={`flex w-[86px] shrink-0 flex-col items-center rounded border px-2 py-1 transition-colors ${
            sliceActive
              ? 'border-white/10 text-slate-400 hover:border-amber-500/40 hover:text-amber-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          }`}
        >
          {sliceActive ? (
            <>
              <span className="font-mono text-[11px] leading-tight">{fmtSliceDate(data.meta.fetchedAt, playhead - 0.5)}</span>
              <span className="font-mono text-[9px] leading-tight text-slate-500">
                −{(playhead - 0.5).toFixed(1)}d · back to live
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1 text-[11px] font-semibold tracking-widest">
                <Radio className="h-3 w-3 animate-pulse" /> LIVE
              </span>
              <span className="font-mono text-[9px] leading-tight text-slate-500">full window</span>
            </>
          )}
        </button>

        {/* window size */}
        <div className="w-[92px] shrink-0">
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={days}
            onChange={(e) => setEmber({ days: Number(e.target.value) })}
            className="w-full accent-amber-500"
            aria-label="Day window (1–10 days)"
          />
          <div className="mt-0.5 text-center font-mono text-[10px] leading-none text-slate-400">
            {days}d window
            {underCovered && (
              <span className="block text-[9px] text-amber-600/90">feed caps at {data.meta.coverageDays}d</span>
            )}
          </div>
        </div>

        <RefreshReadout fetchedAt={data.meta.fetchedAt} dataUpdatedAt={dataUpdatedAt} />
      </div>
    </div>
  )
}
