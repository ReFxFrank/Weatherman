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

## Other notes

- **React 18** pinned per the brief (not 19).
- deck.gl mounts through `MapboxOverlay` in **interleaved** mode over MapLibre's
  globe projection (deck.gl ≥ 9.1 supports this pairing).
- Confidence normalization: VIIRS `l/n/h` *and* the public feeds' `low/nominal/high`
  words *and* MODIS numeric (`<30` → low, `30–79` → nominal, `≥80` → high) all map
  to one internal 0/1/2 scale.
- Public-feed CSVs lack the `instrument` column; the payload carries what both
  modes share. Per-point detail beyond that (satellite string, scan/track) joins
  the payload in Phase 4 when detail cards need it.
- Fire perimeters (§3.3): **deferred** per the brief's own recommendation — stretch
  only, revisit at Phase 5.
