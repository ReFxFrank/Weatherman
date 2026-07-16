import {
  CalendarDays,
  Crosshair,
  Flame,
  Moon,
  Satellite,
  ShieldCheck,
  Sun,
  Thermometer,
  X,
} from 'lucide-react'
import type { DecodedFire } from '../lib/types'
import { SOURCES } from '../store'
import { glass } from './ui'

/**
 * Detail card for a clicked fire detection (§5.5): FRP, coordinates,
 * acquisition time (UTC + local), brightness, confidence, day/night, source.
 */

const CONF = [
  { label: 'LOW', cls: 'text-slate-400 border-slate-500/30 bg-slate-500/10' },
  { label: 'NOMINAL', cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
  { label: 'HIGH', cls: 'text-red-300 border-red-500/30 bg-red-500/10' },
]

const instrumentOf = (source: string) =>
  source.startsWith('VIIRS') ? 'VIIRS' : source.startsWith('MODIS') ? 'MODIS' : 'OLI'

const fmtMw = (frp: number) => (frp < 100 ? frp.toFixed(1) : Math.round(frp).toLocaleString())

export function HotspotCard({
  data,
  index,
  onClose,
  className = 'w-72',
}: {
  data: DecodedFire
  index: number
  onClose: () => void
  className?: string
}) {
  const lon = data.positions[index * 2]
  const lat = data.positions[index * 2 + 1]
  const frp = data.frp[index]
  const bright = data.bright[index]
  const conf = CONF[Math.min(2, data.conf[index])]
  const isNight = data.night[index] === 1
  const acquired = new Date(data.tsSec[index] * 1000)
  const ageH = (Date.now() - acquired.getTime()) / 3_600_000
  const sourceLabel = SOURCES.find((s) => s.id === data.meta.source)?.label ?? data.meta.source

  return (
    <aside className={`${className} border-amber-500/20 ${glass}`}>
      <header className="flex items-start justify-between gap-2 px-4 pt-3">
        <h2 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em] text-amber-400/90">
          <Flame className="h-3.5 w-3.5" /> FIRE DETECTION
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
        <div className="font-mono text-2xl font-semibold leading-none text-amber-300">
          {fmtMw(frp)} <span className="text-sm text-amber-500/70">MW</span>
        </div>
        <p className="mt-0.5 text-[10px] text-slate-500">fire radiative power</p>

        <div className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
          <div className="flex items-center gap-2">
            <Crosshair className="h-3 w-3 shrink-0 text-slate-600" />
            {Math.abs(lat).toFixed(3)}°{lat >= 0 ? 'N' : 'S'}, {Math.abs(lon).toFixed(3)}°
            {lon >= 0 ? 'E' : 'W'}
          </div>
          <div className="flex items-start gap-2">
            <CalendarDays className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
            <div>
              <div>{acquired.toISOString().slice(0, 16).replace('T', ' ')}Z</div>
              <div className="text-[10px] text-slate-500">
                {acquired.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} local
                {' · '}
                {ageH < 1 ? `${Math.round(ageH * 60)} min ago` : `${ageH.toFixed(1)} h ago`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Thermometer className="h-3 w-3 shrink-0 text-slate-600" />
            {bright.toFixed(1)} K <span className="text-[10px] text-slate-600">brightness</span>
          </div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3 w-3 shrink-0 text-slate-600" />
            <span className={`rounded border px-1.5 py-px text-[10px] ${conf.cls}`}>{conf.label}</span>
            <span className="text-[10px] text-slate-600">confidence</span>
          </div>
          <div className="flex items-center gap-2">
            {isNight ? (
              <Moon className="h-3 w-3 shrink-0 text-slate-600" />
            ) : (
              <Sun className="h-3 w-3 shrink-0 text-slate-600" />
            )}
            {isNight ? 'night pass' : 'day pass'}
          </div>
          <div className="flex items-center gap-2">
            <Satellite className="h-3 w-3 shrink-0 text-slate-600" />
            {sourceLabel} <span className="text-[10px] text-slate-600">{instrumentOf(data.meta.source)}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}
