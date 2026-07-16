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
export function deriveRenderAttributes(d: DecodedFire, stride = 1): FireData {
  const n = stride > 1 ? Math.ceil(d.count / stride) : d.count

  const positions = stride > 1 ? new Float32Array(n * 2) : d.positions
  const frp = stride > 1 ? new Float32Array(n) : d.frp
  const tsSec = stride > 1 ? new Uint32Array(n) : d.tsSec
  const bright = stride > 1 ? new Float32Array(n) : d.bright
  const conf = stride > 1 ? new Uint8Array(n) : d.conf
  const night = stride > 1 ? new Uint8Array(n) : d.night
  if (stride > 1) {
    // Stride sampling keeps global coverage (FIRMS rows are orbit-ordered, so
    // taking the first N would bias one hemisphere).
    for (let i = 0, j = 0; j < n; i += stride, j++) {
      positions[j * 2] = d.positions[i * 2]
      positions[j * 2 + 1] = d.positions[i * 2 + 1]
      frp[j] = d.frp[i]
      tsSec[j] = d.tsSec[i]
      bright[j] = d.bright[i]
      conf[j] = d.conf[i]
      night[j] = d.night[i]
    }
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

  return { meta: d.meta, count: n, positions, frp, tsSec, bright, conf, night, colors, radii, filterValues }
}
