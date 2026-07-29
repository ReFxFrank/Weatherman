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

## 6. Deploy target → **GitHub Pages** (baked-static mode), proxy stays portable

Frank asked for GitHub Pages. Pages is static-only, so the proxy's three jobs
(hide the key, cache, CSV→binary) move into a scheduled GitHub Action
(`.github/workflows/pages.yml`) that *bakes* live FIRMS data every 20 minutes
and redeploys it with the app — `scripts/bake-data.ts` reuses the exact
parse/encode pipeline via `server/firms.ts`. The client's `VITE_DATA_MODE=static`
build fetches `/data/hotspots-{source}-{24h|48h|7d}.bin` + `manifest.json`
instead of `/api/*`; EONET stays a direct client call.

Why this works so cleanly here: the app already GPU-trims 24h/48h/7d files to
any 1–10-day window, world queries are the only queries, and the binary format
is host-agnostic. `FIRMS_MAP_KEY` as an Actions secret never reaches the
client (keeps the §4 rule) and unlocks Landsat in the baked feed.

Trade-offs vs the live proxy: freshness is the cron cadence (~20 min + queue
jitter) instead of 10-min on-demand; no regional bbox queries (unused so far);
repo must stay public for free Pages/Actions. The Hono proxy remains fully
supported for Node/Vercel/CF hosting — same wire format, zero client changes
beyond the build flag.

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
- Filters (Phase 2) run through deck.gl's `DataFilterExtension` with a
  `[frp, conf, night]` triplet per point uploaded once — a filter change is a
  GPU uniform update. Verified: filter changes issue zero network requests;
  only source/days changes refetch (and hit the react-query + proxy caches on
  repeat). Quality switches re-derive attributes from the cached payload
  without refetching.
- Basemap switching swaps the whole MapLibre style, which wipes projection,
  sky and the navy re-tint — a `style.load` listener re-applies all three.
  Idle rotation checks the live projection and only spins the globe.
- Suomi NPP's public 24h feed is currently near-empty (aging satellite,
  data gaps) — the UI just shows a low/zero count; not a bug.

## Phase 3 notes

- **Time = the 4th GPU filter component.** Each point carries
  `[frp, conf, night, ageDays]`; the window slider, scrubbing and playback
  only move `filterRange`/`filterSoftRange` uniforms (age edges are feathered
  so detections dissolve in/out). Verified: zero network requests while
  scrubbing/playing; only the (source, days) key refetches.
- **deck.gl IconLayer/TextLayer do not render under MapLibre's globe camera**
  (probe: zero drawn pixels + failed picks on globe, correct in mercator;
  ScatterplotLayer is fine). EONET markers are therefore MapLibre-native
  symbol layers — full globe support, built-in label collision, native
  hit-testing — created empty at map load so deck's fire layers can anchor
  below them via `beforeId` (deck re-resolves its layer groups on styledata,
  and `style.load` fires first, so basemap swaps stay ordered).
