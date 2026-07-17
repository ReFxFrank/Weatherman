import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft,
  Flame,
  Gauge,
  Layers,
  Lock,
  Moon,
  Satellite,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Globe as GlobeIcon,
} from 'lucide-react'
import { fetchHealth } from '../lib/api'
import type { QualityTier } from '../lib/quality'
import { detectQualityTier } from '../lib/quality'
import { SOURCES, setEmber, useEmber } from '../store'
import { glass, RadioRow, Section, Segmented, Toggle } from './ui'

/** FRP slider: 0 = off, 1–100 maps log-scale onto 1–500 MW. */
const sliderToFrp = (v: number) => (v <= 0 ? 0 : Math.pow(10, (v / 100) * Math.log10(500)))
const frpToSlider = (frp: number) => (frp <= 0 ? 0 : Math.round((Math.log10(frp) / Math.log10(500)) * 100))
const fmtFrp = (frp: number) => (frp >= 10 ? Math.round(frp).toString() : frp.toFixed(1))

const AUTO_TIER = detectQualityTier()

/** Inner sections — shared by the desktop panel and the mobile bottom sheet. */
export function FilterContent({ eventsCount }: { eventsCount?: number }) {
  const s = useEmber()
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: fetchHealth, staleTime: Infinity })
  const hasKey = health?.hasKey ?? false

  return (
    <>
      <Section icon={Satellite} title="SOURCE">
        {SOURCES.map((src) => {
          const locked = 'needsKey' in src && src.needsKey && !hasKey
          return (
            <RadioRow
              key={src.id}
              checked={s.source === src.id}
              onSelect={() => setEmber({ source: src.id })}
              label={src.label}
              note={src.note}
              disabled={locked}
              trailing={
                locked ? <Lock className="h-3 w-3 text-slate-600" aria-label="needs FIRMS_MAP_KEY" /> : undefined
              }
            />
          )
        })}
        {!hasKey && (
          <p className="mt-1 px-1 text-[10px] leading-snug text-slate-600">
            Landsat needs a FIRMS_MAP_KEY (.env) — public feeds cover the rest.
          </p>
        )}
      </Section>

      <Section icon={Flame} title="INTENSITY">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={frpToSlider(s.frpMin)}
          onChange={(e) => setEmber({ frpMin: sliderToFrp(Number(e.target.value)) })}
          className="w-full accent-amber-500"
          aria-label="Minimum fire radiative power"
        />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
          <span>FRP</span>
          <span className={s.frpMin > 0 ? 'text-amber-300' : ''}>
            {s.frpMin > 0 ? `≥ ${fmtFrp(s.frpMin)} MW` : 'all intensities'}
          </span>
        </div>
      </Section>

      <Section icon={ShieldCheck} title="CONFIDENCE">
        <Segmented
          value={String(s.confMin) as '0' | '1' | '2'}
          onChange={(v) => setEmber({ confMin: Number(v) as 0 | 1 | 2 })}
          options={[
            { value: '0', label: 'All' },
            { value: '1', label: 'Nominal+' },
            { value: '2', label: 'High' },
          ]}
        />
      </Section>

      <Section icon={Sun} title="TIME OF DAY">
        <Segmented
          value={s.dayNight}
          onChange={(dayNight) => setEmber({ dayNight })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'day', label: <Sun className="mx-auto h-3.5 w-3.5" />, title: 'Day detections' },
            { value: 'night', label: <Moon className="mx-auto h-3.5 w-3.5" />, title: 'Night detections' },
          ]}
        />
      </Section>

      <Section icon={Layers} title="LAYERS">
        <Toggle checked={s.showHeat} onChange={(showHeat) => setEmber({ showHeat })} label="Heat field" note="low zoom" />
        <Toggle checked={s.showPoints} onChange={(showPoints) => setEmber({ showPoints })} label="Fire points" note="high zoom" />
        <Toggle
          checked={s.showEvents}
          onChange={(showEvents) => setEmber({ showEvents })}
          label="Named events"
          note={eventsCount !== undefined ? `${eventsCount} open` : 'EONET'}
        />
        <Toggle
          checked={s.showChoropleth}
          onChange={(showChoropleth) => setEmber({ showChoropleth })}
          label="Country counts"
          note="choropleth"
        />
        <Toggle
          checked={s.showPerimeters}
          onChange={(showPerimeters) => setEmber({ showPerimeters })}
          label="US perimeters"
          note="NIFC"
        />
      </Section>

      <DisplayContent />
    </>
  )
}

