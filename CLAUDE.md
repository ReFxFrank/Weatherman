# CLAUDE.md — working on Ember

Ember is a mission-control-styled web app: a dark rotating Earth in space with
selectable **live hazard globes** — fires (NASA FIRMS), lightning (GOES GLM +
Meteosat MTG-LI), severe weather (NWS/SPC), hurricanes (NHC + EONET),
earthquakes (USGS). Live at
https://refxfrank.github.io/Weatherman/ (redeployed every ~20 min by cron).

Read next, in order:
- `README.md` — phase/status table, stack, deploy modes, deep-link params
- `docs/BRIEF.md` — the original build spec (§ numbers in code comments refer here)
- `docs/DECISIONS.md` — the WHY log. **Append a section for any significant
  work**; it is the project's memory across sessions. Check its "deferred"
  notes before proposing new work — much has been consciously deferred.

## Non-negotiables

- **Real data only, never mocked.** Every rendered datum comes from a live
  (or honestly-labeled baked/stale) upstream. No fabricated fallbacks.
- **Accuracy beats spectacle, and empty ≠ degraded.** Zero warnings on a calm
  day is real data and deploys; an empty section caused by a *failed source*
  must be labeled (`stale`, `degraded`, PARTIAL/STALE chips) and must never
  render as an all-clear. Copy must not overclaim (e.g. lightning "detections"
  not "flashes" because stereo overlap double-counts; the hurricane cone is
  the probable path of the storm *center*, not the impact area).
- **Secrets** (`FIRMS_MAP_KEY`, `EUMETSAT_CONSUMER_KEY/SECRET`) live only in
  `.env` (gitignored) and GitHub Actions secrets. Never in client code — the
  Pages build is fully static and public; anything the browser fetches is
  keyless. Never in logs: the EUMETSAT token endpoint's error body echoes the
  consumer key, so log only the error *code* (see `server/mtgli.ts`).
- **Git**: all work on `claude/ember-wildfire-map-0vcsas` (the default
  branch). Never push elsewhere; no PRs unless asked. **A push to this branch
  deploys to the live site within ~2 minutes** (the Pages workflow runs on
  push), so `npm run build` must pass locally before every push.

## Commands

```bash
npm run dev          # Hono API proxy :8787 + Vite :5173 (Vite proxies /api)
npm run typecheck    # tsc --noEmit over src/, server/, scripts/ (no eslint here)
npm run build        # typecheck + vite build → dist/
npm run bake         # bake static /data payloads (what the Pages cron runs)
node scripts/headless-check.mjs [url] [shot.png]
                     # headless smoke-check — needs `npm run dev` already
                     # running (default url :5173), or pass the live Pages URL
```

Bake knobs (all optional): `SOURCES=` / `WINDOWS=24h` limit fire feeds,
`SKIP_LIGHTNING=1` `SKIP_SEVERE=1` `SKIP_HURRICANES=1` skip sections,
`OUT_DIR=` output dir, `FALLBACK_BASE=https://…` enables reuse-previous-deploy
fallbacks. Quick hurricanes-only test:
`SOURCES=, SKIP_LIGHTNING=1 SKIP_SEVERE=1 OUT_DIR=/tmp/bake npm run bake`

Reproduce the Pages site locally: `VITE_DATA_MODE=static npm run build &&
OUT_DIR=dist/data npm run bake && npm run preview`. Data URLs derive from
`import.meta.env.BASE_URL`; the workflow additionally sets
`VITE_BASE=/Weatherman/` for the subpath — local default `/` is fine.

## Architecture

Two deploy modes, same client code (`VITE_DATA_MODE=static` switches
`src/lib/api.ts` from `/api/*` to baked `/data/*` files):

- **Live proxy**: `server/index.ts` (Hono) — `/api/hotspots` (binary),
  `/api/lightning` (binary), `/api/severe` + `/api/hurricanes` (JSON),
  `/api/quota`, `/api/health`. Per-source modules own the fetch/parse logic:
  `server/firms.ts`, `server/glm.ts` + `server/mtgli.ts`, `server/severe.ts`,
  `server/hurricanes.ts`. severe/hurricanes share the canonical cache pattern
  (TTL + single-flight + failure backoff + last-good-with-`stale`-flag) —
  **copy one of those for a new source**. FIRMS gets its TTL/single-flight/
  last-good cache in `server/index.ts` (`getHotspots`); GLM instead runs a
  background rolling-window ingest with a short payload cache.