- **EONET query uses `status=open&days=30`** — open alone returns ~6.8k stale
  incidents; the 30-day activity window keeps it to ~130 genuinely active
  named events. Note EONET skews toward US/CA agency reports; most global
  savanna burning is unnamed (that's what FIRMS shows).
- Playback pace is 2.4 s per day of data, dt-clamped so slow renderers slow
  down rather than skip. Multi-day payloads decimate to a per-tier
  `maxPoints` cap (§8) — the 7d world file is ~0.5–1.2M detections.
- The keyless public feeds only exist in 24h/48h/7d granularities; requesting
  3–7 days fetches the 7d file and the GPU age filter trims it client-side,
  so the slider behaves identically with or without a key (8–10 days shows a
  "feed caps at 7d" hint until a FIRMS_MAP_KEY is configured).

## Phase 4 notes

- **Postmortem — the invisible-fires regression:** Phase 3 upgraded the
  `DataFilterExtension` to `filterSize: 4` and the packed buffer to 4-stride,
  but the binary attribute descriptor still said `size: 3`. The GPU read
  misaligned filter values and culled almost every point; Phase 3's checks
  were all CPU-side (request counts, playhead, clicks) so it shipped unseen.
  Phase 4's visual verification caught it; fix is `size: 4`. Lesson encoded
  here: every rendering-path change needs a *visual* assertion, and the stats
  panel now cross-checks the GPU predicate with an independent CPU pass.
- **FIRMS "24h" files are an ingest window, not an acquisition window** —
  they carry rows up to ~2 days old. The GPU age filter enforces the honest
  acquisition window the UI advertises, and the HUD headline is the filtered
  count (stats.shownTotal over the full payload), not the raw row count.
- **Stats/selection index space = the full decoded payload**, never the
  decimated render set — counts stay truthful and top-5 jump-to selects the
  right detection under any quality tier. Hotspot picking is a CPU
  nearest-neighbor search (~2ms over 500k points) honoring the active
  filters — deck picking isn't trusted on the globe.
- **Terminator** = three maplibre fill layers (civil/nautical/astronomical
  twilight bands at sun depressions 0°/6°/12°) from NOAA-grade solar math in
  `lib/terminator.ts` (self-checked against point-in-polygon vs direct
  altitude), re-synced every 60 s and anchored below the fire layers.
- **Search** = Photon (komoot), keyless + CORS-open, debounced 300 ms;
  resolves TODO #4.
- Stats recompute is quantized to quarter-day time steps during playback and
  throttled view updates (≥1.2 s), so the ~10 ms full-array pass never runs
  per frame.
- Confidence normalization: VIIRS `l/n/h` *and* the public feeds' `low/nominal/high`
  words *and* MODIS numeric (`<30` → low, `30–79` → nominal, `≥80` → high) all map
  to one internal 0/1/2 scale.
- Public-feed CSVs lack the `instrument` column; the payload carries what both
  modes share. Per-point detail beyond that (satellite string, scan/track) joins
  the payload in Phase 4 when detail cards need it.
- Fire perimeters (§3.3): **deferred** per the brief's own recommendation — stretch
  only, revisit at Phase 5.

## Phase 5 notes

- **Deep links**: the URL mirrors camera + source + window + filters via
  `history.replaceState` (debounced through the store subscription); loading a
  shared URL jumps straight to the view with filters applied. Unrelated params
  (`?debug`, `?quality`, `?stride`) are preserved.
- **Export**: CSV/GeoJSON of the detections actually visible (filters + time
  window + viewport), capped at 250k rows, via the shared filter predicate in
  `lib/stats.ts` so exports always match the map.
- **Choropleth**: Natural Earth 110m borders (world-atlas TopoJSON, public
  domain) lazy-loaded on first toggle; counts via a 5° grid index + ray-cast
  point-in-polygon over the full payload; rendered as a native fill layer
  anchored beneath the terminator bands.
- **US perimeters**: NIFC WFIGS "current interagency perimeters" ArcGIS
  service — keyless, CORS-open, server-side geometry simplification
  (`maxAllowableOffset`), paged fetch. Rendered as native fill+line beneath
  the fire splats. **EU perimeters deferred**: EFFIS/GWIS expose WMS rasters,
  not a public GeoJSON feature service — revisit if GWIS publishes one.
- **Tauri wrapper deferred**: a desktop shell can't be built or meaningfully
  verified in the headless build environment. When wanted: `npm create
  tauri-app`, point `distDir` at `dist/`, run the Hono proxy as a sidecar (or
  ship the static-data build). The SPA needs no code changes.

## Depth-fighting flicker fix (post-Phase 5)

- **Symptom** (user video): at world zoom — first load and fully zoomed out —
  individual fire splats blinked on/off as the globe rotated. Frame diffs
  showed per-splat popping concentrated on the fire field while the basemap
  barely changed; only below the z4.5 depth-release threshold.
- **Cause**: splats sat *exactly* on the globe surface, so every fragment
  depth-tested against MapLibre's triangulated tile mesh. The mesh's
  interpolated depth wobbles vs deck's exact projection as the camera moves,
  so each splat's test flips pass/fail frame to frame — classic z-fighting.
- **Fix**: lift all splats 25 km off the surface (`SPLAT_LIFT_M` in
  `lib/binary.ts`; derived positions are now `[lon, lat, lift]`). 0.4% of
  Earth's radius — geometrically invisible, far beyond the mesh error, and
  far-side points stay correctly occluded by the globe itself.
- **Verified** with a SwiftShader harness stepping rotation 0.07°/frame and
  counting changed pixels: before ≈2 500–3 100 per step (wildly varying =
  stochastic popping); after ≈1 400 constant (pure rotation shift). Lit-pixel
  totals within 1% (occlusion intact); high-zoom alignment unchanged.

## Camera locked north-up / unpitched (post-Phase 5)

- **Symptom** (user report + screenshot): rotate the globe on a phone and the
  fire points stop sticking to their locations — the whole field detaches
  from the basemap.
- **Cause**: deck.gl's globe integration builds its own `GlobeViewport` from
  MapLibre's view state, and that viewport's view matrix is constructed from
  latitude/longitude only — **bearing and pitch are silently ignored**
  (verified in `@deck.gl/core` source; measured 73 px of misregistration at
  bearing 25°, 48 px at pitch 30°). MapLibre's globe happily applies both
  from two-finger touch gestures, so the basemap rotates while the fires
  render north-up.
- **Fix**: constrain the camera to what the fire renderer can draw —
  `maxPitch: 0`, `dragRotate: false`, `pitchWithRotate: false`,
  `touchPitch: false`, plus `touchZoomRotate.disableRotation()` and
  `keyboard.disableRotation()` on load. Nothing in Ember ever sets bearing or
  pitch (no compass UI, deep links don't carry them, idle rotation only moves
  the center), so this loses no capability. Applied in both projections for
  gesture consistency, though flat mercator would technically render rotation
  fine (deck's `MapView`/`WebMercatorViewport` honor bearing/pitch — and
  deck's `GlobeView` itself hands off to a `WebMercatorViewport` above z12,
  so the bug surface is strictly globe-rendered zooms). A dev-mode `rotate`
  listener warns if any future code path sets a bearing anyway. Revisit only
  if deck's `GlobeViewport` gains bearing/pitch support.
- Not the 25 km splat lift: measured lift parallax at world zoom is <1 px.

## Phase 6 notes — the lightning globe + globe framework

- **Globe framework**: `store.globe` (`?globe=` deep link) selects which data
  globe is on screen; the shell (camera, starfield, terminator, search,
  quality tiers) is shared. Fire-only surfaces (filters/stats/timeline/EONET/
  choropleth/perimeters/picking) are gated by globe; each globe brings its own
  deck layer stack, HUD readout, and legend. The paused globe's query stops
  polling (TanStack `enabled`), and its cached payload makes switching back
  instant.
- **Lightning source → GOES GLM via public S3** (research-verified live):
  keyless, public-domain, one NetCDF granule per satellite per 20 s, landing
  ~10–30 s after observation. NetCDF-4 is HDF5 → decoded with `h5wasm` in
  Node (netcdfjs is NetCDF-3 only). Flash timestamps quantize to the granule
  start (20 s — irrelevant at a 60-min window). Only quality-flag-0 flashes
  are kept; energy is stored in femtojoules.
- **Rolling-window ingest** (server/glm.ts): lazy background loop (starts on
  first `/api/lightning` request, idle-stops after 10 min) lists both buckets,
  fetches newest-first, evicts past window+slack. First responses are a
  partial window — `meta.backfill` (fraction of listed granules decoded) lets
  the HUD say "filling N%" instead of lying about totals. Baked mode
  (`lightning.bin`, same wire conventions as FIRMS) fetches the full window
  per Pages cron run (~4 s, ~45 MB from S3).
- **Coverage honesty**: GOES-West + GOES-East see the Americas, not the
  planet — and GOES-East's GLM feed was in a real multi-hour outage while
  this shipped. Per-satellite freshness ships in the payload header and
  renders as HUD chips ("West live 1m · East DARK"); dashed 64° rings (radius
  measured from the live detection envelope — nothing beyond 65°) mark
  the approximate FOV so empty longitudes read as "no coverage", never "no
  lightning". Both satellites' flashes render in the overlap zone (stereo
  double-count) — kept, since dropping one satellite would blind the overlap
  when the other fails (as now); noted here for honesty.
- **Render**: same additive-splat idiom as fires, cold palette (violet-blue →
  white by log energy). Age decay bakes into per-flash alpha at derive time
  (payload refreshes ≤ 60 s, invisible error on a 60-min curve); the sharp
  window edge and the <3-min "fresh bloom" tier run on the GPU filter, whose
  age ranges slide with the wall clock between refetches (uniform updates via
  the existing ~30 fps pulse ticker, zero rebuilds). Splats reuse the 25 km
  anti-z-fighting lift.
