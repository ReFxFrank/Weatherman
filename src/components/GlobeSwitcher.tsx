import { GLOBE_DEFS } from '../lib/globes'
import { setEmber, useEmber } from '../store'

/**
 * The mission-control channel selector: flips which data globe is on screen.
 * Tabs render straight from the globe registry (src/lib/globes) — adding a
 * globe there adds its tab here with no edits.
 */
export function GlobeSwitcher({ className = '' }: { className?: string }) {
  const globe = useEmber((s) => s.globe)
  return (
    <div className={`flex flex-wrap gap-1 ${className}`} role="tablist" aria-label="Data globe">
      {GLOBE_DEFS.map(({ id, label, Icon, activeCls }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={globe === id}
          // no-op on the active tab: setEmber({globe}) clears selections,
          // which a redundant click must not do (review finding)
          onClick={() => globe !== id && setEmber({ globe: id })}
          className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium tracking-widest transition-colors ${
            globe === id
              ? activeCls
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
