import { CalendarDays, Crosshair, Gauge, Navigation, Shell, Waypoints, Wind, X } from 'lucide-react'
import { intensityColor } from '../lib/hurricaneLayers'
import type { ActiveStorm, ForecastPointProps, GlobalStorm } from '../lib/types'
import { glass } from './ui'

/**
 * Detail card for a clicked hurricanes-globe feature: an NHC storm head
 * (current intensity, pressure, movement, advisory), an EONET global storm
 * (track history only — no intensity data exists for it, and the card says
 * so), or an NHC forecast point (predicted intensity at a lead time).
 * App resolves store selections against the current payload — a dissipated
 * storm's card disappears with its head.
 */

export type ResolvedHurricaneSelection =
  | { type: 'storm'; storm: ActiveStorm }
  | { type: 'global'; storm: GlobalStorm }
  | { type: 'forecast'; props: ForecastPointProps }

/** NHC classification codes → words (raw code shown when unknown). */
const CLASSIFICATIONS: Record<string, string> = {
  TD: 'TROPICAL DEPRESSION',
  TS: 'TROPICAL STORM',
  HU: 'HURRICANE',
  MH: 'MAJOR HURRICANE',
  PTC: 'POTENTIAL TROPICAL CYCLONE',
  STD: 'SUBTROPICAL DEPRESSION',
  STS: 'SUBTROPICAL STORM',
  PC: 'POST-TROPICAL CYCLONE',
  TY: 'TYPHOON',
}

/** kt → Saffir-Simpson label (same boundaries as the layer colors). Only
 *  meaningful for actual tropical cyclones — see isTropical. */
function categoryLabel(kt: number): string {
  if (kt < 34) return 'tropical depression'
  if (kt < 64) return 'tropical storm'
  if (kt < 83) return 'category 1'
  if (kt < 96) return 'category 2'
  if (kt < 113) return 'category 3'
  if (kt < 137) return 'category 4'
  return 'category 5'
}

/** The Saffir-Simpson scale applies only to tropical cyclones. Subtropical
 *  (STD/STS), potential (PTC) and post-tropical (PC) systems get their type
 *  from the title, not a category label the wind speed alone would imply. */
const TROPICAL = new Set(['TD', 'TS', 'HU', 'MH', 'TY'])

const ktToMph = (kt: number) => Math.round(kt * 1.15078)

/** Upstream date strings (NHC lastUpdate, EONET dates) are trusted-but-real:
 *  a malformed one must not throw `new Date(...).toISOString()` and white-
 *  screen the whole app (there is no error boundary). Returns null on junk. */
function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]