- **EUMETSAT MTG-LI shipped** (Europe/Africa extension): the owner registered
  a free EUMETSAT account; `EUMETSAT_CONSUMER_KEY`/`EUMETSAT_CONSUMER_SECRET`
  live in Actions secrets (Pages) / `.env` (VPS), same pattern as
  `FIRMS_MAP_KEY`. server/mtgli.ts plugs Meteosat MTG-I1 in as a third
  lightning source: keyless browse API lists 10-minute LFL products
  (published ~30-60 s after window close), OAuth2 client-credentials token
  (cached ~1 h), zip download (BODY NetCDF preferred by name), h5wasm decode
  with per-flash timestamps. Without the secrets the source reports
  enabled()=false and is omitted from payloads entirely — no fake DARK
  satellite. LI reports flash *radiance* (mW·m⁻²·sr⁻¹), not GLM's optical
  energy (J): the wire `energy` column is sensor-native intensity on a
  per-satellite relative scale (LI_INTENSITY_SCALE), used only for color/size
  — no UI shows the number with units. Coverage rings and HUD freshness
  chips are satellite-generic (per-sat lonSubSat + cadence in the header;
  "behind" thresholds are cadence-relative: a 12-min-old MTG product is
  normal, a 12-min-old GLM granule is not; baked snapshots measure
  freshness at bake time, since the headline already anchors the snapshot).
  **Intensity calibration, measured from the first real cross-satellite
  payload** (69,555 flashes, 2026-07-17 03:38Z): GLM fJ p50/p95 = 61/757,
  MTG radiance p50/p95 = 121/2,494 — same order of magnitude on the log
  ramp, MTG blooming slightly hotter. LI_INTENSITY_SCALE stays 1.
  Asia/W-Pacific still has no
  legally usable free feed (Blitzortung's rules restrict redistribution;
  commercial networks only) — a permanent gap, shown honestly by the rings.
- **Lightning filters/stats/timeline deferred**: the lightning globe ships
  with HUD + legend only; per-globe filter panels and a minutes-scale
  timeline are a later phase once the framework proves out.

## Phase 6 review round (adversarial workflow — 15 findings, fixes applied)

Highlights of what the review caught before it shipped further:

- `flash_energy` is `_Unsigned` int16 — h5wasm reads it signed, so superbolt
  flashes (raw ≥ 32768) wrapped negative and the GPU filter culled exactly
  the most spectacular strikes. Fixed with unsigned reinterpretation +
  `_FillValue` (-1) guard.
- h5wasm/node is NODERAWFS (real files, not MEMFS): temp granules now write
  to `os.tmpdir()` with pid-unique names so a concurrently running proxy and
  baker can't corrupt each other's decodes.
- Coverage rings were drawn at a guessed 72°; the review *measured* the live
  detection envelope (45 granules: dense to ~63°, zero past 65°) → 64°.
- Baked/Pages payloads froze wrongly: the GPU window slid by wall clock, so a
  25-min-old bake silently lost 40% of its data while claiming "last 60 min".
  Baked windows now freeze at the bake instant and the HUD says
  "60 min to HH:MMZ".
- Mid-entrance globe switches froze ignite/cameraSettled permanently (dim
  layers, no rotation); the entrance cleanup now finalizes instead.
- Lightning had no quality-tier decimation — a hemispheric outbreak would
  render every flash on the performance tier. Derive now honors the tier's
  maxPoints cap, always preserving fresh (<3 min) and top-energy flashes.
- Honesty polish: "flashes" → "detections" (stereo overlap double-counts),
  cold-start shows "acquiring…" not a false dual-outage "DARK", permanent
  fetch failures surface as "(N gaps)", a dark satellite's coverage ring
  restyles red, HUD lag chips re-render on a 30 s tick.
- Post-verification straggler (confirmed against deck 9.3 source): the
  binary-attribute descriptor objects were rebuilt on every ~30 fps pulse
  tick, and deck's skip-reupload check compares descriptor *identity* — so
  every tick re-uploaded every GPU buffer on BOTH globes (~5 MB/frame
  lightning, up to ~30 MB/frame fire). Descriptors are now WeakMap-cached
  per payload, making the per-tick rebuild the uniform-only update the code
  always claimed to be.
- Deferred knowingly: shared-shell controls (projection/basemap/quality/
  terminator) currently live only in the fire-gated FilterPanel, so they are
  unreachable on the lightning globe — lands with the lightning control
  panel phase.


## Phase 7 notes — the severe weather globe (tornado watch)

- **Sources** (all keyless, US-government public domain, live-verified):
  NWS api.weather.gov active alerts filtered to tornado/severe-thunderstorm
  warnings + watches (mandatory User-Agent header; 60 s live poll — warnings
  land within seconds of issuance); SPC storm reports (today's torn/wind/hail
  CSVs, header-only on quiet days, reset 12Z); SPC Day-1 categorical outlook
  GeoJSON with the official risk colors in-band.
- **Watch geometry**: warnings are storm-based polygons with inline geometry;
  watches are zone-based and usually ship `geometry: null` — shapes resolve
  via each alert's `affectedZones` URLs (verified live: alert → zone URL →
  Polygon), merged into a MultiPolygon, with zone shapes cached in-process.
  Alerts whose zones all fail to resolve are skipped rather than mis-drawn.
- **JSON, not binary**: this globe is a few hundred polygons/points (KBs);
  the columnar wire format exists for hundreds of thousands of splats.
  Everything renders as native MapLibre layers (outlook fill → watch
  dash/fill → warning fill/line → report circles), anchored in the same
  beforeId stack as every other native layer.
- **Quiet-day honesty**: zero active alerts is a legitimate state (severe
  weather peaks in the US evening). The HUD keeps the zero counts visible,
  a chip explains that the shading is the day's SPC risk outlook, and
  reports carry "today (resets 12Z)" semantics. Coverage honesty: US-only —
  warnings exist where warning infrastructure exists; said in the legend.
- **Deferred**: warning detail cards (click a polygon → headline/expiry),
  Canada (ECCC CAP) and Europe (MeteoAlarm — 17 MB feeds, unverifiable
  redistribution terms), a convective-day timeline. The severe payload
  reuses the deployed copy on upstream failure, like the fire bins.


## Phase 8 notes — framework hardening + the hurricanes globe

- **Globe registry** (`src/lib/globes.ts`): three globes of per-globe
  branches had already produced two real bugs (a globe missing from the
  footer attribution, another missing from the debug HUD). `GLOBE_DEFS` is
  now the single source of truth — `GlobeId` derives from it, and every
  dispatch surface (switcher tabs, HUD status, feed chips, entrance
  readiness, legend bodies, attribution footer) is either generated from the
  registry or typed `Record<GlobeId, …>`, so adding a globe without one of
  its entries fails to compile. Adding the hurricanes globe exercised this:
  the registry entry produced exactly four compile errors — the to-do list.
- **Shared display controls**: projection/basemap/night-shade/quality lived
  only in the fire-gated FilterPanel and were unreachable on other globes
  (deferred finding from Phase 6). `DisplayContent` is now split out and
  every non-fire globe mounts a slim `DisplayPanel` in the same rail slot.
