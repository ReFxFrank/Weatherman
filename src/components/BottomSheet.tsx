import { BarChart3, Info, SlidersHorizontal, X, type LucideIcon } from 'lucide-react'
import type { FireStats } from '../lib/stats'
import { setEmber, useEmber, type EmberState } from '../store'
import { DisplayContent, FilterContent } from './FilterPanel'
import { Legend } from './Legend'
import { StatsContent } from './StatsPanel'
import { glass } from './ui'

type SheetTab = NonNullable<EmberState['sheet']>

/**
 * Mobile chrome (§5.6): the desktop side panels dock into a bottom sheet,
 * opened from two floating buttons. Hidden ≥lg. Tabs are per-globe: the fire
 * globe gets its Filters/Stats panels; every other globe gets the shared
 * Display controls and its Legend — previously unreachable on mobile, which
 * hid the coverage-honesty copy the legends carry (review finding).
 */
export function BottomSheet({
  eventsCount,
  stats,
  newSince,
  onJumpTo,
  onExport,
  hasMtg,
}: {
  eventsCount?: number
  stats: FireStats | null
  newSince: { count: number; sinceIso: string } | null
  onJumpTo: (t: { index: number; lon: number; lat: number }) => void
  onExport: (format: 'csv' | 'geojson') => void
  /** Meteosat present in the lightning payload (legend copy differs) */
  hasMtg?: boolean
}) {
  const sheet = useEmber((s) => s.sheet)
  const globe = useEmber((s) => s.globe)

  const tabs: Array<{ key: SheetTab; label: string; icon: LucideIcon }> =
    globe === 'fire'
      ? [
          { key: 'filters', label: 'Filters & layers', icon: SlidersHorizontal },
          { key: 'stats', label: 'Statistics', icon: BarChart3 },
        ]
      : [
          { key: 'display', label: 'Display', icon: SlidersHorizontal },
          { key: 'legend', label: 'Legend', icon: Info },
        ]

  return (
    <div className="lg:hidden">
      {!sheet && (
        <div className="absolute bottom-28 left-3 z-20 flex flex-col gap-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setEmber({ sheet: t.key })}
              title={t.label}
              className={`flex h-11 w-11 items-center justify-center text-slate-200 ${glass}`}
            >
              <t.icon className="h-4.5 w-4.5" />
            </button>
          ))}
        </div>
      )}

      {sheet && (
        <>
          <div
            className="absolute inset-0 z-20 bg-black/45"
            onClick={() => setEmber({ sheet: null })}
            aria-hidden
          />
          <div
            className={`absolute inset-x-0 bottom-0 z-30 flex max-h-[70%] flex-col rounded-t-2xl border-b-0 ${glass}`}
          >
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/15" aria-hidden />
            <header className="flex items-center gap-2 px-3 py-2">
              <div className="flex flex-1 overflow-hidden rounded-md border border-white/10 bg-black/30">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setEmber({ sheet: t.key })}
                    className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-medium ${
                      sheet === t.key
                        ? 'bg-amber-500/15 text-amber-300'
                        : 'text-slate-400 hover:bg-white/5'
                    }`}
                  >
                    <t.icon className="h-3.5 w-3.5" />
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setEmber({ sheet: null })}
                title="Close"
                className="rounded p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto pb-[max(env(safe-area-inset-bottom),0.75rem)]">
              {sheet === 'filters' ? (
                <FilterContent eventsCount={eventsCount} />
              ) : sheet === 'stats' ? (
                <StatsContent stats={stats} newSince={newSince} onJumpTo={onJumpTo} onExport={onExport} />
              ) : sheet === 'display' ? (
                <DisplayContent />
              ) : (
                <Legend globe={globe} hasMtg={hasMtg} className="" />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
