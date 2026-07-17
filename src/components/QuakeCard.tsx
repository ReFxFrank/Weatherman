import { Activity, ArrowDownToLine, CalendarDays, Crosshair, ExternalLink, MapPin, Users, Waves, X } from 'lucide-react'
import { quakeColor } from '../lib/quakeLayers'
import type { Quake } from '../lib/types'
import { glass } from './ui'

/**
 * Detail card for a clicked earthquake (§5.5 idiom): magnitude, depth,
 * location, origin time, tsunami flag, and felt-report count, with the USGS
 * event page link. App resolves the selection id against the current payload,
 * so a quake that ages out of the 24 h window closes its own card.
 */

/** USGS magnitudes span several scales; label the band without overclaiming. */
function magBand(mag: number): string {
  if (mag < 2) return 'micro · rarely felt'
  if (mag < 4) return 'minor · often felt locally'
  if (mag < 5) return 'light · felt widely'
  if (mag < 6) return 'moderate · can damage'
  if (mag < 7) return 'strong · damaging'
  if (mag < 8) return 'major · serious damage'
  return 'great · catastrophic'
}

export function QuakeCard({
  quake,
  onClose,
  className = 'w-72',
}: {
  quake: Quake
  onClose: () => void
  className?: string
}) {
  const [r, g, b] = quakeColor(quake.mag)
  const color = `rgb(${r},${g},${b})`
  const t = quake.time > 0 ? new Date(quake.time) : null
  const ageMin = t ? (Date.now() - t.getTime()) / 60_000 : null

  return (
    <aside className={`${className} border-orange-500/25 ${glass}`}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <h2
          className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em]"
          style={{ color }}
        >
          <Activity className="h-3.5 w-3.5" /> EARTHQUAKE
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
        <div className="font-mono text-2xl font-semibold leading-none" style={{ color }}>
          M{quake.mag.toFixed(1)}
        </div>
        <p className="mt-0.5 text-[10px] text-slate-500">{magBand(quake.mag)}</p>

        <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
            <span className="leading-snug">{quake.place}</span>
          </div>
          {quake.depthKm !== null && (
            <div className="flex items-center gap-2">
              <ArrowDownToLine className="h-3 w-3 shrink-0 text-slate-600" />
              {quake.depthKm.toFixed(0)} km deep
              <span className="text-[10px] text-slate-600">
                {quake.depthKm < 70 ? 'shallow' : quake.depthKm < 300 ? 'intermediate' : 'deep'}
              </span>
            </div>
          )}
          {t && (
            <div className="flex items-start gap-2">
              <CalendarDays className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
              <div>
                <div>{t.toISOString().slice(0, 16).replace('T', ' ')}Z</div>
                <div className="text-[10px] text-slate-500">
                  {t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} local
                  {ageMin !== null &&
                    ` · ${ageMin < 60 ? `${Math.round(ageMin)} min` : `${(ageMin / 60).toFixed(1)} h`} ago`}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
            {Math.abs(quake.lat).toFixed(2)}°{quake.lat >= 0 ? 'N' : 'S'},{' '}
            {Math.abs(quake.lon).toFixed(2)}°{quake.lon >= 0 ? 'E' : 'W'}
          </div>
          {quake.felt !== null && quake.felt > 0 && (
            <div className="flex items-center gap-2">
              <Users className="h-3 w-3 shrink-0 text-slate-600" />
              {quake.felt.toLocaleString()} felt {quake.felt === 1 ? 'report' : 'reports'}
              <span className="text-[10px] text-slate-600">DYFI</span>
            </div>
          )}
          {quake.tsunami && (
            <div className="flex items-center gap-2 text-sky-300">
              <Waves className="h-3 w-3 shrink-0" />
              flagged for tsunami assessment (NOAA)
            </div>
          )}
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-2">
          <span className="text-[9px] text-slate-600">
            {quake.type !== 'earthquake' ? `${quake.type} · ` : ''}USGS
          </span>
          {quake.url && (
            <a
              href={quake.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[10px] text-orange-300/90 hover:text-orange-200"
            >
              <ExternalLink className="h-3 w-3" />
              USGS event
            </a>
          )}
        </div>
      </div>
    </aside>
  )
}
