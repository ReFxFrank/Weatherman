# Build Brief — Global Wildfire Monitoring Map ("Ember")

> **How to use this brief:** Hand this whole file to a Claude Code agent as the initial context. It is self-contained and phased with explicit acceptance criteria. Fill in the `TODO(frank)` markers before or during Phase 0 — everything else can be inferred from the spec. Kickoff line: *"Read this brief top to bottom, then execute Phase 0 and stop for my review before Phase 1."*

---

## 1. Objective

Build an intuitive, professional, visually striking **interactive web map that monitors active wildfires worldwide using live, continuously-updating satellite data.** The map should read like a mission-control dashboard: dark, glowing, dense with real information but never cluttered. A first-time visitor should understand "where is burning right now, and how badly" within three seconds of the map loading, then be able to drill into any region, filter by intensity, and scrub through time to watch fires evolve.

This is a single-page web app. It is trivially wrappable in Tauri later (it's a plain React SPA), but **do not** build the desktop shell in this pass.

> **⚡ Top priority: visual spectacle.** The single most important goal is that this looks *stunning* — a dark, rotating Earth in space covered in glowing live fires. Wow factor beats every other consideration except correctness of the data. The "wow" features in §5.7 are **core requirements, not optional polish.** When a tradeoff arises between "more spectacular" and "more conventional," choose spectacular (as long as the data stays accurate and the thing stays usable).

---

## 2. Tech stack (opinionated — do not substitute without asking)

| Concern | Choice | Why |
|---|---|---|
| Framework | **React 18 + TypeScript + Vite** | Fast, familiar, SPA-native |
| Base map | **MapLibre GL JS** via `react-map-gl` (maplibre mode) | Open-source, vector tiles, no vendor lock |
| Data rendering | **deck.gl** (`@deck.gl/react`, `@deck.gl/layers`, `@deck.gl/aggregation-layers`) interleaved over MapLibre via `MapboxOverlay` | **Non-negotiable.** A single day of global VIIRS data is 30k–100k+ points. DOM/SVG markers will die. deck.gl renders this on the GPU. |
| Data fetching / cache | **TanStack Query (React Query)** | Refetch intervals, stale-while-revalidate, request dedup |
| UI state | **Zustand** | Lightweight store for filters, layer toggles, time range |
| Styling | **Tailwind CSS** | Fast iteration on the glassy dark UI |
| Backend proxy | **Hono** (runs on Node/Bun/CF Workers/Vercel edge) — *optional, see §4* | Holds the FIRMS key, caches + converts CSV→binary |
| Icons | **lucide-react** | Consistent line icons |

---

## 3. Data sources (the core of the app — get these exactly right)

### 3.1 NASA FIRMS — active fire hotspots (primary layer)

Raw satellite fire detections, near-real-time. This is the "heat" of the map.

- **Endpoint (CSV):**
  `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{AREA}/{DAY_RANGE}/{DATE}`
  - `{SOURCE}` ∈ `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `VIIRS_SNPP_NRT`, `MODIS_NRT`, `LANDSAT_NRT`. **Default to `VIIRS_NOAA20_NRT`** (best resolution/coverage balance). Let the user switch source.
  - `{AREA}` = `west,south,east,north` bounding box, **or** the literal string `world`.
  - `{DAY_RANGE}` = integer 1–10 (days back from today).
  - `{DATE}` = optional `YYYY-MM-DD` start date for historical windows. Omit for "most recent."
- **Auth:** free `MAP_KEY`, emailed on signup at `https://firms.modaps.eosdis.nasa.gov/api/map_key/`. Rate limit: **5000 transactions / 10-minute window** (a multi-day world query counts as several). `TODO(frank): register a MAP_KEY and drop it in the env.`
- **Quota check endpoint:** `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY={MAP_KEY}` → JSON with `current_transactions` / `transaction_limit`. Surface this in a dev/debug corner so we don't blow the quota during testing.
- **Latency:** NRT = within ~60 min of satellite overpass. URT (US/Canada) can be < 60 sec.
- **Response columns (VIIRS):** `latitude, longitude, bright_ti4, scan, track, acq_date, acq_time, satellite, instrument, confidence, version, bright_ti5, frp, daynight`
  - MODIS differs slightly: `brightness` + `bright_t31` instead of the `bright_ti*` pair.
  - **`frp`** = Fire Radiative Power (megawatts) — **this is the intensity signal. Drive color and point size from it.**
  - **`confidence`**: for VIIRS it's categorical `l`/`n`/`h` (low/nominal/high); for MODIS it's numeric `0–100`. Normalize both to a 0-2 scale internally so the confidence filter works across sources.
  - `daynight` = `D`/`N`.

### 3.2 NASA EONET v3 — curated named fire events (secondary layer)

Human/agency-curated named incidents (e.g. "Wildfire in Republic of Korea"). Gives the map recognizable, clickable *named events* on top of the raw hotspot haze. No API key, CORS-friendly — **call this directly from the client.**

- **Endpoint (GeoJSON):**
  `https://eonet.gsfc.nasa.gov/api/v3/events/geojson?category=wildfires&status=open&days={N}&limit={N}`
- **Richer non-geojson variant** (has `sources[]` with links to the originating agency): `https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open`
- Returns a `FeatureCollection`; each feature has `geometry.coordinates`, `properties.title`, `properties.date`, and source links (GDACS, provincial fire services, etc.). Render these as distinct pin/icon markers, visually separate from the hotspot heat, with a rich detail card on click that includes the source agency link.

### 3.3 Optional stretch source — fire perimeters

Polygon burn perimeters are **not** available from one clean global feed. If pursued (stretch only): NIFC ArcGIS for US perimeters, GWIS/EFFIS for Europe. Do not block the core build on this. `TODO(frank): decide if perimeters are in scope — recommend deferring.`

---

## 4. Architecture & the API-key decision

FIRMS requires a `MAP_KEY` that **must not** ship in client JS, and a single world query is a large payload you don't want every visitor re-fetching. Two paths — pick per `TODO(frank)` below:

**Path A — Production (recommended default):** a thin **Hono proxy** with three jobs:
1. Holds `MAP_KEY` server-side; exposes `/api/hotspots?source=&bbox=&days=` to the client.
2. **Caches** each `(source, bbox, days)` response in memory/edge KV for **10–15 min** (FIRMS data doesn't change faster than satellite passes, and the world payload is identical for every user — this single decision protects the quota and makes the app feel instant).
3. Converts CSV → a compact JSON or, ideally, a **binary/typed-array** payload deck.gl can consume directly (lat/lon/frp/confidence/timestamp as parallel `Float32Array`s). This slashes transfer size vs raw CSV.

**Path B — Quick/personal:** client-only, `MAP_KEY` in a `.env` (accept that it's exposed), CSV parsed in-browser with `papaparse`. Fine for a private tool, **not** for anything public.

`TODO(frank): choose Path A (public/production) or Path B (personal). Default to A unless you're just kicking the tires.`

EONET is called directly from the client in both paths.

---

## 5. Feature & UX spec

This is where "intuitive / professional / eye-catching" gets made concrete. Build all of §5.1–§5.6.

### 5.1 The map itself
- Dark vector basemap (see §6). **Globe projection is the default and primary view** (MapLibre supports it) — a dark Earth floating in space, ringed by a faint atmospheric halo, over a starfield. This is the app's signature look; everything else serves it. Offer flat Web Mercator as a *secondary* toggle for regional drill-down where flat is genuinely easier to read.
- **Two-tier hotspot rendering that swaps on zoom** (this is the core intuitiveness trick):
  - **Low zoom (≤ ~5):** deck.gl `HeatmapLayer` weighted by `frp` → instantly answers "where is burning" as glowing density blooms.
  - **High zoom (> ~5):** deck.gl `ScatterplotLayer` → individual detections, **radius scaled by `frp`**, **color ramped by `frp`** (see §6 palette), slight glow. Optionally offer a `HexagonLayer` aggregation mode as a third view.
  - Cross-fade between layers at the threshold; don't hard-cut.
- Named EONET events as a separate always-on `IconLayer` with labels at higher zooms.

### 5.2 Time control (the standout feature)
- A **time-range slider (1–10 days)** plus a **playback button** that animates day-by-day, so you watch a fire front spread. "Last updated" timestamp + a live countdown to next auto-refresh.
- Animating the time window is the single most impressive interaction — prioritize making it smooth.

### 5.3 Filter & layer panel (left, glassy, collapsible)
- Source selector (VIIRS N20 / N21 / SNPP / MODIS / Landsat).
- **FRP intensity** min-threshold slider (hide the smallest detections to cut noise).
- **Confidence** filter (low/nominal/high — normalized across sources per §3.1).
- Day/night toggle.
- Layer toggles: Heatmap · Points · Named Events · Basemap style · Globe/flat.
- All filters apply live via GPU updates — no refetch unless source/day-range changes.

### 5.4 Stats panel (right, glassy)
- Total active detections in current view / worldwide.
- Breakdown by continent or country (bar list).
- Top 5 highest-FRP detections right now (jump-to on click).
- "New since last refresh" counter.

### 5.5 Detail card (on click)
- **Hotspot:** coordinates, FRP (MW), brightness, confidence, satellite/instrument, acquisition date+time (UTC and local), day/night.
- **Named event:** title, date, category, and **source-agency links** from EONET.

### 5.6 Chrome & niceties
- Geocoder search box to jump to any place (`maplibre-gl-geocoder` + a free geocoding provider — `TODO(frank): geocoder provider, or drop search for v1`).
- Legend (FRP color ramp + marker key), auto-refresh indicator, subtle loading shimmer, graceful empty/error states ("FIRMS quota reached — retrying in Xs").
- Fully responsive; panels dock to a bottom sheet on mobile.

### 5.7 Signature "wow" moments (TOP PRIORITY — this is what makes people stop and stare)
These are **core requirements**, built early, not deferred to polish:
- **Cinematic entrance.** On load, the camera eases in from high orbit onto the dark, atmosphere-haloed globe while hotspot data streams in and *ignites* across the surface. No plain spinner — a reveal. Should feel like booting a satellite feed.
- **Idle auto-rotation.** When the user isn't interacting, the globe slowly, smoothly rotates; any interaction pauses it instantly and it resumes after a few seconds of inactivity. (Soften or disable on mobile.)
- **Fires as light at night.** Render hotspots with **additive blending** so on the night hemisphere they glow like real points of light against the dark Earth — the live-fire answer to NASA's "Earth at Night / Black Marble." This is the single most striking view in the whole app; make it sing.
- **Bloom / glow post-processing.** Apply a deck.gl `PostProcessEffect` bloom pass so dense fire clusters shimmer and bleed light instead of reading as flat dots. Biggest wow, biggest cost — gate behind the quality setting in §8.
- **Real-time day/night terminator.** Shade the night hemisphere (compute solar position → semi-transparent overlay). Highest effort-to-wow of the set, but paired with night-side glowing fires it's unforgettable. If time-boxed, ship globe + atmosphere + bloom first and add the terminator last (it's flagged in Phase 4, can slip to Phase 5).
- **Starfield backdrop.** Real space behind the globe, not flat black — sells the "from orbit" feeling.

---

## 6. Visual design direction

Aim: **mission-control / observatory**, not consumer-cheerful. It should look like something a wildfire agency would actually run on a wall display.

- **The globe in space:** near-black deep navy (`#0a0e1a`-ish) dark basemap; muted landmasses, dim labels, no visual competition with the fire data. A faint blue-white **atmospheric halo** at the globe's limb, a subtle **starfield** behind it, and additive **bloom** on the fire data so the whole thing reads as a live planet glowing from orbit.
- **Fire intensity ramp (by FRP), ember→white-hot:** deep red `#7f1d1d` → orange-red `#dc2626` → amber `#f59e0b` → hot yellow `#fde047` → white-hot core `#fff7ed`. Low FRP = deep red, extreme FRP = white-hot. Add a soft additive glow/bloom on points so clusters shimmer.
- **UI panels:** glassmorphism — translucent dark glass, subtle blur, 1px hairline borders with a faint warm glow on active controls. **Monospace** (e.g. JetBrains Mono) for all numeric readouts (coordinates, FRP, counts) — sells the "instrument" feel.
- **Named-event markers:** a cool accent (soft cyan/white) so curated events stand out against the warm hotspot field.
- Restrained motion: gentle pulse on the highest-FRP fires, smooth camera eases, no gratuitous animation.
- *(Frank — this is deliberately close to your ReFx glassy look but with the accent shifted from blue to ember for the fire data. If you'd rather keep the ReFx blue accent for chrome and reserve warm tones strictly for fire, say so and the agent will split it that way.)*

---

## 7. Phased implementation plan

Execute in order. **Stop for review after each phase.**

### Phase 0 — Scaffold & spike
- Vite + React + TS + Tailwind project. Resolve every `TODO(frank)`.
- Render a MapLibre dark basemap full-bleed **in globe projection, with atmosphere + starfield** (globe is the default, not a toggle).
- Hardcode a single FIRMS world VIIRS request (Path A proxy stub or Path B client) and dump raw detections into a deck.gl `ScatterplotLayer` — ugly is fine.
- **Acceptance:** app boots to a dark Earth in space; real hotspots from live FIRMS data appear across the globe. Data is confirmed *live*, not mocked.

### Phase 1 — Rendering engine + the "wow" core
- Two-tier heatmap↔scatterplot swap on zoom with cross-fade.
- FRP-driven color ramp + size; **additive blending** so fires glow as points of light.
- **Bloom post-processing** (deck.gl `PostProcessEffect`) wired up behind the §8 quality setting.
- **Idle auto-rotation** of the globe + the **cinematic camera-in-from-orbit entrance** on load.
- Normalize confidence across sources; parse `acq_date`/`acq_time` into real timestamps.
- (Path A) proxy caching + CSV→typed-array conversion working.
- **Acceptance:** globe boots with the entrance animation, auto-rotates when idle, and fires glow (bloom on) against the dark Earth; smooth 60fps pan/zoom on a full world dataset with heatmap at low zoom and sized+colored points at high zoom; no main-thread jank.

### Phase 2 — Controls & filters
- Left filter/layer panel; source, FRP, confidence, day/night, layer toggles — all live GPU updates.
- Basemap style switcher + globe/flat toggle.
- **Acceptance:** every filter updates the map instantly; changing source/day-range refetches (and hits cache on repeat); no full reload.

### Phase 3 — Time & named events
- Time-range slider (1–10 days) + day-by-day playback animation.
- EONET named-events `IconLayer` + labels; distinct styling.
- Auto-refresh (10–15 min) with "last updated" + countdown.
- **Acceptance:** scrubbing/playing time animates detections smoothly; named events clickable; auto-refresh visibly updates without a hard reload.

### Phase 4 — Panels, detail, polish
- Stats panel (totals, by-region, top-FRP, new-since-refresh).
- Detail cards for hotspots and named events (with EONET source links).
- Legend, geocoder search, loading/empty/error states, full responsive + mobile bottom sheet.
- **Real-time day/night terminator** shading the night hemisphere (§5.7) — the last big wow piece. Can slip to Phase 5 if it's fighting the schedule, but it's the payoff shot alongside night-side glowing fires.
- Final visual polish per §6.
- **Acceptance:** clicking anything shows correct details; stats match visible data; graceful behavior on quota-exhaustion and network failure; looks like §6 on desktop and mobile.

### Phase 5 (optional/stretch)
- Perimeter polygons (US/EU), country-level fire-count choropleth, shareable deep-links (`?bbox=&source=&days=`), CSV/GeoJSON export of current view, Tauri desktop wrapper.

---

## 8. Performance requirements (hard constraints)
- Must stay interactive (target 60fps pan/zoom) with **100k+ detections** loaded. If it can't, that's a rendering bug, not a data-volume excuse.
- All hotspot styling (color/size/filter) via deck.gl accessors/GPU — **never** re-render React per point.
- (Path A) FIRMS responses cached ≥10 min server-side; client refetches only on source/day-range change or the auto-refresh tick.
- Prefer binary/typed-array payloads over CSV/JSON over the wire.
- Debounce map-move-driven bbox refetches.
- **Quality setting (High / Balanced / Performance)** that scales bloom intensity, point glow, atmosphere, and max rendered points. Bloom + globe + 100k points is the heaviest combo — Performance mode drops bloom and decimates points. Auto-detect on first load and default to Balanced; never ship a High default that stutters on a weak GPU. The wow is only wow if it's smooth.

## 9. TODO(frank) — resolve before Phase 1
- [ ] `MAP_KEY` from FIRMS registered and in env.
- [ ] Path A (production proxy) vs Path B (client-only). *Recommend A.*
- [ ] Basemap provider + any token: CARTO dark-matter or **OpenFreeMap** (both zero-key) to start; MapTiler (free key) if you want a satellite basemap option. *Recommend OpenFreeMap or CARTO for v1.*
- [ ] Geocoder provider for search, or cut search from v1.
- [ ] Project/brand name + accent decision (ember-only vs keep ReFx blue for chrome — see §6).
- [ ] Deploy target (Vercel / CF Pages / your VPS). Affects whether the proxy is an edge function or a Node service.

## 10. Explicitly out of scope for this pass
- User accounts / auth, alerting/notifications, historical archives beyond FIRMS's 10-day window, the Tauri desktop shell, and global perimeter polygons (all Phase 5+ or later briefs).

---

### Data attribution (put in the UI footer)
"Active fire data: NASA FIRMS (MODIS/VIIRS). Named events: NASA EONET." Both are free/open; attribution is required and also just looks legit.
