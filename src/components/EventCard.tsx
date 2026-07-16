import { CalendarDays, ExternalLink, Crosshair, X, Scan } from 'lucide-react'
import type { EonetEvent } from '../lib/types'
import { setEmber, useEmber } from '../store'
import { glass } from './ui'

/**
 * Compact detail card for a clicked EONET named event (§5.5) — title, date,
 * reported size, and the originating agency links. Grows into the full
 * detail-card system in Phase 4.
 */
export function EventCard({ events }: { events: EonetEvent[] | undefined }) {
  const id = useEmber((s) => s.selectedEventId)
  const ev = events?.find((e) => e.id === id)
  if (!ev) return null

  const date = new Date(ev.date)
  const [lon, lat] = ev.coordinates

  return (
    <aside className={`absolute bottom-8 right-4 z-10 w-72 ${glass}`}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <h2 className="text-[13px] font-semibold leading-snug text-sky-100">{ev.title}</h2>
        <button
          type="button"
          onClick={() => setEmber({ selectedEventId: null })}
          title="Close"
          className="mt-0.5 rounded p-0.5 text-slate-500 hover:bg-white/5 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="space-y-1.5 px-4 pb-3 pt-2 font-mono text-[11px] text-slate-400">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-3 w-3 text-slate-600" />
          {date.toISOString().slice(0, 16).replace('T', ' ')}Z
        </div>
        <div className="flex items-center gap-2">
          <Crosshair className="h-3 w-3 text-slate-600" />
          {lat.toFixed(3)}°, {lon.toFixed(3)}°
        </div>
        {ev.magnitudeValue !== null && (
          <div className="flex items-center gap-2">
            <Scan className="h-3 w-3 text-slate-600" />
            {ev.magnitudeValue.toLocaleString()} {ev.magnitudeUnit ?? ''}
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-white/5 pt-2">
          {ev.sources.map((s) => (
            <a
              key={s.id}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-sky-300/90 hover:text-sky-200"
            >
              <ExternalLink className="h-3 w-3" />
              {s.id}
            </a>
          ))}
          <a
            href={ev.link}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-slate-500 hover:text-slate-300"
          >
            <ExternalLink className="h-3 w-3" />
            EONET
          </a>
        </div>
      </div>
    </aside>
  )
}
