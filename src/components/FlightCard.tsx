import {
  ArrowDown,
  ArrowUp,
  Building2,
  Crosshair,
  Gauge,
  Plane,
  Radio,
  ShieldAlert,
  Signal,
  TowerControl,
  TriangleAlert,
  X,
} from 'lucide-react'
import { altColor } from '../lib/flightLayers'
import type { Aircraft, AircraftPhoto, FlightRoute } from '../lib/types'
import { glass } from './ui'

/**
 * ADSBExchange-style detail card for a clicked aircraft: altitude + vertical
 * rate, speeds (ground / indicated / Mach), heading, squawk, operator, type /
 * registration / year, emitter category, and ICAO hex — everything the ADS-B
 * broadcast carries. Emergency (7500/7600/7700 or an ADS-B emergency flag)
 * and military aircraft get a banner/badge. Route/airline schedule is NOT in
 * open ADS-B, so it is honestly absent. App resolves the selection hex against
 * the live snapshot, so a plane that leaves the view closes its own card.
 */

/** ADS-B emitter category → short label. */
const CATEGORY: Record<string, string> = {
  A1: 'light',
  A2: 'small',
  A3: 'large',
  A4: 'large (high-wake)',
  A5: 'heavy',
  A6: 'high-performance',
  A7: 'rotorcraft',
  B1: 'glider',
  B2: 'lighter-than-air',
  B4: 'ultralight',
  B6: 'UAV',
  B7: 'spacecraft',
  C1: 'surface vehicle',
  C2: 'surface vehicle',
}

const EMERGENCY_LABEL: Record<string, string> = {
  general: 'general emergency',
  lifeguard: 'lifeguard / medical',
  minfuel: 'minimum fuel',
  nordo: 'radio failure',
  unlawful: 'unlawful interference',
  downed: 'aircraft downed',
}

const SQUAWK_LABEL: Record<string, string> = {
  '7500': 'hijack',
  '7600': 'radio failure',
  '7700': 'general emergency',
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]

