import type {
  DecodedLightning,
  LightningBinaryHeader,
  LightningBinarySection,
  LightningData,
} from './types'
import { SPLAT_LIFT_M } from './binary'

/**
 * Decode the GLM lightning payload (server/glm.ts wire format — same
 * conventions as the fire payload: u32 header length + JSON header +
 * 4-byte-aligned typed-array sections).
 */
export function decodeLightningBinary(buf: ArrayBuffer): DecodedLightning {
  const view = new DataView(buf)
  const headerLen = view.getUint32(0, true)
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  ) as LightningBinaryHeader

  const section = (name: LightningBinarySection['name']) => {
    const s = header.sections.find((x) => x.name === name)
    if (!s) throw new Error(`lightning payload missing section ${name}`)
    return s
  }
  const at = (s: LightningBinarySection) => header.dataOffset + s.offset

  const { dataOffset: _o, sections: _s, ...meta } = header
  const pos = section('positions')
  return {
    meta,
    count: header.count,
    positions: new Float32Array(buf, at(pos), header.count * pos.size),
    energy: new Float32Array(buf, at(section('energy')), header.count),
    tsSec: new Uint32Array(buf, at(section('tsSec')), header.count),
    sat: new Uint8Array(buf, at(section('sat')), header.count),
  }
}

/**
 * Electric color ramp by flash optical energy (log scale, femtojoules):
 * faint flashes are a deep violet-blue, strong ones burn to white — cold
 * light against the fire globe's warm ember ramp.
 */
export function lightningColor(energyFJ: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, Math.log10(Math.max(energyFJ, 1)) / 3.5))
  if (t < 0.5) {
    const k = t / 0.5
    return [96 + (150 - 96) * k, 110 + (200 - 110) * k, 255]
  }
  const k = (t - 0.5) / 0.5
  return [150 + (255 - 150) * k, 200 + (255 - 200) * k, 255]
}

/** Energy-scaled splat radius, meters (a GLM pixel is ~8–14 km; stay under it). */
export function lightningRadiusMeters(energyFJ: number): number {
  const t = Math.min(1, Math.max(0, Math.log10(Math.max(energyFJ, 1)) / 3.5))
  return 350 + 1100 * t
}

/**
 * Precompute per-flash render attributes once per payload. Age-based fading
 * is baked into the alpha channel at derive time — the payload refreshes
 * every ~60 s, so the bake is never more than a minute behind the clock
 * (invisible on a 60-minute decay curve). The GPU filter handles the sharp
 * edges: the sliding window cutoff and the fresh-strike bloom.
 */
export function deriveLightningAttributes(d: DecodedLightning): LightningData {
  const n = d.count
  const positionsLifted = new Float32Array(n * 3)
  const colors = new Uint8Array(n * 4)
  const radii = new Float32Array(n)
  const filterValues = new Float32Array(n * 3)

  const fetchSec = Math.floor(Date.parse(d.meta.fetchedAt) / 1000) || Math.floor(Date.now() / 1000)
  const windowMin = d.meta.windowMin || 60

  for (let i = 0; i < n; i++) {
    positionsLifted[i * 3] = d.positions[i * 2]
    positionsLifted[i * 3 + 1] = d.positions[i * 2 + 1]
    positionsLifted[i * 3 + 2] = SPLAT_LIFT_M

    const e = d.energy[i]
    const [r, g, b] = lightningColor(e)
    const ageMin = Math.max(0, (fetchSec - d.tsSec[i]) / 60)
    // old strikes dim toward (but never fully to) darkness — storm history
    // stays readable while fresh cells clearly outshine it
    const fade = Math.pow(Math.max(0, 1 - ageMin / windowMin), 1.3)
    colors[i * 4] = r
    colors[i * 4 + 1] = g
    colors[i * 4 + 2] = b
    colors[i * 4 + 3] = Math.round(255 * (0.25 + 0.75 * fade))

    radii[i] = lightningRadiusMeters(e)
    filterValues[i * 3] = ageMin
    filterValues[i * 3 + 1] = e
    filterValues[i * 3 + 2] = d.sat[i]
  }

  return { ...d, positionsLifted, colors, radii, filterValues }
}
