import { Flame, Zap } from 'lucide-react'
import { setEmber, useEmber, type GlobeId } from '../store'

/**
 * The mission-control channel selector (Phase 6): flips which data globe is
 * on screen. The shell — camera, starfield, terminator, search — stays put;
 * the data layers, HUD readout, and legend swap.
 */

const GLOBES: Array<{
  id: GlobeId
  label: string
  Icon: typeof Flame
  onCls: string
}> = [
  {
    id: 'fire',
    label: 'FIRES',
    Icon: Flame,
    onCls: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  },
  {
    id: 'lightning',
    label: 'LIGHTNING',
    Icon: Zap,
    onCls: 'border-sky-400/40 bg-sky-400/15 text-sky-300',
  },
]

export function GlobeSwitcher({ className = '' }: { className?: string }) {
  const globe = useEmber((s) => s.globe)
  return (
    <div className={`flex gap-1 ${className}`} role="tablist" aria-label="Data globe">
      {GLOBES.map(({ id, label, Icon, onCls }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={globe === id}
          onClick={() => setEmber({ globe: id })}
          className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium tracking-widest transition-colors ${
            globe === id
              ? onCls
              : 'border-slate-700/60 bg-slate-800/30 text-slate-500 hover:text-slate-300'
          }`}
        >
          <Icon className="h-3 w-3" strokeWidth={2.5} />
          {label}
        </button>
      ))}
    </div>
  )
}
