import { BarChart3, ChevronRight, Download, Flame, Globe2, Zap } from 'lucide-react'
import type { FireStats } from '../lib/stats'
import { setEmber, useEmber } from '../store'
import { glass, Section } from './ui'

/**
 * Right-hand live stats panel (§5.4): headline count, per-continent breakdown,
 * and the five hottest detections (click to fly there). StatsContent is the
 * unpositioned body, shared by this desktop shell and the mobile bottom sheet.
 */

interface StatsProps {
  stats: FireStats | null
  /** detections newer than the previous refresh (null until a second fetch lands) */
  newSince: { count: number; sinceIso: string } | null
  onJumpTo: (t: { index: number; lon: number; lat: number }) => void
  /** Phase 5: download the current view's detections */
  onExport: (format: 'csv' | 'geojson') => void
}

/** FRP in MW: 1 decimal under 100, integer above. */
const fmtMw = (frp: number) => (frp < 100 ? frp.toFixed(1) : Math.round(frp).toString())

const fmtUtcHm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const NoData = () => <p className="px-1 font-mono text-[11px] text-slate-600">no data</p>

/** Inner sections — shared by the desktop panel and the mobile bottom sheet. */
export function StatsContent({ stats, newSince, onJumpTo, onExport }: StatsProps) {
  if (!stats) {
    return (
      <Section icon={Flame} title="ACTIVE FIRES">
        <NoData />
      </Section>
    )
  }

  // byRegion arrives sorted desc, so the first row carries the max
  const maxRegion = stats.byRegion.length > 0 ? stats.byRegion[0].count : 0

  return (
    <>
      <Section icon={Flame} title="ACTIVE FIRES">
        <div className="px-1">
          <div className="font-mono text-2xl font-semibold leading-none text-amber-300">
            {stats.shownTotal.toLocaleString()}
          </div>
          <p className="mt-1 text-[10px] text-slate-500">worldwide · filtered</p>
          {stats.inView !== null && (
            <p className="mt-1.5 font-mono text-[11px] text-slate-300">
              {stats.inView.toLocaleString()} <span className="text-slate-500">in view</span>
            </p>
          )}
          {newSince && (
            <span className="mt-2 inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-300">
              +{newSince.count} new since {fmtUtcHm(newSince.sinceIso)}Z
            </span>
          )}
        </div>
      </Section>

      <Section icon={Globe2} title="BY REGION">
        {stats.byRegion.length === 0 ? (
          <NoData />
        ) : (
          <div className="space-y-1.5 px-1">
            {stats.byRegion.slice(0, 7).map((r) => (
              <div key={r.name}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[10px] text-slate-400">{r.name}</span>
                  <span className="font-mono text-[10px] text-slate-300">{r.count.toLocaleString()}</span>
                </div>
                <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-700 to-amber-400"
                    style={{ width: `${Math.max(2, (r.count / maxRegion) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section icon={Zap} title="TOP FIRES (FRP)">
        {stats.topFrp.length === 0 ? (
          <NoData />
        ) : (
          stats.topFrp.map((t, rank) => (
            <button
              key={t.index}
              type="button"
              onClick={() => onJumpTo(t)}
              title="Jump to this fire"
              className="flex w-full items-baseline gap-2 rounded px-1 py-1 text-left hover:bg-white/5"
            >
              <span className="w-3 shrink-0 font-mono text-[10px] text-slate-600">{rank + 1}</span>
              <span className="flex-1 font-mono text-[11px] text-amber-300">
                {fmtMw(t.frp)} <span className="text-[9px] text-amber-500/70">MW</span>
              </span>
              <span className="font-mono text-[10px] text-slate-500">
                {t.lat.toFixed(1)}, {t.lon.toFixed(1)}
              </span>
            </button>
          ))
        )}
      </Section>

      <Section icon={Download} title="EXPORT VIEW">
        <div className="flex gap-2 px-1">
          {(['csv', 'geojson'] as const).map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => onExport(format)}
              title={`Download the detections currently in view as ${format.toUpperCase()}`}
              className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-300 transition-colors hover:border-amber-500/40 hover:text-amber-300"
            >
              {format}
            </button>
          ))}
        </div>
        <p className="mt-1.5 px-1 text-[9px] leading-snug text-slate-600">
          filtered detections in the current viewport
        </p>
      </Section>
    </>
  )
}

/** Desktop shell (≥lg): positioned glass panel, collapsible via store.statsOpen. */
export function StatsPanel(props: StatsProps) {
  const statsOpen = useEmber((s) => s.statsOpen)

  if (!statsOpen) {
    return (
      <button
        type="button"
        onClick={() => setEmber({ statsOpen: true })}
        title="Open stats"
        className={`absolute right-4 top-[4.5rem] z-10 hidden h-10 w-10 items-center justify-center text-slate-300 transition-colors hover:text-amber-300 lg:flex ${glass}`}
      >
        <BarChart3 className="h-4 w-4" />
      </button>
    )
  }

  return (
    <aside
      className={`absolute right-4 top-[4.5rem] z-10 hidden max-h-[calc(100%-13rem)] w-60 flex-col lg:flex ${glass}`}
    >
      <header className="flex items-center justify-between px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em] text-slate-400">
          <BarChart3 className="h-3 w-3" /> LIVE STATS
        </span>
        <button
          type="button"
          onClick={() => setEmber({ statsOpen: false })}
          title="Collapse"
          className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <StatsContent {...props} />
      </div>
    </aside>
  )
}