- **GitHub Pages**: `.github/workflows/pages.yml` (push + `*/20` cron) runs
  the bake, writing the same payloads to `dist/data/` plus `manifest.json`.
  Every section has an upstream-outage fallback that refetches the
  currently-deployed copy (`reusePrevious` for binaries, `reusePreviousJson`
  for JSON) so one outage can't strip a dataset; hurricanes additionally
  prefers a complete previous copy over a degraded-fresh build. The bake
  refuses to deploy only when there is literally nothing to serve.
- **Not everything rides those two paths**: the client calls some upstreams
  directly in BOTH modes — EONET events (`api.ts`), USGS earthquakes
  (`fetchQuakes` in `api.ts` — no proxy/bake at all, the whole quakes globe
  is client-fetched), Photon geocoding (`SearchBox.tsx`), NIFC perimeters
  (`perimeters.ts`), CARTO basemap styles/tiles (`EmberMap.tsx`). A static
  Pages deploy still makes live cross-origin requests; these must stay
  keyless and CORS-open.

Client: React 18 + TS + Vite + Tailwind v4 (no `tailwind.config.js` — config
is the `@tailwindcss/vite` plugin + the `@theme` block in `src/index.css`,
which also carries load-bearing plain CSS like the transparent MapLibre
canvas that lets space show through). `src/store.ts` (zustand) holds UI
state — **mutate through `setEmber()`**, which owns coupled side effects
(quality→localStorage, `days` resets playback, globe switch clears
selections); state that should survive in shared URLs must be added to BOTH
`stateFromUrl` (store.ts) and `syncUrl` (`src/lib/deepLink.ts`). TanStack
Query fetches per-globe feeds (each `enabled:` only on its globe).
`src/App.tsx` orchestrates queries/HUD/chips/panels; `src/components/
EmberMap.tsx` owns the MapLibre globe + deck.gl interleaved overlay and calls
each `src/lib/*Layers.ts` / `sync*` module idempotently (map `load`, every
`style.load`, and per-payload effects). UI outside the map reaches it via the
`mapBus` singleton (`src/lib/mapBus.ts` — flyTo/getBounds/getCamera), not refs.

Fire + lightning render as deck.gl splats fed by a binary columnar wire
format (`src/lib/binary.ts`, `lightningBinary.ts`); severe + hurricanes are
all-native MapLibre layers (polygons/lines/symbols — KBs of GeoJSON, deck
would be overkill). The fire globe also carries client-only subsystems with
no server side: timeline scrub/playback (`TimeControl.tsx` + `store.playhead`
— a GPU age filter, never a refetch), CSV/GeoJSON export (`exportView.ts`),
lazy country choropleth (`choropleth.ts`), US perimeters (`perimeters.ts`),
Photon search (`SearchBox.tsx`), deep links (`deepLink.ts`), mobile bottom
sheet (`BottomSheet.tsx`).

## Adding a globe (the intended workflow)

1. Server: `server/<name>.ts` (copy the severe/hurricanes cache pattern),
   route in `server/index.ts`, bake section in `scripts/bake-data.ts`.
2. Client plumbing: payload type mirror in `src/lib/types.ts`, fetch fn +
   refresh cadence in `src/lib/api.ts`, a `src/lib/<name>Layers.ts` sync
   module (copy `severeLayers.ts`/`hurricaneLayers.ts`).
3. **Add the registry entry in `src/lib/globes.ts`, then follow the compile
   errors.** `GlobeId` derives from `GLOBE_DEFS`, and every dispatch surface
   (App's feedReadiness/feedChips/feedStatus, Legend's LEGEND_BODIES) is an
   exhaustive `Record<GlobeId, …>` — the type errors ARE the wiring
   checklist. Also: EmberMap prop + dedicated sync effect + `layers` memo
   branch, and a legend body with honest coverage/semantics copy.
4. Verify headlessly (below) — and add your new layer-id prefix to the
   layer-report regex in `scripts/headless-check.mjs`, or the check will
   silently skip your globe's layers. Run an adversarial review, append to
   DECISIONS.md, update README's phase table.

## Verification

- Dev-only hooks on `window`: `__emberMap` (MapLibre map), `__emberStore`,
  `__emberOverlay` (deck), `__emberEvents`. URL params: `?globe=fire|
  lightning|severe|hurricanes`, `?lat=&lon=&z=` (skips the entrance
  animation), `?quality=high|balanced|performance`, `?stride=N`, `?debug=1`.
- `node scripts/headless-check.mjs '<url>' out.png` — boots real Chromium
  (SwiftShader, works GPU-less), prints the HUD line, per-layer
  visibility:featureCount, and page errors, saves a screenshot. Reads
  `CHROMIUM_PATH` (falls back to `/opt/pw-browsers/chromium-*` in the Claude
  remote container, then an installed Chrome). When `HTTPS_PROXY` is set it
  relays external hosts through undici (Chromium won't trust the container's
  TLS-intercepting proxy). Headless Chromium auto-detects into the
  `performance` quality tier (no glow passes, stride 2) — NOT what real
  users see; pass `?quality=high` when diffing visuals. Note the quality
  choice persists in localStorage (`ember-quality`).