- **Hurricanes sources** (all keyless, US-government/NASA, live-verified
  against TS Elida): NHC `CurrentStorms.json` (the active-storm index —
  name, classification, kt, mb, position, movement, advisory); the NOAA
  ArcGIS NHC tropical-summary MapServer as `f=geojson` — layer 5 forecast
  points (per-tau `ssnum`/`maxwind`), 6 forecast track, 7 forecast cone,
  11 past track (per-segment Saffir-Simpson `ss`). Field names are
  lowercase; uppercase `outFields` silently return zero features (verified
  the hard way). NASA EONET `severeStorms` fills in basins NHC doesn't
  cover (W Pacific typhoons etc.).
- **Phantom-storm filter**: EONET keeps events "open" for days after a
  storm dissipates. Events whose newest track point is older than 48 h are
  dropped, and storms already in the NHC index are deduped by name — with
  word-boundary matching so short names can't false-match inside longer
  titles. NHC wins the dedupe (fresher, richer: cone/track/points).
- **Failure semantics**: the storm index failing fails the whole build
  (stale fallback with the flag set); each ArcGIS layer degrades to empty
  independently (heads still render from the index). ArcGIS error-in-200
  responses are detected and thrown rather than treated as "no storms".
  5-min TTL + 60 s failure backoff + last-good stale, like severe.
- **Degraded ≠ empty** (review finding): a build with a failed source
  carries `degraded: [...]` — the client shows an amber "sources
  unavailable" chip and a PARTIAL flag, and suppresses the "no active
  cyclones" all-clear (an EONET outage during a quiet NHC day must not
  read as a cyclone-free planet). A degraded build never replaces a
  complete `lastGood` in the live cache, and the bake prefers a complete
  previous deploy (stale-flagged) over degraded-fresh, so outages can't
  erode the fallback chain one section at a time.
- **Cone honesty**: the NHC cone is the probable path of the storm CENTER
  (sized from historical track error), not the extent of impacts — the
  legend says exactly that, and says non-NHC basins show EONET history
  tracks only. Advisory cadence is 3–6 h, so the 5-min poll is generous.
- **All-native rendering**: like severe — a handful of polygons/lines/
  points. Forecast points color by predicted category (TD/TS split on
  34 kt, C1–C5 by `ssnum`), past track by per-segment `ss`, storm heads by
  current intensity, labels via the same symbol pattern as EONET reticles.
  EONET history lines split at the antimeridian (W Pacific storms would
  otherwise draw a wrap-around chord across the globe).
- **Bake**: `hurricanes.json` joins the Pages bake with the same
  reuse-previous-deploy fallback as severe, now extracted into a shared
  `reusePreviousJson()` helper (review finding: the severe block had
  re-implemented `reusePrevious()` inline).


## Phase 9 notes — honesty hardening + severe/hurricane detail cards

- **Severe payload gains the hurricanes-style `degraded` marker** (the
  "empty ≠ degraded" non-negotiable had a hole): SPC outlook/report fetch
  failures previously degraded silently to null/empty — a total SPC outage
  rendered exactly like a quiet day. Now: a failed sub-source falls back to
  its sub-TTL cache when one exists (older data beats none; NOT flagged),
  and is recorded in `degraded: [...]` only when the section ends up empty
  because the source was down. A failed CSV trio no longer poisons the
  reports cache (failures never overwrite it, so the next 60 s rebuild
  retries upstream). Client renders an amber "SPC sources unavailable" chip
  + `PARTIAL` HUD flag and suppresses the quiet-day chip; live cache guards
  `lastGood` against degraded builds and the bake prefers a complete
  previous deploy over degraded-fresh — both copied from hurricanes.
- **Expiry-comparison bug fixed in `severeShown`** (found while wiring card
  expiry): NWS `expires` timestamps carry the alert's LOCAL UTC offset
  ("…T23:00:00-05:00") and were compared lexicographically against a
  Z-suffixed now — an active warning whose offset-local date lags the UTC
  date was dropped hours early (false quiet during the late-evening UTC
  rollover, which is peak US severe season time). Epoch comparison via
  `Date.parse` now; the detail cards use the same clock.
- **Mobile parity for non-fire globes**: the BottomSheet is per-globe —
  fire keeps Filters/Stats; lightning/severe/hurricanes get Display (the
  shared projection/basemap/night-shade/quality controls) + Legend tabs.
  Until now phones had NO controls and NO legend off the fire globe, which
  hid the coverage-honesty copy (GLM rings, US-only severe) the project
  treats as an accuracy requirement.
- **Detail cards land on the severe + hurricanes globes** (deferred at
  Phases 7/8): native-layer hit-testing via `queryRenderedFeatures` with a
  6 px pad (report dots and forecast points are small), claim-priority
  reports > warnings > watches and heads > forecast points, wired through
  the same unclaimed-click handler as fire picking (EONET's
  `preventDefault` still wins). Severe alerts carry no stable upstream id,
  so alert/report selections are SNAPSHOTS of the clicked feature's
  properties, validated at render: an alert card expires exactly when its
  polygon is expiry-filtered (same `uiTick` clock). Hurricane selections
  are stable keys (NHC id / EONET title) resolved against the CURRENT
  payload each render — a dissipated storm drops its card with its head;
  forecast points are snapshots. Card copy keeps the honesty rules: SPC
  magnitudes "as reported" (UNK never renders as a fake zero), report times
  are file-reported UTC, EONET storm cards state they carry no intensity
  data, NHC cards repeat the cone-is-center-path caveat, forecast cards
  note uncertainty grows with lead time.
- **Storm-head selection highlight** reuses the EONET selected-reticle
  expression idiom (`selKey` property + case expression) — no extra layers,
  restyled in the same idempotent sync pass. Severe polygons get no
  highlight (no stable id to match on); the card names the alert instead —
  revisit only if NWS ids join the trimmed payload.
- **`scripts/verify-cards.mjs`** joins the committed verification harness:
  boots the dev app headless, REALLY clicks a warning polygon, a report
  dot, a storm head and a forecast point (via `querySourceFeatures` →
  project → mouse click), asserts the store selection + rendered card, and
  checks the per-globe mobile sheet tabs. Skips honestly when the live
  feeds have nothing to click (quiet weather is real data). Windows note:
  under `npm run dev` on this machine the tsx-watch server child can die
  silently — run `npx tsx server/index.ts` separately if `/api/*` 502s.

### Phase 9 review round (adversarial workflow — 10 findings fixed)

A five-lens review with adversarial verification caught real defects the
first-pass "it works" verification missed (all fixed before shipping):

- **Alert cards outlived cancelled/superseded warnings** (major, safety):
  `validSevereSelection` invalidated a card only by wall-clock expiry, so a
  warning that left the NWS active feed early (cancelled or re-issued —
  routine for storm-based warnings) kept its "N min until expires" card
  counting down over an empty globe for the full remaining expiry. Fixed by
  re-validating the alert snapshot against the same filtered set the map
  draws (`severeShown`) each refetch, mirroring how hurricane storm
  selections resolve against the live payload.
