/**
 * Quality tiers (§8): High / Balanced / Performance scale glow layers, heatmap
 * radius and point decimation. Auto-detected from the GPU renderer string,
 * overridable via ?quality= or localStorage (panel UI arrives in Phase 2).
 */
export type QualityTier = 'high' | 'balanced' | 'performance'

export interface QualityConfig {
  tier: QualityTier
  /** number of additive halo passes around the core point layer (0–2) */
  glowPasses: 0 | 1 | 2
  /** minimum splat size of the low-zoom heat field (kernel radius, px) */
  heatMinPx: number
  /** point decimation stride (1 = all points) */
  stride: number
}

const CONFIGS: Record<QualityTier, QualityConfig> = {
  high: { tier: 'high', glowPasses: 2, heatMinPx: 8, stride: 1 },
  balanced: { tier: 'balanced', glowPasses: 1, heatMinPx: 7, stride: 1 },
  performance: { tier: 'performance', glowPasses: 0, heatMinPx: 5.5, stride: 2 },
}

function gpuRendererString(): string {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!gl) return ''
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = dbg
      ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return renderer ?? ''
  } catch {
    return ''
  }
}

export function detectQualityTier(): QualityTier {
  const param = new URLSearchParams(location.search).get('quality')
  if (param === 'high' || param === 'balanced' || param === 'performance') return param
  const saved = localStorage.getItem('ember-quality')
  if (saved === 'high' || saved === 'balanced' || saved === 'performance') return saved

  const renderer = gpuRendererString().toLowerCase()
  // Software rasterizers can't afford glow overdraw at 187k points.
  if (/swiftshader|llvmpipe|softpipe|software/.test(renderer)) return 'performance'
  const coarse = matchMedia('(pointer: coarse)').matches
  if (coarse) return 'balanced'
  if (/nvidia|geforce|rtx|radeon|apple m\d|apple gpu/.test(renderer)) return 'high'
  // Unknown or integrated GPU: Balanced per §8 ("never ship a High default that stutters").
  return 'balanced'
}

export function qualityConfig(tier: QualityTier = detectQualityTier()): QualityConfig {
  return CONFIGS[tier]
}
