import { CalendarDays, CloudHail, Crosshair, MapPin, Tornado, TriangleAlert, Wind, X } from 'lucide-react'
import type { SevereKind, SevereSelection } from '../lib/types'
import { glass } from './ui'

/**
 * Detail card for a clicked severe-globe feature: an NWS warning/watch
 * polygon (headline, area, onset→expiry countdown) or an SPC storm report
 * (magnitude as reported, location, time). Same card idiom as
 * HotspotCard/EventCard; App validates the selection (expired alerts drop
 * their card just like their polygons drop off the map).
 */

const ALERT_STYLE: Record<SevereKind, { accent: string; border: string }> = {
  'tornado-warning': { accent: 'text-red-300', border: 'border-red-500/30' },
  'severe-warning': { accent: 'text-amber-300', border: 'border-amber-500/30' },
  'tornado-watch': { accent: 'text-red-200/90', border: 'border-red-400/20' },
  'severe-watch': { accent: 'text-amber-200/90', border: 'border-amber-400/20' },
}

const REPORT_STYLE = {
  torn: { title: 'TORNADO REPORT', accent: 'text-red-300', border: 'border-red-500/30', Icon: Tornado },
  wind: { title: 'WIND REPORT', accent: 'text-blue-300', border: 'border-blue-500/30', Icon: Wind },
  hail: { title: 'HAIL REPORT', accent: 'text-slate-200', border: 'border-slate-400/30', Icon: CloudHail },
} as const

/** ISO (with any offset) → "HH:MMZ · HH:MM local". */
function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toISOString().slice(11, 16)}Z · ${d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })} local`
}

/** SPC magnitudes as reported: EF-scale / mph / hundredths of an inch —
 *  "UNK"/empty stays honest instead of casting to a fake zero. */
function magReadout(rtype: 'torn' | 'wind' | 'hail', mag: string): string {
  const n = mag.trim() === '' ? NaN : Number(mag)
  if (rtype === 'torn') return Number.isFinite(n) ? `EF${n}` : 'rating pending'
  if (rtype === 'wind') return Number.isFinite(n) ? `${n} mph` : 'speed unreported'
  return Number.isFinite(n) ? `${(n / 100).toFixed(2)} in` : 'size unreported'
}

/** SPC report times are HHMM UTC. */
const fmtSpcTime = (t: string) => (/^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}Z` : t)

export function SevereCard({
  selection,
  onClose,
  className = 'w-72',
}: {
  selection: SevereSelection
  onClose: () => void
  className?: string
}) {
  if (selection.type === 'report') {
    const { rtype, report } = selection
    const style = REPORT_STYLE[rtype]
    return (
      <aside className={`${className} ${style.border} ${glass}`}>
        <header className="flex items-start justify-between gap-2 px-4 pt-3">
          <h2 className={`flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em] ${style.accent}`}>
            <style.Icon className="h-3.5 w-3.5" /> {style.title}
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
          <div className={`font-mono text-2xl font-semibold leading-none ${style.accent}`}>
            {magReadout(rtype, report.mag)}
          </div>
          <p className="mt-0.5 text-[10px] text-slate-500">as reported to SPC</p>
          <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
            <div className="flex items-center gap-2">
              <MapPin className="h-3 w-3 shrink-0 text-slate-600" />
              {report.location}
              {report.state ? `, ${report.state}` : ''}
            </div>
            <div className="flex items-center gap-2">
              <CalendarDays className="h-3 w-3 shrink-0 text-slate-600" />
              reported {fmtSpcTime(report.time)}
            </div>
            <div className="flex items-center gap-2">
              <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
              {Math.abs(report.lat).toFixed(2)}°{report.lat >= 0 ? 'N' : 'S'},{' '}
              {Math.abs(report.lon).toFixed(2)}°{report.lon >= 0 ? 'E' : 'W'}
            </div>
          </div>
          <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-snug text-slate-600">
            SPC preliminary local storm report — today&apos;s file resets at 12Z.
          </p>
        </div>
      </aside>
    )
  }

  const { props } = selection
  const style = ALERT_STYLE[props.kind]
  const isWatch = props.kind.endsWith('watch')
  const minsLeft = props.expires ? Math.round((Date.parse(props.expires) - Date.now()) / 60_000) : null

  return (
    <aside className={`${className} ${style.border} ${glass}`}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <h2 className={`flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em] ${style.accent}`}>
          <TriangleAlert className="h-3.5 w-3.5" /> {props.event.toUpperCase()}
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
        {minsLeft !== null && (
          <>
            <div className={`font-mono text-2xl font-semibold leading-none ${style.accent}`}>
              {minsLeft >= 120 ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m` : `${minsLeft} min`}
            </div>
            <p className="mt-0.5 text-[10px] text-slate-500">until this {isWatch ? 'watch' : 'warning'} expires</p>
          </>
        )}
        <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
            <span className="leading-snug">{props.areaDesc}</span>
          </div>
          {props.onset && (
            <div className="flex items-center gap-2">
              <CalendarDays className="h-3 w-3 shrink-0 text-slate-600" />
              from {fmtWhen(props.onset)}
            </div>
          )}
          {props.expires && (
            <div className="flex items-center gap-2">
              <CalendarDays className="h-3 w-3 shrink-0 text-slate-600" />
              until {fmtWhen(props.expires)}
            </div>
          )}
          {props.severity && (
            <div className="flex items-center gap-2">
              <TriangleAlert className="h-3 w-3 shrink-0 text-slate-600" />
              <span className={`rounded border px-1.5 py-px text-[10px] ${style.border} ${style.accent}`}>
                {props.severity.toUpperCase()}
              </span>
              <span className="text-[10px] text-slate-600">NWS severity</span>
            </div>
          )}
        </div>
        <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-snug text-slate-600">
          {isWatch
            ? 'A watch means conditions are favorable — a warning means it is happening. Zone-based shape; the storm may cover only part of it.'
            : 'NWS storm-based warning polygon — the hazard is inside this shape now or imminently.'}
        </p>
      </div>
    </aside>
  )
}