- **The bake threw away fresh warnings on any SPC blip** (major): the new
  severe bake copied the hurricanes "prefer a complete previous deploy over
  degraded-fresh" policy — but severe's degradable sources are only the
  SECONDARY outlook/report shading; the headline NWS warnings are always
  fresh when a build is degraded (an alerts failure throws instead). So a
  single flaky SPC CSV would ship a ~20-min-old deploy and drop the newest,
  most safety-relevant warnings. Severe now always ships fresh-degraded
  (the client already labels it PARTIAL and suppresses the all-clear), and
  the four SPC sub-fetches get the one-retry treatment EONET has.
- **Live-mode SPC fallback served unbounded, unflagged stale data**
  (major): on a long-lived proxy the outlook/report sub-TTL caches stay
  warm, so a persistent SPC outage served a superseded outlook — or the
  PREVIOUS convective day's reports as "since 12Z" — under a fresh
  timestamp forever. The failure fallback is now age-bounded (~3× TTL);
  past that it serves empty + flags `degraded`.
- **Featureless-200 outlook cached as a false quiet** (minor): a 200
  lacking `features` resolved through the success path, cached `null`, and
  shipped an unflagged empty outlook for the full 10-min TTL. Now treated
  as a failed fetch (never cached, flagged), matching the file's own
  never-cache-a-null-zone rule.
- **Quiet-day all-clear over stale/degraded data** (minor honesty): the
  severe and hurricanes "no active …" chips checked `degraded` but not
  `stale`; a stale payload with zero events asserted an all-clear. Both now
  also require `!stale`.
- **`Date.parse` NaN could drop an active warning** (minor): the expiry
  filter's `Date.parse(exp) > now` fails CLOSED on an unparseable timestamp
  (drops the alert from map AND counts) while the card validator failed
  open — inconsistent, and the dangerous direction. Both now fail open: a
  missing or unparseable expiry keeps the warning shown.
- **HurricaneCard could white-screen the app** (defensive): unguarded
  `new Date(upstreamString).toISOString()` on NHC `lastUpdate` / EONET
  `lastDate` throws `RangeError` on a malformed date, and there is no error
  boundary. Now routed through a `parseDate` guard that renders "—"/
  "unknown" instead of crashing.
- **Saffir-Simpson label on non-tropical systems** (minor honesty): the
  storm card appended "category N"/"tropical storm" from wind speed alone,
  which misdescribes potential/subtropical/post-tropical systems (their
  title already carries the correct type). The category phrase now shows
  only for genuine tropical cyclones (TD/TS/HU/MH/TY).
- **Cursor flicker over overlapping features** (minor): per-layer
  mouseenter/mouseleave dropped the pointer while still hovering a
  clickable feature where the report/head layer stacks overlap. Replaced
  with one globe-scoped `mousemove` hit-test.
- **`verify-cards.mjs` ignored page errors** (minor): the harness collected
  uncaught exceptions but exited on assertion failures only — an
  interaction-only crash (the pickers run outside React) would read as all
  PASS. Page errors now fail the run.


## Phase 10 notes — the earthquakes globe (USGS)

The fifth globe, chosen for effort-to-payoff: global, always-populated,
public-domain, minute-fresh.

