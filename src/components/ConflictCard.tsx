import { CalendarDays, Crosshair, ExternalLink, MapPin, Newspaper, ShieldCheck, Skull, Swords, X } from 'lucide-react'
import { conflictTypeColor } from '../lib/conflictLayers'
import type { ConflictEvent, NewsEvent } from '../lib/types'
import { glass } from './ui'

/**
 * Detail card for a clicked conflict feature. Two epistemically different
 * shapes, styled to keep them from being confused:
 *  - a VERIFIED UCDP event (fatal, coded by analysts, ~1-month lag), or
 *  - an UNVERIFIED GDELT news mention (machine-coded, last 15 min).
 * The card says which it is, plainly.
 */

const VIOLENCE: Record<number, string> = {
  1: 'state-based conflict',
  2: 'non-state conflict',
  3: 'one-sided violence (civilians)',
}

export function ConflictCard({
  selection,
  onClose,
  className = 'w-72',
}: {
  selection: { kind: 'ucdp'; event: ConflictEvent } | { kind: 'news'; event: NewsEvent }
  onClose: () => void
  className?: string
}) {
  if (selection.kind === 'ucdp') {
    const e = selection.event
    const [r, g, b] = conflictTypeColor(e.type)
    const color = `rgb(${r},${g},${b})`
    return (
      <aside className={`${className} border-rose-500/25 ${glass}`}>
        <header className="flex items-start justify-between gap-2 px-4 pt-3">
          <h2 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em]" style={{ color }}>
            <Swords className="h-3.5 w-3.5" /> CONFLICT EVENT
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
          <div className="flex items-baseline gap-1.5 font-mono text-2xl font-semibold leading-none" style={{ color }}>
            <Skull className="h-5 w-5" />
            {e.deaths.toLocaleString()}
          </div>
          <p className="mt-0.5 text-[10px] text-slate-500">
            best estimate of deaths · {VIOLENCE[e.type] ?? 'organized violence'}
          </p>
          <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
            <div className="flex items-center gap-2">
              <MapPin className="h-3 w-3 shrink-0 text-slate-600" />
              {e.country || 'unknown'}
            </div>
            <div className="flex items-center gap-2">
              <CalendarDays className="h-3 w-3 shrink-0 text-slate-600" />
              {e.date}
            </div>
            <div className="flex items-center gap-2">
              <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
              {Math.abs(e.lat).toFixed(2)}°{e.lat >= 0 ? 'N' : 'S'}, {Math.abs(e.lon).toFixed(2)}°
              {e.lon >= 0 ? 'E' : 'W'}
              {e.wherePrec >= 4 && <span className="text-[10px] text-slate-600">approx.</span>}
            </div>
            <div className="flex items-center gap-2 text-emerald-300/90">
              <ShieldCheck className="h-3 w-3 shrink-0" />
              verified · UCDP
            </div>
          </div>
          <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-snug text-slate-600">
            Analyst-verified event of organized violence (≥1 death), coded by the Uppsala Conflict
            Data Program (GED-Candidate, CC BY 4.0). Updated monthly with a ~1-month lag.
          </p>
        </div>
      </aside>
    )
  }

  const e = selection.event
  let host = ''
  try {
    host = e.url ? new URL(e.url).host.replace(/^www\./, '') : ''
  } catch {
    host = ''
  }
  return (
    <aside className={`${className} border-sky-500/25 ${glass}`}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <h2 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em] text-sky-300">
          <Newspaper className="h-3.5 w-3.5" /> CONFLICT NEWS
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
        <p className="text-[13px] font-semibold leading-snug text-sky-100">{e.place || 'unknown location'}</p>
        <div className="mt-2 space-y-1.5 font-mono text-[11px] text-slate-400">
          <div className="flex items-center gap-2">
            <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
            {Math.abs(e.lat).toFixed(2)}°{e.lat >= 0 ? 'N' : 'S'}, {Math.abs(e.lon).toFixed(2)}°
            {e.lon >= 0 ? 'E' : 'W'}
          </div>
          <div className="flex items-center gap-2">
            <Newspaper className="h-3 w-3 shrink-0 text-slate-600" />
            coverage tone {e.tone.toFixed(1)}
          </div>
          {host && (
            <a
              href={e.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-sky-300/90 hover:text-sky-200"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              {host}
            </a>
          )}
        </div>
        <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-snug text-slate-600">
          UNVERIFIED — a machine-coded conflict-related news event (GDELT, last 15 min). The point
          marks where news is written ABOUT a place, algorithmically geolocated; it is not a
          confirmed event. Source: The GDELT Project.
        </p>
      </div>
    </aside>
  )
}
