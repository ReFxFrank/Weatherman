# Ember 🔥🌍

**Live hazard globes** — a dark, rotating Earth in space with selectable data globes: glowing
near-real-time fire detections from NASA satellites, live lightning from NOAA and EUMETSAT
geostationary sensors, US severe-weather warnings from the NWS, and tropical cyclones with
NHC forecast cones. Mission-control aesthetics, GPU rendering, real data only.

> Build spec: [`docs/BRIEF.md`](docs/BRIEF.md) · Decisions log: [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Status

| Phase | Scope | State |
|---|---|---|
| **0 — Scaffold & spike** | Globe + atmosphere + starfield, live FIRMS world data on a deck.gl scatterplot, Path A proxy stub | ✅ done |
| **1 — Rendering engine + wow core** | heat-field↔points cross-fade, additive splat glow ("fires as light"), quality tiers, binary payloads, cinematic entrance, idle rotation | ✅ done |
| **2 — Controls & filters** | glassy filter panel: source switcher, FRP/confidence/day-night GPU filters, layer toggles, globe/flat, basemap, quality | ✅ done |
| **3 — Time & named events** | 1–10d window + histogram timeline + day-by-day playback (GPU age filter), EONET named events with detail cards, 10-min auto-refresh | ✅ done |
| **4 — Panels, detail, polish** | live stats panel, hotspot detail cards + selection ring, real-time terminator with twilight bands, legend, Photon search, top-FRP pulse, error/empty/stale states, mobile bottom sheet | ✅ done |
| **5 — Stretch** | shareable deep links, CSV/GeoJSON export of the current view, country fire-count choropleth (Natural Earth), US perimeters (NIFC/WFIGS) | ✅ done (EU perimeters + Tauri deferred, see DECISIONS) |
| **6 — Multi-globe: lightning** | globe switcher framework (`?globe=`), live GOES GLM lightning (20-second granules, keyless public S3) + Meteosat MTG-LI (Europe/Africa, free EUMETSAT key), rolling 60-min window with fresh-strike blooms, per-satellite freshness HUD, coverage-honesty rings | ✅ done |
| **7 — Severe weather globe** | NWS tornado/severe warnings + watches (zone geometry resolved), SPC storm reports + Day-1 outlook shading, 60 s live poll, quiet-day honest empty states | ✅ done (US coverage; detail cards + timeline deferred) |
| **8 — Hardening + hurricanes globe** | globe registry (adding a globe = compile-checked checklist), shared display controls on every globe, NHC active storms + forecast cone/track/points + past track, EONET global storms (48 h phantom filter), Saffir-Simpson category ramp, cone-honesty legend | ✅ done |

## Stack

React 18 + TypeScript + Vite · MapLibre GL (globe projection) via react-map-gl ·
deck.gl over `MapboxOverlay` · TanStack Query · Zustand · Tailwind CSS ·
Hono API proxy (Path A).

## Quickstart

```bash
npm install
cp .env.example .env   # optional: add your FIRMS_MAP_KEY
npm run dev            # proxy on :8787 + Vite on :5173
```

Open http://localhost:5173.

### FIRMS data modes

The Hono proxy (`server/index.ts`) serves `/api/hotspots` in one of two modes:

- **`FIRMS_MAP_KEY` set** → FIRMS area API: any source, 1–10 day windows.
  Register a free key at <https://firms.modaps.eosdis.nasa.gov/api/map_key/>.
- **No key (default)** → FIRMS public keyless global feeds (same live detections;
  world-only, 24h/48h/7d windows; no LANDSAT).

Either way the data is live satellite output, never mocked. Responses are cached
in-memory for 10 minutes with single-flight dedup and stale-on-error fallback, so
one upstream fetch serves every visitor and quota is protected. Payloads travel
as binary typed arrays (~4 MB for 187k points vs ~9 MB as JSON) and feed deck.gl
directly — no client-side parsing.

## Deploying

### GitHub Pages (no server) — live feed via baked data

Pages can't run the proxy, so `.github/workflows/pages.yml` replaces it: on a
20-minute schedule (and every push to the default branch) it builds the SPA in
static mode, runs `scripts/bake-data.ts` to fetch live FIRMS data and write the
same binary payloads as static `/data/*.bin` files, and deploys everything to
Pages. The app then fetches those files instead of `/api/*` — still live data,
refreshed by the scheduler, served from the Pages CDN.

One-time setup:

1. **Settings → Pages → Source: "GitHub Actions"** — requires repo admin; the
   workflow token can't enable it. Until it's flipped, runs succeed but skip
   deployment with a notice; the next scheduled run then deploys automatically.
2. *(Optional)* add `FIRMS_MAP_KEY` as an **Actions secret** — it stays inside
   the runner and unlocks Landsat + the area API for the baked feed.
3. Scheduled runs only fire from the repo's **default branch**.

Site URL: `https://<user>.github.io/<repo>/`. Data freshness is the cron
cadence (+ queue jitter) on top of FIRMS's own ~1h NRT latency; tune the cron
in the workflow, staying under Pages' ~10 deploys/hour soft limit.

### Ubuntu VPS (live proxy — freshest mode)

One process serves everything: `npm start` hosts the built SPA *and* the API,
and data live-updates by design — browsers refetch every 10 minutes, the
server fetches FIRMS at most once per 10 minutes no matter how many visitors
(single-flight cache, stale-on-error), EONET refreshes client-side. No cron.

```bash
# Ubuntu 22.04/24.04, Node 20+ (e.g. via apt or nvm)
git clone https://github.com/ReFxFrank/Weatherman.git && cd Weatherman
npm ci && npm run build
cp .env.example .env        # optional: add FIRMS_MAP_KEY (stays server-side)
PORT=8787 npm start         # app + api on :8787
```

Keep it alive with systemd (`/etc/systemd/system/ember.service`):

```ini
[Unit]
Description=Ember wildfire map
After=network-online.target

[Service]
WorkingDirectory=/opt/Weatherman
ExecStart=/usr/bin/npm start
Restart=always
EnvironmentFile=/opt/Weatherman/.env

[Install]
WantedBy=multi-user.target
```

For TLS put Caddy (`reverse_proxy 127.0.0.1:8787` — automatic certificates)
or nginx+certbot in front. Code updates: `git pull && npm ci && npm run build
&& systemctl restart ember` (or wire a GitHub Action over SSH later).

### Vercel / Cloudflare (live proxy, serverless)

The Hono app in `server/index.ts` ports to Vercel functions or CF Workers
unchanged; move the in-memory cache to edge KV if you deploy it serverless.

### Deep links & dev params

The URL mirrors the view — copy the address bar to share it:
`?globe=lightning|severe|hurricanes` data globe · `?lat=&lon=&z=` camera (skips the entrance) ·
`?source=` · `?days=1..10` · `?frp=` min FRP · `?conf=1|2` · `?dn=day|night`.

Dev/test extras: `?quality=high|balanced|performance` force a quality tier ·
`?stride=N` decimate points · `?debug=1` FPS/quota/render counts in the HUD.

## Data attribution

Active fire data: **NASA FIRMS** (MODIS/VIIRS) · Lightning: **NOAA GOES GLM**
(via the NOAA Open Data Dissemination S3 buckets) and **EUMETSAT Meteosat MTG-I1
Lightning Imager** ·
Severe weather: **NOAA NWS / SPC** · Hurricanes: **NOAA NHC** ·
Named events & global storms: **NASA EONET** · Basemap:
© [CARTO](https://carto.com/attributions), © OpenStreetMap contributors.