const fmtPos = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`

function CardShell({
  title,
  titleColor,
  border,
  onClose,
  className,
  children,
}: {
  title: string
  titleColor?: string
  border: string
  onClose: () => void
  className: string
  children: React.ReactNode
}) {
  return (
    <aside className={`${className} ${border} ${glass}`}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <h2
          className="flex items-center gap-1.5 text-[10px] font-semibold leading-snug tracking-[0.2em]"
          style={titleColor ? { color: titleColor } : undefined}
        >
          <Shell className="h-3.5 w-3.5 shrink-0" /> {title}
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
      <div className="px-4 pb-3 pt-2">{children}</div>
    </aside>
  )
}

export function HurricaneCard({
  selection,
  onClose,
  className = 'w-72',
}: {
  selection: ResolvedHurricaneSelection
  onClose: () => void
  className?: string
}) {
  if (selection.type === 'storm') {
    const s = selection.storm
    const color = intensityColor(s.intensityKt)
    const cls = CLASSIFICATIONS[s.classification] ?? s.classification
    const updatedAt = parseDate(s.lastUpdate)
    // append the Saffir-Simpson category phrase only for tropical systems;
    // the title already carries the type for subtropical/post-tropical/PTC
    const category = TROPICAL.has(s.classification) ? ` · ${categoryLabel(s.intensityKt)}` : ''
    return (
      <CardShell
        title={`${cls} ${s.name.toUpperCase()}`}
        titleColor={color}
        border="border-violet-500/25"
        onClose={onClose}
        className={className}
      >
        <div className="font-mono text-2xl font-semibold leading-none" style={{ color }}>
          {s.intensityKt} <span className="text-sm opacity-70">kt</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-500">
          max sustained wind · ≈{ktToMph(s.intensityKt)} mph{category}
        </p>
        <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
          <div className="flex items-center gap-2">
            <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
            {fmtPos(s.lat, s.lon)}
          </div>
          {s.pressureMb !== null && (
            <div className="flex items-center gap-2">
              <Gauge className="h-3 w-3 shrink-0 text-slate-600" />
              {s.pressureMb} mb <span className="text-[10px] text-slate-600">central pressure</span>
            </div>
          )}
          {s.movementDir !== null && s.movementSpeedKt !== null && (
            <div className="flex items-center gap-2">
              <Navigation className="h-3 w-3 shrink-0 text-slate-600" />
              {compass(s.movementDir)} at {s.movementSpeedKt} kt
            </div>
          )}
          <div className="flex items-center gap-2">
            <CalendarDays className="h-3 w-3 shrink-0 text-slate-600" />
            {s.advisoryNum ? `advisory #${s.advisoryNum}` : 'advisory'}
            {updatedAt ? ` · ${updatedAt.toISOString().slice(11, 16)}Z` : ''}
          </div>
        </div>
        <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-snug text-slate-600">
          NOAA NHC advisory data. The cone is the probable path of the storm center — hazards
          routinely reach outside it.
        </p>
      </CardShell>
    )
  }

  if (selection.type === 'global') {
    const g = selection.storm
    const last = g.track[g.track.length - 1]
    const lastAt = parseDate(g.lastDate)
    return (
      <CardShell
        title={g.title.toUpperCase()}
        titleColor="#7dd3fc"
        border="border-sky-500/25"
        onClose={onClose}
        className={className}
      >
        <div className="space-y-1.5 font-mono text-[11px] text-slate-400">
          {last && (
            <div className="flex items-center gap-2">
              <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
              {fmtPos(last[1], last[0])}
            </div>
          )}
          <div className="flex items-center gap-2">
            <CalendarDays className="h-3 w-3 shrink-0 text-slate-600" />
            last position{' '}
            {lastAt ? `${lastAt.toISOString().slice(0, 16).replace('T', ' ')}Z` : 'unknown'}
          </div>
          <div className="flex items-center gap-2">
            <Waypoints className="h-3 w-3 shrink-0 text-slate-600" />
            {g.track.length} track points
          </div>
        </div>
        <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-snug text-slate-600">
          NASA EONET event outside NHC&apos;s basins — track history only; EONET carries no
          intensity, pressure, or forecast data.
        </p>
      </CardShell>
    )
  }

  const p = selection.props
  const kt = p.maxwind
  const cat =
    p.ssnum !== null && p.ssnum >= 1
      ? `category ${p.ssnum}`
      : kt !== null
        ? categoryLabel(kt)
        : null
  const color = kt !== null ? intensityColor(kt) : '#c4b5fd'
  return (
    <CardShell
      title={`FORECAST${p.stormname ? ` · ${p.stormname.toUpperCase()}` : ''}`}
      titleColor="#c4b5fd"
      border="border-violet-500/25"
      onClose={onClose}
      className={className}
    >
      {kt !== null && (
        <>
          <div className="font-mono text-2xl font-semibold leading-none" style={{ color }}>
            {kt} <span className="text-sm opacity-70">kt</span>
          </div>
          <p className="mt-0.5 text-[10px] text-slate-500">
            predicted max wind · ≈{ktToMph(kt)} mph{cat ? ` · ${cat}` : ''}
          </p>
        </>
      )}
      <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
        {(p.datelbl || p.tau !== null) && (
          <div className="flex items-center gap-2">
            <CalendarDays className="h-3 w-3 shrink-0 text-slate-600" />
            {p.datelbl ?? 'forecast'}
            {p.tau !== null && <span className="text-[10px] text-slate-600">+{p.tau} h</span>}
          </div>
        )}
        {p.gust !== null && (
          <div className="flex items-center gap-2">
            <Wind className="h-3 w-3 shrink-0 text-slate-600" />
            {p.gust} kt <span className="text-[10px] text-slate-600">gusts</span>
          </div>
        )}
        {p.mslp !== null && (
          <div className="flex items-center gap-2">
            <Gauge className="h-3 w-3 shrink-0 text-slate-600" />
            {p.mslp} mb <span className="text-[10px] text-slate-600">pressure</span>
          </div>
        )}
        {p.advisnum && (
          <div className="flex items-center gap-2">
            <Waypoints className="h-3 w-3 shrink-0 text-slate-600" />
            advisory #{p.advisnum}
          </div>
        )}
      </div>
      <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-snug text-slate-600">
        NHC forecast position — uncertainty grows with lead time; the cone spans the center&apos;s
        probable paths.
      </p>
    </CardShell>
  )
}
