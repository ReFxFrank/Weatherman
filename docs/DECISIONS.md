# Decisions log

Resolutions for every `TODO(frank)` in the brief (§9), made during Phase 0.
Each one is a default Frank can override — the "to change it" note says what moves.

## 1. FIRMS `MAP_KEY` — ⚠️ needs Frank, app works without it meanwhile

Registering a key requires an email signup a human must complete
(<https://firms.modaps.eosdis.nasa.gov/api/map_key/>), so it could not be resolved
autonomously. **Mitigation shipped:** the proxy falls back to FIRMS's *public keyless
global active-fire feeds* — the same live VIIRS/MODIS detections, limited to
world-coverage files in 24h / 48h / 7d windows. Phase 0's "live data, not mocked"
acceptance is met today (187k+ real detections at time of writing).

**To change it:** put the key in `.env` as `FIRMS_MAP_KEY=…`. The proxy switches to
the full area API automatically (all 5 sources incl. LANDSAT, true 1–10 day windows,
regional bbox queries, quota endpoint). No code changes needed.

## 2. Path A vs B → **Path A** (production proxy)

Per the brief's recommendation. Hono app in `server/index.ts` running on Node
(`@hono/node-server`) with: key held server-side, 10-min in-memory cache,
single-flight request dedup, stale-on-error fallback, CSV→columnar-JSON conversion
(binary typed arrays land in Phase 1). Hono is portable, so the eventual deploy
target (see #6) doesn't change the code meaningfully.

## 3. Basemap → **CARTO dark-matter** (zero-key)

`https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json`, re-tinted at
runtime toward the §6 deep-navy palette (background `#0d1322`, water near-black).
OpenFreeMap is the drop-in alternative if CARTO's usage terms become a concern;
MapTiler (free key) can be added later for a satellite style option.
Attribution kept via MapLibre's control (required by CARTO/OSM).

## 4. Geocoder → **deferred to Phase 4**

Search is not needed for the Phase 0–3 core. Recommendation when it lands:
**Photon (komoot)** or Nominatim — both free, no key, fine with debounced usage.
If neither is acceptable, search gets cut from v1 per the brief's escape hatch.

## 5. Brand & accent → **"Ember"**, ember-warm accent

Name from the brief. Accent follows the brief's default: warm ember tones for fire
data *and* active chrome (LIVE badge, counts), neutral cool glass for panels.
**To change it:** the ReFx-blue-chrome variant is a Tailwind token swap —
say the word and chrome goes blue with warm tones reserved strictly for fire.

## 6. Deploy target → **undecided, kept portable**

Proxy is plain Hono, so all three candidates work: Vercel function, CF Pages+Workers
(cache moves to edge KV), or a VPS Node service. Recommendation: decide by Phase 4;
Vercel is the least-friction default for a Vite SPA + one API route.

## 7. Bloom: splat glow instead of `PostProcessEffect` (Phase 1)

The brief specifies both **interleaved** deck.gl rendering (§2) and a
**`PostProcessEffect` bloom pass** (§5.7). These turn out to be mutually
exclusive: in interleaved mode deck draws into MapLibre's own framebuffer
mid-frame (`_customRender`), so there is no separate deck framebuffer for a
screen-space post-process to read. Verified empirically — and `HeatmapLayer`'s
aggregation passes fail to bind in interleaved mode too (`weightsTexture`
warning, nothing renders).

Resolution, favoring the specified architecture (interleaved is also what makes
far-side-of-globe occlusion correct):

- **Bloom look** = per-point additive light splats: a core pass plus up to two
  halo passes (High: 2, Balanced: 1, Performance: 0). Dense clusters sum on the
  GPU into blooming, bleeding light — same visual mechanism as screen bloom,
  cheaper, and globe-safe.
- **Heat tier** = the same splats drawn wide/faint at low zoom (a GPU
  kernel-density heatmap), cross-faded into discrete points across the §5.1
  swap band instead of a `HeatmapLayer`.

**To change it:** an overlaid (non-interleaved) `MapboxOverlay` would enable a
true screen-space `PostProcessEffect` at the cost of depth-correct globe
occlusion; say the word and it can be built as a High-tier variant.

## 8. Binary wire format (Phase 1)

`/api/hotspots` returns `uint32 header-length + JSON header + 4-byte-aligned
typed-array sections` (positions f32×2, frp f32, tsSec u32, bright f32, conf u8,
night u8). 4.1 MB vs 9.1 MB as JSON for 187k points, zero client-side parsing —
buffers go straight into deck.gl as binary attributes. `?format=json` remains
for debugging.

## Other notes

- **React 18** pinned per the brief (not 19).
- deck.gl mounts through `MapboxOverlay` in **interleaved** mode over MapLibre's
  globe projection (deck.gl ≥ 9.1 supports this pairing).
- Splats keep the map's depth **test** at globe zooms (far-side occlusion) and
  release it past zoom 4.5, where large billboard quads would otherwise clip
  into the curved surface ("crescent" artifact); depth **write** stays off so
  translucent splats never mask each other.
- Quality tiers (§8): High / Balanced / Performance scale glow passes, heat-field
  kernel size and point decimation (stride sampling to keep global coverage).
  Auto-detected from the WebGL renderer string (software rasterizers →
  Performance, discrete/Apple GPUs → High, else Balanced), overridable via
  `?quality=` or `localStorage['ember-quality']`; panel UI lands in Phase 2.
- Dev/test URL params: `?quality=` `?stride=` `?lat=&lon=&z=` (camera jump, skips
  entrance) `?debug=1` (fps + render counts in the HUD).
- Confidence normalization: VIIRS `l/n/h` *and* the public feeds' `low/nominal/high`
  words *and* MODIS numeric (`<30` → low, `30–79` → nominal, `≥80` → high) all map
  to one internal 0/1/2 scale.
- Public-feed CSVs lack the `instrument` column; the payload carries what both
  modes share. Per-point detail beyond that (satellite string, scan/track) joins
  the payload in Phase 4 when detail cards need it.
- Fire perimeters (§3.3): **deferred** per the brief's own recommendation — stretch
  only, revisit at Phase 5.