- No screenshot baseline is checked in: for a "before" shot, run the check
  against the live Pages site with the same `?globe=&lat=&lon=&z=` params
  (or `git stash` first).
- Verify against LIVE upstream data before shipping an ingest (curl the
  endpoints, inspect real payloads); after a Pages deploy, check
  `…github.io/Weatherman/data/manifest.json` and the site itself.

## Hard-won gotchas (violating these re-breaks fixed bugs)

- **The camera is locked north-up, unpitched** (`EmberMap.tsx`): deck.gl's
  GlobeViewport ignores bearing/pitch, so any rotation detaches deck splats
  from the basemap. Never set a bearing programmatically (DEV tripwire warns).
- deck.gl Icon/Text layers don't render under MapLibre's globe projection —
  use native symbol layers (see `eonetSymbols.ts`, `hurricaneLayers.ts`).
- deck binary-attribute descriptors are compared by *identity*: rebuild them
  per payload only (WeakMap caches in `fireLayers.ts`/`lightningLayers.ts`)
  or every animation tick re-uploads every GPU buffer.
- Splats are lifted 25 km (`SPLAT_LIFT_M` in `src/lib/binary.ts`) to avoid
  z-fighting MapLibre's triangulated globe tile mesh (there is no terrain);
  wire positions are 2-component [lon, lat] — the client derives
  3-component [lon, lat, lift] render positions at attribute-derive time.
- **Fire filters exist FIVE times**: as GPU `DataFilterExtension` ranges
  (`fireLayers.ts`), the CPU predicate `passesFireFilters` (`src/lib/
  stats.ts` — used by export and the choropleth), and inlined copies in
  `computeFireStats` (stats.ts), `findNearestHotspot` (nearestHotspot.ts)
  and App's `validSelection` memo. Change filter semantics in ALL of them
  or headline counts, exports, picking and the selection ring silently
  disagree with what's glowing on the map.
- Native-layer sync modules must be idempotent and style-swap-safe: guarded
  by try/catch, re-run on `style.load`, sources keyed by `fetchedAt`/
  `renderKey` so unchanged data skips `setData`.
- NWS API requires a `User-Agent`; watch alerts usually ship `geometry:null`
  and need zone-geometry resolution; never cache a zone fetch that returned
  null. Warnings expire in minutes — the client re-filters by expiry between
  polls (`severeShown` in App.tsx).
- NHC ArcGIS MapServer: field names are **lowercase** (uppercase `outFields`
  silently return zero features) and errors arrive as HTTP 200 + `{error}`
  body. EONET keeps events "open" long after storms die — freshness-filter
  and dedupe (token-wise, not substring) against NHC.
- GLM granules: `flash_energy` is a scaled `_Unsigned` int16 — h5wasm reads
  it signed, so superbolts wrap negative and vanish unless reinterpreted
  (and signed -1 is the 65535 fill); check `_Unsigned` on any new int16
  field you decode. h5wasm on Node is NODERAWFS — temp `.nc` files are real
  files, use pid-unique names in tmpdir. MTG-LI: BODY zip entry, root-level
  LFL vars, scaled ints with fill values, per-flash times since 2000-01-01.
- FIRMS/EONET are sometimes unreachable *specifically from GitHub runners*
  (observed ~1 h FIRMS outage, EONET flaps): every bake section has a
  reuse-previous fallback, EONET gets one retry in the hurricanes build.
- Baked payloads must freeze their time semantics at bake time (a sliding
  "last 60 min" window over a 25-min-old bake silently loses data).

## Environment

`.env` (copy `.env.example`) is loaded by the npm scripts via tsx's
`--env-file-if-exists=.env` — but NOT by bare `npx tsx …` invocations or
anything else; for those, export first (`set -a; . ./.env; set +a`). The VPS
systemd unit and GitHub Actions inject the same vars themselves. All
optional: `FIRMS_MAP_KEY` (public fire feeds otherwise),
`EUMETSAT_CONSUMER_KEY/SECRET` (GOES-only lightning otherwise), `PORT`
(default 8787 — leave it: `vite.config.ts` hardcodes the `/api` dev-proxy
target to `127.0.0.1:8787`, so a non-default PORT silently breaks
`npm run dev`). Server/bake honor `HTTPS_PROXY` via undici's
`EnvHttpProxyAgent`.
