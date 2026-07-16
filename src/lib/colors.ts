/**
 * Ember intensity ramp (§6), driven by FRP in megawatts:
 * deep red → orange-red → amber → hot yellow → white-hot core.
 */
export type RGB = [number, number, number]

/** Exported for the legend (Phase 4) — keep in sync with frpColor below. */
export const FRP_STOPS: Array<{ frp: number; color: RGB }> = [
  { frp: 0, color: [148, 32, 30] }, // deep red (floor lifted slightly for additive-on-black visibility)
  { frp: 3, color: [220, 38, 38] }, // #dc2626 orange-red
  { frp: 15, color: [245, 158, 11] }, // #f59e0b amber
  { frp: 60, color: [253, 224, 71] }, // #fde047 hot yellow
  { frp: 250, color: [255, 247, 237] }, // #fff7ed white-hot
]

export function frpColor(frp: number): RGB {
  if (frp <= FRP_STOPS[0].frp) return FRP_STOPS[0].color
  for (let i = 1; i < FRP_STOPS.length; i++) {
    if (frp <= FRP_STOPS[i].frp) {
      const a = FRP_STOPS[i - 1]
      const b = FRP_STOPS[i]
      const t = (frp - a.frp) / (b.frp - a.frp)
      return [
        Math.round(a.color[0] + (b.color[0] - a.color[0]) * t),
        Math.round(a.color[1] + (b.color[1] - a.color[1]) * t),
        Math.round(a.color[2] + (b.color[2] - a.color[2]) * t),
      ]
    }
  }
  return FRP_STOPS[FRP_STOPS.length - 1].color
}

/** Point radius in meters by FRP — sublinear so megafires don't swallow the map. */
export function frpRadiusMeters(frp: number): number {
  return 340 + Math.min(3800, Math.sqrt(Math.max(frp, 0)) * 115)
}