/**
 * Shell-level display controls (projection, basemap, night shade, quality) —
 * shared by every globe: rendered inside the fire globe's filter panel and
 * standalone (DisplayPanel) on the other globes, where these controls were
 * previously unreachable (review finding).
 */
export function DisplayContent() {
  const s = useEmber()
  return (
    <>
      <Section icon={GlobeIcon} title="VIEW">
        <Segmented
          value={s.projection}
          onChange={(projection) => setEmber({ projection })}
          options={[
            { value: 'globe', label: 'Globe' },
            { value: 'mercator', label: 'Flat' },
          ]}
        />
        <div className="mt-2">
          <Segmented
            value={s.basemap}
            onChange={(basemap) => setEmber({ basemap })}
            options={[
              { value: 'dark', label: 'Labels' },
              { value: 'dark-nolabels', label: 'No labels' },
            ]}
          />
        </div>
        <div className="mt-2">
          <Toggle
            checked={s.showTerminator}
            onChange={(showTerminator) => setEmber({ showTerminator })}
            label="Night shade"
            note="real-time"
          />
        </div>
      </Section>

      <Section icon={Gauge} title="QUALITY">
        <Segmented
          value={s.quality}
          onChange={(quality) => setEmber({ quality })}
          options={(['high', 'balanced', 'performance'] as QualityTier[]).map((tier) => ({
            value: tier,
            label: tier === 'performance' ? 'Perf' : tier[0].toUpperCase() + tier.slice(1),
            title: tier === AUTO_TIER ? 'auto-detected for this GPU' : undefined,
          }))}
        />
        <p className="mt-1.5 px-1 font-mono text-[10px] text-slate-600">
          auto: {AUTO_TIER}
          {s.quality !== AUTO_TIER ? ' · overridden' : ''}
        </p>
      </Section>
    </>
  )
}

/** Slim desktop shell for the non-fire globes: just the shared display
 *  controls, same rail position as the fire filter panel. */
export function DisplayPanel() {
  const panelOpen = useEmber((s) => s.panelOpen)

  if (!panelOpen) {
    return (
      <button
        type="button"
        onClick={() => setEmber({ panelOpen: true })}
        title="Open display settings"
        className={`absolute left-4 top-28 z-10 hidden h-10 w-10 items-center justify-center text-slate-300 transition-colors hover:text-amber-300 lg:flex ${glass}`}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
    )
  }

  return (
    <aside
      className={`absolute left-4 top-28 z-10 hidden max-h-[calc(100%-8.5rem)] w-60 flex-col lg:flex ${glass}`}
    >
      <header className="flex items-center justify-between px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em] text-slate-400">
          <SlidersHorizontal className="h-3 w-3" /> DISPLAY
        </span>
        <button
          type="button"
          onClick={() => setEmber({ panelOpen: false })}
          title="Collapse"
          className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <DisplayContent />
      </div>
    </aside>
  )
}

/** Desktop shell (≥lg): positioned glass panel, collapsible. */
export function FilterPanel({ eventsCount }: { eventsCount?: number }) {
  const panelOpen = useEmber((s) => s.panelOpen)

  if (!panelOpen) {
    return (
      <button
        type="button"
        onClick={() => setEmber({ panelOpen: true })}
        title="Open filters"
        className={`absolute left-4 top-28 z-10 hidden h-10 w-10 items-center justify-center text-slate-300 transition-colors hover:text-amber-300 lg:flex ${glass}`}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
    )
  }

  return (
    <aside
      className={`absolute left-4 top-28 z-10 hidden max-h-[calc(100%-8.5rem)] w-60 flex-col lg:flex ${glass}`}
    >
      <header className="flex items-center justify-between px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.2em] text-slate-400">
          <SlidersHorizontal className="h-3 w-3" /> FILTERS & LAYERS
        </span>
        <button
          type="button"
          onClick={() => setEmber({ panelOpen: false })}
          title="Collapse"
          className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <FilterContent eventsCount={eventsCount} />
      </div>
    </aside>
  )
}
