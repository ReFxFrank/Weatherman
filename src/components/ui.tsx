import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/** Shared glass + control primitives for the mission-control chrome (§6). */

export const glass =
  'rounded-lg border border-white/10 bg-[#0a0e1a]/60 backdrop-blur-md shadow-[0_4px_24px_rgba(0,0,0,0.45)]'

export function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="border-t border-white/5 px-4 py-3 first:border-t-0">
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.18em] text-slate-500">
        <Icon className="h-3 w-3" />
        {title}
      </h3>
      {children}
    </section>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-white/10 bg-black/30">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`flex-1 px-2 py-1.5 text-[11px] font-medium transition-colors ${
              active
                ? 'bg-amber-500/15 text-amber-300 shadow-[inset_0_0_12px_rgba(245,158,11,0.12)]'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  note,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  note?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-2 rounded px-1 py-1.5 text-left hover:bg-white/5"
    >
      <span className="text-xs text-slate-300">
        {label}
        {note && <span className="ml-1.5 font-mono text-[10px] text-slate-500">{note}</span>}
      </span>
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-amber-500/50 bg-amber-500/30' : 'border-white/15 bg-black/40'
        }`}
      >
        <span
          className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all ${
            checked ? 'left-3.5 bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.7)]' : 'left-0.5 bg-slate-500'
          }`}
        />
      </span>
    </button>
  )
}

export function RadioRow({
  checked,
  onSelect,
  label,
  note,
  disabled,
  trailing,
}: {
  checked: boolean
  onSelect: () => void
  label: string
  note?: string
  disabled?: boolean
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded px-1 py-1.5 text-left ${
        disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/5'
      }`}
    >
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full border transition-all ${
          checked
            ? 'border-amber-400 bg-amber-400/90 shadow-[0_0_8px_rgba(245,158,11,0.8)]'
            : 'border-slate-600 bg-transparent'
        }`}
      />
      <span className={`flex-1 text-xs ${checked ? 'text-slate-100' : 'text-slate-400'}`}>{label}</span>
      {note && <span className="font-mono text-[10px] text-slate-500">{note}</span>}
      {trailing}
    </button>
  )
}