- **Source → USGS `all_day.geojson`, fetched straight from the client in
  BOTH deploy modes** (the EONET pattern), NOT proxied or baked. The feed is
  keyless, `Access-Control-Allow-Origin: *`, `Cache-Control: max-age=60`
  (verified live), and updates every minute — so a 60 s client poll gives
  fresher data than the 20-min Pages cron a bake would ride, with zero
  server or workflow changes. `src/lib/api.ts` `fetchQuakes` parses
  `[lon, lat, depthKm]`, drops null-magnitude / geometry-less picks (USGS
  sends both), and anchors freshness to the feed's own `metadata.generated`.
  The all_day feed always carries hundreds of global events, so there is **no
  honest empty state** — only a fetch-error chip. (No proxy means no
  stale-on-error fallback; TanStack `keepPreviousData` holds the last good
  payload across a transient blip, which is honest — the HUD timestamp is the
  feed's own generation time.)
- **Render → native MapLibre layers, not deck splats.** A few hundred points
  of JSON is the severe/hurricanes regime, not the hundreds-of-thousands the
  binary splat pipeline exists for. `quakeLayers.ts` stacks eq-ripple (an
  expanding stroked ring on last-hour quakes), eq-glow (blurred,
  magnitude-scaled — the splat-like bloom), eq-dot (solid core), and eq-label
  (`M6.4` for the rare M ≥ 6, native symbol like the hurricane heads, because
  deck text won't render on the globe). Magnitude drives a seismic color ramp
  (slate → green → yellow → orange → rose → magenta → near-white) and a
  fast-climbing radius curve.
- **Ripple animation** = a self-contained rAF in EmberMap
  (`setQuakeRipplePhase`) that drives a synchronized "sonar ping" via two
  `setPaintProperty` calls, mounted only on the quakes globe and paused on
  `document.hidden`. Quakes joins the deck-pulse skip list — its animation
  has its own loop and never re-renders React, unlike the fire/lightning
  pulse.
- **MapLibre one-zoom-curve rule** (bug caught in verification): the selected-
  quake emphasis first nested two zoom-based `interpolate` expressions inside
  a `case`, which MapLibre rejects ("Only one zoom-based interpolate…"). Fix:
  `radiusExpr` takes an optional per-feature `extra` factor folded INTO the
  stop outputs, so the zoom interpolate stays the single top-level curve with
  the selection `case` nested inside — the general pattern for zoom × feature
  data.
- **Detail card** (QuakeCard): click → magnitude + band, depth + shallow/
  intermediate/deep, place, origin time (UTC + local + ago, guarded date),
  coordinates, DYFI felt count, tsunami-evaluation flag, and the USGS event
  link. Picking is native `queryRenderedFeatures` on the circle layers only
  (eq-dot/eq-glow) — the eq-label symbol layer is deliberately excluded, both
  because clicking a label is odd and because `queryRenderedFeatures` on a
  symbol layer can throw mid-glyph-load (observed in the headless harness;
  the app's picker is try/caught and never touches it). When the pad covers
  several quakes the strongest wins. Selection is a stable USGS id resolved
  against the current payload each refetch, so a quake aging out of the 24 h
  window closes its own card.
- **Coverage honesty** (non-negotiable): USGS resolves small quakes only
  where seismometers are dense (US, Japan, …), so the California micro-quake
  cluster is instrumentation, not extra seismicity — the legend says exactly
  that, and that roughly M4.5+ is globally complete. Magnitude scaling means
  the great quakes dominate the eye regardless of the small-event bias.
- **Harness**: `headless-check.mjs` gained the `eq-` layer prefix and now
  wraps each per-layer `queryRenderedFeatures` in try/catch (a symbol layer
  throwing mid-glyph-load reports `err`, not an aborted report — this also
  protected the hurricane/eonet symbol layers). `verify-cards.mjs` clicks the
  strongest live quake and asserts the card.


## Phase 11 notes — the aurora globe (NOAA OVATION)

The sixth globe — the "gorgeous on the night side we already draw" pick.

- **Source → NOAA SWPC OVATION** (`ovation_aurora_latest.json`), fetched
  straight from the client in both modes (the USGS/EONET pattern) — keyless,
  `Access-Control-Allow-Origin: *`, `max-age=60`, a fresh grid every ~5 min.
  It's a **1° global probability grid** `[lon 0–359, lat −90..90, prob 0–100]`;
  `fetchAurora` keeps cells ≥ 5 % (the noise floor around the ovals — a few
  thousand points), and converts `lon > 180 → lon − 360` for MapLibre.
- **It is a FORECAST, not observed aurora** — the payload's `Observation
  Time` is the solar-wind input and `Forecast Time` is ~30–90 min ahead, so
  freshness is anchored to the forecast valid-time and every surface says so
  (HUD "peak N% aurora **chance** · **forecast**", subline "OVATION forecast
  · visible on the dark side · valid HH:MMZ", legend "a *forecast* of where
  aurora is likely… shows probability, not live sightings"). Brightness maps
  to *probability*, not physical intensity — the legend says that too.
- **Render → native circle field, not deck.** A blurred wide `aur-glow`
  (green ramp + opacity by probability) whose ~1°-spaced discs overlap into a
  continuous auroral-oval band, plus a tighter brighter `aur-core` ridge on
  the higher-probability cells. Display-only, like the lightning globe: the
  OVATION output is a continuous field, so there is nothing discrete to click
  (no card/selection/picking/cursor). A gentle `setAuroraShimmer` breathes the
  glow opacity ±9 % via a self-contained rAF mounted only on the aurora globe;
  aurora joins the deck-pulse skip list. The opacity floor is lifted enough
  that even a quiet-night oval (peak ~20 %) reads as a clear band while
  brightness still climbs with probability.
- **Both hemispheres, dark-side-only**: the OVATION grid covers the northern
  AND southern ovals; aurora is only *visible* where the sky is dark, which is
  why the globe pairs naturally with the real-time terminator (on by default).
  Coverage stated honestly in the legend.
- **Quiet ≠ error** (honesty): unlike the always-populated quake feed, aurora
  can be genuinely faint during low geomagnetic activity — `count === 0` above
  the threshold is a legitimate "aurora unlikely right now" chip, not a
  degraded/error state. `headless-check.mjs` gained the `aur-` layer prefix.


## Phase 12 notes — the live-flights globe (airplanes.live)

Frank asked for a FlightRadar-style airspace view. A feasibility research
pass (see the openQuestions it raised, resolved by Frank) settled the source
and framing; the decisions: **airplanes.live** for live aircraft (Frank
confirmed Ember is permanently non-commercial), plus a future openAIP
airspace/FIR layer.

- **Why airplanes.live, and why it forces a new pattern.** Of the ADS-B
  feeds, OpenSky is license-blocked for a live product (written license
  required for operational use), adsb.fi/hexdb have redistribution gaps, and
  only **airplanes.live is keyless + CORS-open + non-commercial-clean**
  (verified `Access-Control-Allow-Origin: *`). Critically it serves a
  **≤ 250 nm radius per query** and the 20-min Pages bake **cannot honestly
  show moving aircraft** (a jet moves ~150 nm in 20 min — a baked dot would
  be a lie by exactly Ember's own standard). So this globe is **client-direct
  live fast-poll, viewport-following, regional** — the first globe that is
  neither world-view-first nor bakeable.
- **Viewport-follow** (`App.tsx`): a `flightsView` memo derives center +
  radius from the camera (`mapBus.getCamera`/`getBounds`, haversine
  center→corner, capped 250 nm, center rounded to 0.1° so jitter doesn't
  refetch), re-keyed on `viewEpoch` (the moveend bump). Below
  `FLIGHTS_MIN_ZOOM` (4.5) the query is disabled and the HUD prompts
  "zoom in to load live aircraft"; `feedReadiness.flights` treats a null
  follow-window as ready so the world-zoom entrance never hangs. A jump-load/
  deep link fires no moveend, so the `mapBus` setup effect nudges `viewEpoch`
  once on map-ready to seed the first compute.
- **Render** (`flightLayers.ts`): native **SDF plane glyph** (`addImage`
  `sdf:true`) so one icon recolors per-feature by altitude (amber on the deck
  → sky → indigo → violet at cruise; grey on ground), rotated to ground track
  with `icon-rotation-alignment:'map'` so heading stays geographic under the
  globe. A collision-optional callsign label appears from zoom 7. Native
  because deck Icon/Text don't render under the globe camera. Click →
  `FlightCard` (callsign, type, altitude, ground speed, heading, registration,
  ICAO hex) via `queryRenderedFeatures` on the plane layer; selection is the
  stable ICAO hex resolved against the current snapshot, so a plane that flies
  out of the view closes its own card.
- **Coverage honesty** (non-negotiable): positions are seconds old; the
  legend + HUD say **blank areas mean no receiver coverage, not empty sky**
  (community ADS-B is dense over the US/EU, sparse over oceans/Africa/Asia),
  and that the view shows the **current region only** (≈250 nm). The
  **non-commercial airplanes.live attribution** rides in the footer and
  legend as the license requires. `headless-check.mjs` gained the `flt-`
  prefix; `verify-cards.mjs` clicks a live aircraft (without jumping the
  camera, which would change the follow-window) and asserts the card.
- **ADSBExchange-grade detail** (Frank's follow-up "make it display
  everything flightradar/adsbexchange"): the parse now keeps the full ADS-B
  block — geometric altitude, IAS/TAS/Mach, **vertical rate**, squawk,
  emergency status, emitter category, **operator** (`ownOp`), year, and the
  tar1090 **military/interesting** flags (`dbFlags`). Rendering adds a
  fuller **altitude rainbow**, **emergency** aircraft in red (squawk
  7500/7600/7700 or an ADS-B emergency flag) + enlarged, **military** badge,
  **data-block labels** (callsign, then FL + speed once zoomed in), and
  **trails**: ADS-B carries no history, so the selected plane's path is
  accumulated client-side across snapshots (keyed by hex, capped, pruned) and
  drawn colored by altitude per segment. The card shows all of it. **Route /
  airline schedule is honestly absent** — it isn't broadcast over ADS-B
  (FR24 gets it from a proprietary schedule DB); the card + legend say so.
- **Phase 12 review round** (adversarial workflow, 5 findings fixed, all the
  "stale-shown-as-live" class): (1) zooming out below the load zoom left the
  last snapshot's planes **frozen at full opacity forever** while the HUD said
  "zoom in" — the render surfaces (`flights`/`flightTrail` props, `resolved
  Aircraft`, debug count) are now gated on `flightsView`, so an out-of-range
  zoom clears the layer (verified: 95 planes → 0). (2) A closed FlightCard
  **silently re-opened** when the plane re-entered the view — `selectedAircraft`
  is now cleared once a real snapshot confirms it's gone. (3) During a feed
  **outage** the frozen last-good planes rendered as live — a `flightsStale`
  flag (mirroring `quakesStale`) now dims them. (4) Airborne aircraft with **no
  reported altitude** were colored amber (the "on the deck" stop) — now a
  distinct neutral slate.
- **Deferred (per Frank's decisions, now being built)**: the **openAIP
  airspace/FIR** layer, and the **armed-conflict globe** — see Phase 13.


## Phase 13 notes — the armed-conflict globe (UCDP + GDELT)

Frank asked for a "war / rising tensions" globe. A feasibility research pass
established that no license-clean source is simultaneously live, verified,
AND global, and that "tensions" is not measured by any of them — so the
globe was **re-scoped to "Armed conflict"** and built from two epistemically
distinct sources, kept visually and semantically **separate, never merged**.

- **UCDP GED-Candidate → the honest core.** Analyst-**verified** events of
  organized violence (≥1 reported death), geo-coded, CC BY 4.0, keyless bulk
  CSV. It is authoritative but **monthly with a ~1-month lag** — NOT live; the
  newest verified events are weeks old, and a place with no dots is "not yet
  verified", not peaceful. `server/conflict.ts` probes the candidate versions
  (`GEDEvent_vYY_0_N.csv`) so the monthly bump is picked up without a code
  change, parses a full quote-AND-embedded-newline-aware CSV (UCDP source
  fields contain both), filters to fatal + last ~400 days, caps at 9k newest.
  Rendered as warm solid dots colored by violence type (state-based /
  non-state / one-sided) and **sized by death toll**.
- **GDELT 2.0 → a separate, clearly-labeled news layer.** Machine-coded
  conflict-related **NEWS** events (QuadClass 4 / CAMEO roots 18–20), refreshed
  every 15 min, **UNVERIFIED** — a point marks where news is being *written
  about* a place (algorithmic geolocation + event coding), not a confirmed
  event (the parse even surfaces the odd mis-coded old article — exactly why
  it's labeled unverified). Downloaded as a zipped tab-CSV and unzipped with
  `fflate` (already a dep), deduped by ~11 km cell. Rendered as faint hollow
  cool rings, deliberately secondary. Neither layer is called "war" or
  "tensions"; the legend distinguishes the two epistemically.
- **Declined (documented like MeteoAlarm/Blitzortung)**: **ACLED** — its EULA
  forbids public dashboards / third-party direct access and is credential-
  gated. **Ukraine air-raid APIs** — token-gated, single-country, unverifiable
  redistribution terms.
- **Architecture**: unlike the other recent globes this needs the server side
  (GDELT's zip has no browser CORS; UCDP is a bulk CSV), so it rides the Hono
  proxy (`/api/conflict`) in live mode and the bake (`conflict.json`) in static
  mode — the severe/hurricanes pattern. `server/conflict.ts` keeps a UCDP 6 h
  sub-cache (monthly data) under the 10-min payload cache, a `degraded[]` array
  (UCDP / GDELT degrade independently), a `lastGood` guard against degraded
  builds, and the bake prefers a complete previous deploy over a degraded-fresh
  one. The refuse-to-deploy guard now counts `conflict` too.
- **Honesty everywhere**: HUD "N verified events · N deaths · N news"; subline
  "UCDP verified (monthly, ~1mo lag) + GDELT news (15 min, unverified) · blank
  ≠ peace"; the verified card says "verified · UCDP" with the CC-BY provenance
  and flags coarse geo-precision as "approx."; the news card is headed
  "CONFLICT NEWS" and says "UNVERIFIED … where news is written ABOUT a place".
  Footer credits "Armed conflict: UCDP (CC BY 4.0) + GDELT". `headless-check`
  gained the `cf-` prefix; `verify-cards` clicks the deadliest event in view
  and asserts the verified card.
- **Still deferred**: the **openAIP airspace/FIR** layer on the flights globe.
  Research finding: openAIP's per-country airspace files are impractical at
  scale (the US file alone is **495 MB** and mixes all classes), so the airspace
  layer will instead use a small clean global **FIR/UIR boundary** GeoJSON
  (OpenAviation / Eurocontrol-atlas world file) as static reference lines
  beneath the aircraft — next increment.


## Phase 13b — FIR airspace layer (Eurocontrol)

The second half of Frank's flights ask ("view the airspace over countries").

- **openAIP was ruled out** (per-country files are impractical: the US file
  alone is 495 MB and mixes all classes). Clean-licensed **global** FIR
  boundaries turn out not to exist — the honest finding. The clean regional
  options are **Europe** (Eurocontrol PRU "atlas", **MIT**-licensed) and the
  **US** (FAA, public domain) — which happen to be the two densest ADS-B
  regions. Shipped the Europe set now; US could follow.
- **Data**: `topo/euctrl/euctrl.json` from the eurocontrol-atlas repo — 88 KB,
  83 named FIRs, committed as a static `public/eu-firs.topo.json`, fetched
  lazily on first flights-globe view and converted client-side with
  `topojson-client` (already a dep, the choropleth uses it).
- **Render** (`firLayers.ts`): faint dashed indigo FIR outlines + uppercase
  names, drawn BENEATH the plane layers (by insertion order in
  `syncNativeLayers`) as geographic control-region context. Display-only, no
  picking. Legend + footer credit Eurocontrol (MIT) and say plainly it's
  **Europe-only** because clean global FIR data doesn't exist.


## Phase 14 — flight route + aircraft photo (FlightRadar polish)

Frank asked for FlightRadar's click-a-plane extras: the flight path and a
real photo. Neither is in ADS-B, so both are external lookups, honestly
labeled as NOT-from-ADS-B.

- **Scheduled route** (`api.ts` `fetchRoute` + `routeLayers.ts`): **adsbdb**
  by callsign — keyless, CORS-open, so it's **client-direct and works on the
  static Pages site**. Draws a **great-circle arc** (slerp) origin→destination
  + airport dots/labels beneath the planes, split at the antimeridian. The
  card shows `LHR ✈ JFK · airline` with "scheduled route (adsbdb) — estimated
  from the callsign, not the ADS-B path". Query keyed on the callsign so it
  doesn't refetch on the 6 s position poll.
- **Aircraft photo** (`/api/aircraft-photo` + `fetchAircraftPhoto`):
  **planespotters**, but their API rejects any request whose User-Agent lacks
  a contact URL — and **browsers cannot set `User-Agent`** — so it MUST be
  proxied. The Hono route holds a compliant UA and returns just the thumbnail
  metadata (the `t.plnspttrs.net` image itself loads fine in an `<img>` on any
  origin). **Consequence: the photo works in the proxy/VPS mode but NOT on the
  static GitHub Pages deploy** — `fetchAircraftPhoto` returns null in
  `STATIC_MODE`, so the card simply hides the photo there (no broken image).
  To light it up on Pages later, add a tiny serverless photo-proxy (a
  Cloudflare Worker/Pages Function). The card labels it a **library photo of
  the registration** (not this exact flight) and credits the photographer +
  Planespotters with a link, as their terms require.
- Honesty: the card footer states plainly that position/altitude/speed are
  live ADS-B while the route/airline and photo are external lookups.


## Phase 14b — aircraft photos on static Pages via a Cloudflare Worker

Phase 14 left the aircraft photo working only in proxy/VPS mode because the
User-Agent requirement needs a *server*. Rather than leave it dark on the live
Pages site, added the smallest possible server: a Cloudflare Worker (`worker/`,
free tier — 100k req/day, 24 h edge cache).

- **`worker/photo-proxy.js`** mirrors the Hono `/api/aircraft-photo` route
  exactly: validate `hex` against `/^[0-9a-f]{6}$/`, call planespotters with
  the compliant UA `Ember-hazard-globes/1.0 (+https://github.com/ReFxFrank/
  Weatherman)`, return `{thumb, link, photographer}` (or `{photo:null}`) with
  `Access-Control-Allow-Origin: *` so github.io can read it. The image itself
  (`t.plnspttrs.net/…`) then loads directly in the `<img>`. Verified locally
  with `wrangler dev`: real hex → the Ryanair 737 photo JSON, bad hex →
  `{photo:null}`, OPTIONS → CORS headers.
- **Client** (`api.ts` `fetchAircraftPhoto`): in `STATIC_MODE` it now hits
  `VITE_PHOTO_PROXY` if that build var is set, else returns null (photo stays
  hidden — no broken image). Proxy/VPS mode is unchanged (`/api/...`).
- **Wiring** (`pages.yml`): the build reads repo Actions *variable*
  `PHOTO_PROXY_URL` into `VITE_PHOTO_PROXY`. Unset → photos simply stay hidden,
  so the build never depends on the Worker existing.
- **Two account-scoped steps Frank must run once** (can't be automated by this
  token — they touch his Cloudflare + GitHub accounts):
  1. `cd worker && npx wrangler deploy` → prints
     `https://ember-photo-proxy.<subdomain>.workers.dev`
  2. Repo → Settings → Secrets and variables → Actions → **Variables** → New
     variable `PHOTO_PROXY_URL` = that URL. Next Pages build lights up photos.
- **Why a Worker and not a Pages Function**: the site is deployed by the Pages
  *Actions* workflow (upload-pages-artifact), not Cloudflare Pages, so there's
  no Functions runtime in this deploy. A standalone Worker is independent of
  the host and portable if the deploy target ever changes.
## Phase 15 notes — lightning depth (picking, flash card, strike-rate strip)

- **Flash picking** reuses the fire globe's CPU nearest-search idiom
  (`nearestFlash.ts`) but searches the RENDERED (quality-decimated) set,
  not the full payload — what you click is what's glowing. The age cutoff
  mirrors `lightningLayers.ts` exactly (live slides with the wall clock,
  baked freezes at the bake instant) so filtered-out history can't be
  picked.
- **The card's headline is "how long ago"** — a 1 s-ticking relative age —
  because that's the question the globe raises. Honesty callouts: GLM
  flash times snap to the 20 s granule start (MTG-LI carries true
  per-flash seconds, so the caveat renders only for GLM); position is
  cloud-top light seen from orbit (~8–14 km GLM / ~4.5 km MTG pixels), not
  the ground strike point; energy is optical energy at cloud top with a
  percentile rank against the current window (sorted-copy per payload,
  WeakMap-cached).
- **Reverse geocoding** via Photon `/reverse` (keyless, CORS-open — the
  same service the search box already uses; verified live). The nearest
  OSM feature can be far from an offshore flash, so matches beyond 150 km
  render as "open water / remote" instead of naming a distant town.
- **Selection survives the 60 s refetch** by identity, not index: indices
  reshuffle per payload, so App captures the selected flash's
  (lon, lat, ts, energy) tuple and re-finds it in each new render set
  during render, passing the validated index DOWN to EmberMap/FlashCard
  (the fire globe's validSelection pattern) — no one-frame wrong-ring.
  A flash that ages out (or is decimated away on a lower quality tier)
  closes the card rather than silently re-pointing at a different strike.
- **The strike-rate strip** (fire's playback slot): per-minute bins of the
  FULL decoded payload (not the decimated render set — counts must be
  true), live bins re-aged every 15 s, baked bins frozen at bake. The
  det/min readout anchors to the newest timestamp IN THE DATA, not the
  wall clock or bake instant (review finding: refetch lag + 20 s
  granule-start quantization made a clock-anchored rate systematically
  undercount — near zero "at bake" on Pages during an active storm), with
  an inclusive upper bound because a whole GLM granule shares the edge
  timestamp. Age-window buttons (ALL/30/10/3 min) are pure GPU
  filter-range changes — never a refetch — the same idiom as fire
  playback; the HUD gains a "showing Nm" note so a narrowed globe can't
  read as a quiet hour.
- **Review pass** (2 reviewers → per-finding adversarial verification, all
  six findings confirmed and fixed): the age-window predicate now lives in
  ONE place (`flashAgeAtFetchMax`) shared by the GPU cutoff mirror, click
  picking and selection validation — a selected flash that slides out of
  the window drops its ring/card instead of floating over empty map for up
  to ~57 min (the orphaned-selection class the fire globe closed in Phase
  4); a failed Photon lookup renders "location lookup unavailable" and is
  never cached — only a successful answer may claim "open water"
  (empty ≠ degraded); percentile copy names its denominator (the fetched
  60-min window); "strikes/min" → "det/min" (stereo overlap
  double-counts).
- **Deferred**: energy-floor filter, per-satellite split in the strip,
  click-a-bin scrubbing, flash clustering into storm cells.