export function FlightCard({
  aircraft,
  route = null,
  photo = null,
  onClose,
  className = 'w-72',
}: {
  aircraft: Aircraft
  route?: FlightRoute | null
  photo?: AircraftPhoto | null
  onClose: () => void
  className?: string
}) {
  const [r, g, b] = altColor(aircraft.altFt, aircraft.onGround, aircraft.isEmergency)
  const color = `rgb(${r},${g},${b})`
  const title = aircraft.flight || aircraft.reg || aircraft.hex.toUpperCase()
  const vr = aircraft.baroRateFpm
  const climbing = vr !== null && vr > 100
  const descending = vr !== null && vr < -100
  const emergencyText =
    aircraft.emergency && aircraft.emergency !== 'none'
      ? EMERGENCY_LABEL[aircraft.emergency] ?? aircraft.emergency
      : SQUAWK_LABEL[aircraft.squawk]

  return (
    <aside className={`${className} ${aircraft.isEmergency ? 'border-red-500/40' : 'border-indigo-500/25'} ${glass}`}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <h2 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em]" style={{ color }}>
          <Plane className="h-3.5 w-3.5" /> {title}
          {aircraft.military && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[8px] tracking-normal text-amber-300">
              MIL
            </span>
          )}
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
        {photo?.thumb && (
          <a
            href={photo.link || undefined}
            target="_blank"
            rel="noreferrer"
            className="mb-2 block overflow-hidden rounded-md border border-white/10"
            title="View on Planespotters"
          >
            <img
              src={photo.thumb}
              alt={`${aircraft.reg || aircraft.type || 'aircraft'} photo`}
              className="h-28 w-full object-cover"
              loading="lazy"
            />
            <span className="block bg-black/40 px-2 py-0.5 text-[8px] text-slate-400">
              © {photo.photographer || 'unknown'} · Planespotters · photo of {aircraft.reg || 'this reg'}
            </span>
          </a>
        )}
        {aircraft.isEmergency && (
          <div className="mb-2 flex items-center gap-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
            <ShieldAlert className="h-3 w-3 shrink-0" />
            EMERGENCY{emergencyText ? ` · ${emergencyText}` : ''}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="font-mono text-2xl font-semibold leading-none" style={{ color }}>
            {aircraft.onGround
              ? 'on ground'
              : aircraft.altFt !== null
                ? `${aircraft.altFt.toLocaleString()} ft`
                : 'alt n/a'}
          </div>
          {(climbing || descending) && (
            <span className={`mb-0.5 flex items-center gap-0.5 text-[11px] ${climbing ? 'text-emerald-300' : 'text-sky-300'}`}>
              {climbing ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {Math.abs(Math.round(vr as number)).toLocaleString()} fpm
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[10px] text-slate-500">
          {aircraft.desc || aircraft.type || 'aircraft'}
          {aircraft.category && CATEGORY[aircraft.category] ? ` · ${CATEGORY[aircraft.category]}` : ''}
        </p>

        {route && (
          <div className="mt-2">
            <div className="flex items-center gap-1.5 rounded border border-indigo-500/20 bg-indigo-500/5 px-2 py-1 font-mono text-[11px]">
              <span className="font-semibold text-indigo-200">{route.origin.iata || route.origin.icao || '???'}</span>
              <Plane className="h-3 w-3 shrink-0 rotate-90 text-indigo-300" />
              <span className="font-semibold text-indigo-200">
                {route.destination.iata || route.destination.icao || '???'}
              </span>
              {route.airline && (
                <span className="truncate text-[10px] text-slate-500"> · {route.airline}</span>
              )}
            </div>
            <p className="mt-0.5 px-1 text-[9px] text-slate-600">
              scheduled route (adsbdb) — estimated from the callsign, not the ADS-B path
            </p>
          </div>
        )}

        <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
          {aircraft.gsKt !== null && (
            <div className="flex items-center gap-2">
              <Gauge className="h-3 w-3 shrink-0 text-slate-600" />
              {Math.round(aircraft.gsKt)} kt gs
              {aircraft.iasKt !== null && <span className="text-slate-500">{Math.round(aircraft.iasKt)} ias</span>}
              {aircraft.mach !== null && aircraft.mach > 0.1 && (
                <span className="text-slate-500">M{aircraft.mach.toFixed(2)}</span>
              )}
            </div>
          )}
          {aircraft.track !== null && (
            <div className="flex items-center gap-2">
              <Plane className="h-3 w-3 shrink-0 -rotate-45 text-slate-600" />
              heading {Math.round(aircraft.track)}° {compass(aircraft.track)}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
            {Math.abs(aircraft.lat).toFixed(2)}°{aircraft.lat >= 0 ? 'N' : 'S'},{' '}
            {Math.abs(aircraft.lon).toFixed(2)}°{aircraft.lon >= 0 ? 'E' : 'W'}
          </div>
          {aircraft.squawk && (
            <div className="flex items-center gap-2">
              <TriangleAlert className="h-3 w-3 shrink-0 text-slate-600" />
              squawk <span className={aircraft.isEmergency ? 'text-red-300' : ''}>{aircraft.squawk}</span>
            </div>
          )}
          {aircraft.operator && (
            <div className="flex items-center gap-2">
              <Building2 className="h-3 w-3 shrink-0 text-slate-600" />
              <span className="truncate">{aircraft.operator}</span>
            </div>
          )}
          {(aircraft.reg || aircraft.type) && (
            <div className="flex items-center gap-2">
              <TowerControl className="h-3 w-3 shrink-0 text-slate-600" />
              {aircraft.reg || '—'}
              {aircraft.type ? <span className="text-slate-500">{aircraft.type}</span> : null}
              {aircraft.year ? <span className="text-slate-600">{aircraft.year}</span> : null}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Radio className="h-3 w-3 shrink-0 text-slate-600" />
            {aircraft.hex.toUpperCase()}
            {aircraft.seenSec !== null && aircraft.seenSec > 2 && (
              <span className="flex items-center gap-1 text-slate-600">
                <Signal className="h-3 w-3" />
                {Math.round(aircraft.seenSec)}s ago
              </span>
            )}
          </div>
        </div>

        <p className="mt-2 border-t border-white/5 pt-2 text-[9px] leading-snug text-slate-600">
          Position/altitude/speed are live ADS-B via airplanes.live (community receivers), ~seconds
          old. The route/airline and photo are NOT from ADS-B — the route is a scheduled lookup
          (adsbdb), the photo a library shot of the registration (Planespotters).
        </p>
      </div>
    </aside>
  )
}
