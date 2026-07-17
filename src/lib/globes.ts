import { Flame, Tornado, Zap, type LucideIcon } from 'lucide-react'

/**
 * THE globe registry — the single source of truth for which data globes
 * exist (framework hardening, Phase 8). `GlobeId` derives from this list, so
 * every `Record<GlobeId, …>` dispatch table in the app (HUD, chips, legend,
 * readiness) fails to COMPILE when a globe is added here without its entry —
 * the per-globe branch sprawl that produced the missed-footer and
 * missed-debug-HUD bugs cannot silently recur.
 *
 * Adding a globe: add its entry here, then follow the type errors.
 */

export interface GlobeDef {
  id: string
  /** switcher tab text */
  label: string
  Icon: LucideIcon
  /** switcher active-state classes (per-globe accent) */
  activeCls: string
  /** name used in the "ACQUIRING … FEED" HUD state */
  feedName: string
  /** §10 attribution footer fragment (every rendered dataset gets credited) */
  attribution: string
}

export const GLOBE_DEFS = [
  {
    id: 'fire',
    label: 'FIRES',
    Icon: Flame,
    activeCls: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
    feedName: 'SATELLITE FEED',
    attribution: 'Active fire data: NASA FIRMS (MODIS/VIIRS)',
  },
  {
    id: 'lightning',
    label: 'LIGHTNING',
    Icon: Zap,
    activeCls: 'border-sky-400/40 bg-sky-400/15 text-sky-300',
    feedName: 'LIGHTNING FEED',
    attribution: 'Lightning: NOAA GOES GLM + EUMETSAT MTG-LI',
  },
  {
    id: 'severe',
    label: 'TORNADO',
    Icon: Tornado,
    activeCls: 'border-red-400/40 bg-red-400/15 text-red-300',
    feedName: 'NWS/SPC FEED',
    attribution: 'Severe weather: NOAA NWS/SPC',
  },
] as const satisfies readonly GlobeDef[]

export type GlobeId = (typeof GLOBE_DEFS)[number]['id']

export const GLOBES: Record<GlobeId, (typeof GLOBE_DEFS)[number]> = Object.fromEntries(
  GLOBE_DEFS.map((d) => [d.id, d]),
) as Record<GlobeId, (typeof GLOBE_DEFS)[number]>

export function isGlobeId(x: string | null | undefined): x is GlobeId {
  return GLOBE_DEFS.some((d) => d.id === x)
}

/** datasets rendered on every globe (shell layers) */
export const SHARED_ATTRIBUTION =
  'Named events: NASA EONET · Boundaries: Natural Earth · US perimeters: NIFC'
