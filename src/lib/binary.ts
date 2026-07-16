import type { BinaryHeader, BinarySection, DecodedFire, FireData } from './types'
import { frpColor, frpRadiusMeters } from './colors'

/**
 * Decode the proxy's binary payload (see server/index.ts wire format) into
 * typed-array columns — no JSON.parse over megabytes, no per-row objects.
 */
export function decodeFireBinary(buf: ArrayBuffer): DecodedFire {
  const view = new DataView(buf)
  const headerLen = view.getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as BinaryHeader

  const at = (s: BinarySection) => header.dataOffset + s.offset
  const section = (name: BinarySection['name']) => {
    const s = header.sections.find((x) => x.name === name)
    if (!s) throw new Error(`payload missing section ${name}`)
    return s
  }
  const f32 = (name: BinarySection['name']) => {
    const s = section(name)
    return new Float32Array(buf, at(s), header.count * s.size)
  }

  const { dataOffset: _dataOffset, sections: _sections, ...meta } = header
  return {
    meta,
    count: header.count,
    positions: f32('positions'),
    frp: f32('frp'),
    tsSec: new Uint32Array(buf, at(section('tsSec')), header.count),
    bright: f32('bright'),
    conf: new Uint8Array(buf, at(section('conf')), header.count),
    night: new Uint8Array(buf, at(section('night')), header.count),
  }
}

/**
 * Precompute per-point render attributes (RGBA, radius, GPU filter values)
 * once per payload + quality tier, so deck.gl uploads ready-made buffers
 * instead of calling JS accessors 187k times per layer update (§8).
 */
/**
 * Fire splats are lifted slightly off the globe so they never depth-fight the
 * basemap's tile mesh (whose interpolated depth wobbles vs deck's exact
 * projection as the camera moves — visible as per-splat flicker at world
 * zoom). 25 km is 0.4% of Earth's radius: geometrically invisible, but far
 * beyond the mesh error, and far-side points stay correctly occluded.
 */
const SPLAT_LIFT_M = 25_000

export function deriveRenderAttributes(d: DecodedFire, stride = 1): FireData {
  // The hottest fires must never be decimated away: the stats panel's top-5
  // jump-to has to land on a rendered point (review finding), and they're the
  // strongest visual anchors. Reserve slots to re-add them after striding.
  const TOP_KEEP = 64
  const base = stride > 1 ? Math.ceil(d.count / stride) : d.count
  const cap = base + (stride > 1 ? TOP_KEEP : 0)

  const positions = new Float32Array(cap * 3)
  const frp = stride > 1 ? new Float32Array(cap) : d.frp
  const tsSec = stride > 1 ? new Uint32Array(cap) : d.tsSec
  const bright = stride > 1 ? new Float32Array(cap) : d.bright
  const conf = stride > 1 ? new Uint8Array(cap) : d.conf
  const night = stride > 1 ? new Uint8Array(cap) : d.night
  let n = base
  if (stride === 1) {
    for (let i = 0; i < base; i++) {
      positions[i * 3] = d.positions[i * 2]
      positions[i * 3 + 1] = d.positions[i * 2 + 1]
      positions[i * 3 + 2] = SPLAT_LIFT_M
    }
  }
  if (stride > 1) {
    // Stride sampling keeps global coverage (FIRMS rows are orbit-ordered, so
    // taking the first N would bias one hemisphere).
    let j = 0
    for (let i = 0; j < base; i += stride, j++) {
      positions[j * 3] = d.positions[i * 2]
      positions[j * 3 + 1] = d.positions[i * 2 + 1]
      positions[j * 3 + 2] = SPLAT_LIFT_M
      frp[j] = d.frp[i]
      tsSec[j] = d.tsSec[i]
      bright[j] = d.bright[i]
      conf[j] = d.conf[i]
      night[j] = d.night[i]
    }
    // Top-K FRP among the rows the stride skipped, via a small insertion pass.
    const top: number[] = []
    for (let i = 0; i < d.count; i++) {
      if (i % stride === 0) continue
      const f = d.frp[i]
      if (top.length >= TOP_KEEP && f <= d.frp[top[top.length - 1]]) continue
      let k = top.length < TOP_KEEP ? top.length : TOP_KEEP - 1
      while (k > 0 && f > d.frp[top[k - 1]]) k--
      top.splice(k, 0, i)
      if (top.length > TOP_KEEP) top.pop()
    }
    for (const i of top) {
      positions[j * 3] = d.positions[i * 2]
      positions[j * 3 + 1] = d.positions[i * 2 + 1]
      positions[j * 3 + 2] = SPLAT_LIFT_M
      frp[j] = d.frp[i]
      tsSec[j] = d.tsSec[i]
      bright[j] = d.bright[i]
      conf[j] = d.conf[i]
      night[j] = d.night[i]
      j++
    }
    n = j
  }

  const colors = new Uint8Array(n * 4)
  const radii = new Float32Array(n)
  const filterValues = new Float32Array(n * 4)
  // Age is relative to the payload's fetch time — stable per dataset, so the
  // GPU buffer never needs rebuilding as wall-clock time passes.
  const fetchSec = Math.floor(Date.parse(d.meta.fetchedAt) / 1000) || Math.floor(Date.now() / 1000)
  for (let i = 0; i < n; i++) {
    const [r, g, b] = frpColor(frp[i])
    colors[i * 4] = r
    colors[i * 4 + 1] = g
    colors[i * 4 + 2] = b
    colors[i * 4 + 3] = 255
    radii[i] = frpRadiusMeters(frp[i])
    filterValues[i * 4] = frp[i]
    filterValues[i * 4 + 1] = conf[i]
    filterValues[i * 4 + 2] = night[i]
    filterValues[i * 4 + 3] = Math.max(0, (fetchSec - tsSec[i]) / 86400)
  }

  // Trim over-allocation (cap may exceed the rows actually written).
  return {
    meta: d.meta,
    count: n,
    positions: positions.length === n * 3 ? positions : positions.subarray(0, n * 3),
    frp: frp.length === n ? frp : frp.subarray(0, n),
    tsSec: tsSec.length === n ? tsSec : tsSec.subarray(0, n),
    bright: bright.length === n ? bright : bright.subarray(0, n),
    conf: conf.length === n ? conf : conf.subarray(0, n),
    night: night.length === n ? night : night.subarray(0, n),
    colors,
    radii,
    filterValues,
  }
}
