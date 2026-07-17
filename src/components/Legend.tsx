import { FRP_STOPS } from '../lib/colors'
import { lightningColor } from '../lib/lightningBinary'
import type { GlobeId } from '../store'

/**
 * Map legend (§5.6): per-globe — the FRP ember ramp + marker key for fires,
 * the energy ramp + coverage honesty for lightning. Unpositioned — the
 * caller supplies placement (and glass) via className.
 */

const MAX_STOP = FRP_STOPS[FRP_STOPS.length - 1].frp // 250
const pct = (frp: number) => (Math.log10(frp + 1) / Math.log10(MAX_STOP + 1)) * 100

const RAMP_GRADIENT = `linear-gradient(90deg, ${FRP_STOPS.map(
  (s) => `rgb(${s.color[0]},${s.color[1]},${s.color[2]}) ${pct(s.frp).toFixed(1)}%`,
).join(', ')})`

const LIGHTNING_GRADIENT = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1]
  .map((t) => {
    const [r, g, b] = lightningColor(Math.pow(10, t * 3.5))
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)}) ${t * 100}%`
  })
  .join(', ')})`

function LightningLegend() {
  return (
    <>
      <div className="h-2 rounded-sm" style={{ background: LIGHTNING_GRADIENT }} />
      <div className="mt-0.5 flex justify-between font-mono text-[9px] text-slate-500">
        <span>faint</span>
        <span>strong</span>
      </div>
      <p className="mb-2 text-[9px] text-slate-600">flash optical energy · log scale</p>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2.5">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{
              background: 'radial-gradient(circle, #ffffff 0%, #7dd3fc 55%, transparent 75%)',
              boxShadow: '0 0 6px rgba(125,211,252,0.9)',
            }}
          />
          <span className="text-[10px] text-slate-400">flash · sized &amp; colored by energy</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span
            className="h-3 w-3 shrink-0 rounded-full opacity-80"
            style={{ background: '#bae6fd', filter: 'blur(3px)' }}
          />
          <span className="text-[10px] text-slate-400">bloom · struck in the last 3 min</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="h-0 w-3.5 shrink-0 border-t border-dashed border-sky-300/50" />
          <span className="text-[10px] text-slate-400">≈ GOES satellite field of view</span>
        </div>
        <p className="text-[9px] leading-snug text-slate-600">
          GOES GLM sees the Americas &amp; adjacent oceans — outside the rings means no
          coverage, not no lightning. Strikes fade over 60 min.
        </p>
      </div>
    </>
  )
}

export function Legend({ className = 'w-60', globe = 'fire' }: { className?: string; globe?: GlobeId }) {
  if (globe === 'lightning') {
    return (
      <div className={`${className} px-4 py-3`}>
        <h3 className="mb-2 text-[10px] font-semibold tracking-[0.18em] text-slate-500">LEGEND</h3>
        <LightningLegend />
      </div>
    )
  }
  return (
    <div className={`${className} px-4 py-3`}>
      <h3 className="mb-2 text-[10px] font-semibold tracking-[0.18em] text-slate-500">LEGEND</h3>

      <div className="h-2 rounded-sm" style={{ background: RAMP_GRADIENT }} />
      <div className="relative mt-0.5 h-3 font-mono text-[9px] text-slate-500">
        {FRP_STOPS.map((s, i) => (
          <span
            key={s.frp}
            className="absolute -translate-x-1/2"
            style={{ left: `${Math.min(96, Math.max(2, pct(s.frp)))}%` }}
          >
            {i === FRP_STOPS.length - 1 ? `${s.frp}+` : s.frp}
          </span>
        ))}
      </div>
      <p className="mb-2 text-[9px] text-slate-600">fire radiative power · MW</p>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2.5">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{
              background: 'radial-gradient(circle, #fff7ed 0%, #f59e0b 55%, transparent 75%)',
              boxShadow: '0 0 6px rgba(245,158,11,0.9)',
            }}
          />
          <span className="text-[10px] text-slate-400">fire detection · sized by FRP</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span
            className="h-3 w-3 shrink-0 rounded-full opacity-80"
            style={{ background: '#f59e0b', filter: 'blur(3px)' }}
          />
          <span className="text-[10px] text-slate-400">heat field · density at low zoom</span>
        </div>
        <div className="flex items-center gap-2.5">
          <svg width="14" height="14" viewBox="0 0 64 64" className="shrink-0" aria-hidden>
            <circle cx="32" cy="32" r="21" fill="none" stroke="#a5e3ff" strokeWidth="5" />
            <line x1="32" y1="2" x2="32" y2="16" stroke="#a5e3ff" strokeWidth="5" />
            <line x1="32" y1="48" x2="32" y2="62" stroke="#a5e3ff" strokeWidth="5" />
            <line x1="2" y1="32" x2="16" y2="32" stroke="#a5e3ff" strokeWidth="5" />
            <line x1="48" y1="32" x2="62" y2="32" stroke="#a5e3ff" strokeWidth="5" />
            <circle cx="32" cy="32" r="6" fill="#e8f7ff" />
          </svg>
          <span className="text-[10px] text-slate-400">named event · NASA EONET</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-3.5 shrink-0 rounded-sm border border-slate-500/40 bg-[#020617]/70" />
          <span className="text-[10px] text-slate-400">night side · real-time terminator</span>
        </div>
      </div>
    </div>
  )
}
