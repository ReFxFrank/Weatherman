import { useEffect, useMemo, useState } from 'react'
import type { DecodedLightning } from '../lib/types'
import { FRESH_MIN } from '../lib/lightningBinary'
import { glass } from './ui'

/**
 * Strike-rate timeline for the lightning globe (bottom-center slot, where
 * the fire globe keeps its playback bar): a per-minute histogram of the
 * rolling window plus age-window buttons that narrow what's on the globe.
 *
 * The window buttons are a GPU filter-range change (lightningLayers), never
 * a refetch — same idiom as fire playback. Counts come from the FULL decoded
 * payload, not the quality-decimated render set, so the numbers are true.
 */

const WINDOWS: Array<{ label: string; value: number | null }> = [
  { label: 'ALL', value: null },
  { label: '30m', value: 30 },
  { label: '10m', value: 10 },
  { label: `${FRESH_MIN}m`, value: FRESH_MIN },
]

export function LightningStrip({
  decoded,
  windowMin,
  onWindow,
}: {
  decoded: DecodedLightning
  windowMin: number | null
  onWindow: (w: number | null) => void
}) {
  // re-bin as the wall clock advances (live payloads slide; 15 s is plenty
  // for one-minute bins)
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  const live = decoded.meta.mode === 'live'
  const totalMin = decoded.meta.windowMin || 60

  const { bins, maxBin, inWindow, perMin } = useMemo(() => {
    // bin 0 = the most recent minute; live bins age against the wall clock,
    // baked bins are frozen at the bake instant (window semantics freeze at
    // bake time — the standing rule for baked payloads)
    const baseSec = live
      ? Date.now() / 1000
      : Math.floor(Date.parse(decoded.meta.fetchedAt) / 1000) || Date.now() / 1000
    const bins = new Array<number>(totalMin).fill(0)
    let edgeSec = 0
    for (let i = 0; i < decoded.count; i++) {
      if (decoded.tsSec[i] > edgeSec) edgeSec = decoded.tsSec[i]
      const ageMin = (baseSec - decoded.tsSec[i]) / 60
      if (ageMin < 0 || ageMin >= totalMin) continue
      bins[Math.floor(ageMin)]++
    }
    const maxBin = Math.max(1, ...bins)
    const limit = windowMin ?? totalMin
    let inWindow = 0
    for (let b = 0; b < Math.min(limit, totalMin); b++) inWindow += bins[b]
    // Rate = the newest minute OF DATA, anchored to the newest timestamp in
    // the payload, not the wall clock/bake instant: refetch lag + the 20 s
    // granule-start quantization would otherwise systematically undercount —
    // near-zero "at bake" on Pages during an active storm (review finding).
    // Inclusive upper bound: a whole GLM granule shares the edge timestamp.
    let perMin = 0
    if (edgeSec > 0) {
      for (let i = 0; i < decoded.count; i++) {
        if (decoded.tsSec[i] > edgeSec - 60 && decoded.tsSec[i] <= edgeSec) perMin++
      }
    }
    return { bins, maxBin, inWindow, perMin }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoded, windowMin, live, totalMin, Math.floor(Date.now() / 15_000)])

  const W = 240
  const H = 34
  const barW = W / totalMin
  const limit = windowMin ?? totalMin

  return (
    <div
      className={`absolute bottom-6 left-1/2 z-10 w-[min(560px,94vw)] -translate-x-1/2 px-4 py-2.5 ${glass}`}
    >
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 gap-1" role="group" aria-label="Lightning age window">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              onClick={() => onWindow(w.value)}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                windowMin === w.value
                  ? 'border-sky-400/40 bg-sky-400/15 text-sky-300'
                  : 'border-slate-700/60 bg-slate-800/30 text-slate-500 hover:text-slate-300'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-9 min-w-0 flex-1"
          preserveAspectRatio="none"
          aria-label="Detections per minute"
        >
          {bins.map((n, minAgo) => {
            if (n === 0) return null
            const h = Math.max(1.5, (n / maxBin) * (H - 2))
            const x = (totalMin - 1 - minAgo) * barW
            const inSel = minAgo < limit
            return (
              <rect
                key={minAgo}
                x={x + 0.25}
                y={H - h}
                width={Math.max(0.5, barW - 0.5)}
                height={h}
                fill={minAgo < FRESH_MIN ? '#bae6fd' : '#38bdf8'}
                opacity={inSel ? (minAgo < FRESH_MIN ? 0.95 : 0.65) : 0.18}
              >
                <title>{`${n.toLocaleString()} detections · ${minAgo}–${minAgo + 1} min ${live ? 'ago' : 'before bake'}`}</title>
              </rect>
            )
          })}
        </svg>

        <div className="shrink-0 text-right font-mono text-[10px] leading-tight text-slate-500 max-sm:hidden">
          <div>
            <span className="text-sky-300">{inWindow.toLocaleString()}</span> in{' '}
            {windowMin ? `last ${windowMin}m` : `${totalMin}m window`}
          </div>
          <div>
            {/* "detections", not strikes: stereo overlap double-counts */}
            <span className="text-slate-400">{perMin.toLocaleString()}</span> det/min
            <span className="text-slate-600"> at data edge</span>
          </div>
        </div>
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[8px] text-slate-600">
        <span>-{totalMin}m</span>
        <span>{live ? 'now' : 'bake'}</span>
      </div>
    </div>
  )
}
