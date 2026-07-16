# Ember 🔥🌍

**Live global wildfire monitoring map** — a dark, rotating Earth in space, covered in glowing
near-real-time fire detections from NASA satellites. Mission-control aesthetics, GPU rendering,
real data only.

> Build spec: [`docs/BRIEF.md`](docs/BRIEF.md) · Decisions log: [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Status

| Phase | Scope | State |
|---|---|---|
| **0 — Scaffold & spike** | Globe + atmosphere + starfield, live FIRMS world data on a deck.gl scatterplot, Path A proxy stub | ✅ done |
| **1 — Rendering engine + wow core** | heat-field↔points cross-fade, additive splat glow ("fires as light"), quality tiers, binary payloads, cinematic entrance, idle rotation | ✅ done |
| **2 — Controls & filters** | glassy filter panel: source switcher, FRP/confidence/day-night GPU filters, layer toggles, globe/flat, basemap, quality | ✅ done |
| **3 — Time & named events** | 1–10d window + histogram timeline + day-by-day playback (GPU age filter), EONET named events with detail cards, 10-min auto-refresh | ✅ done |
| 4 — Panels, detail, polish | stats, detail cards for hotspots, terminator, responsive | ⏳ next |

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

1. **Settings → Pages → Source: "GitHub Actions"** (the workflow also tries to
   enable this automatically on first run).
2. *(Optional)* add `FIRMS_MAP_KEY` as an **Actions secret** — it stays inside
   the runner and unlocks Landsat + the area API for the baked feed.
3. Scheduled runs only fire from the repo's **default branch**.

Site URL: `https://<user>.github.io/<repo>/`. Data freshness is the cron
cadence (+ queue jitter) on top of FIRMS's own ~1h NRT latency; tune the cron
in the workflow, staying under Pages' ~10 deploys/hour soft limit.

### Any Node host / Vercel / Cloudflare (live proxy)

`npm run build` + `npm start` serves the API on :8787 (put the SPA's `dist/`
behind any static host pointing `/api` at it). The Hono app in
`server/index.ts` ports to Vercel functions or CF Workers unchanged; move the
in-memory cache to edge KV if you deploy it serverless.

### Dev/test URL params

`?quality=high|balanced|performance` force a quality tier · `?stride=N` decimate
points · `?lat=&lon=&z=` jump the camera (skips the entrance) · `?debug=1` FPS +
render counts in the HUD.

## Data attribution

Active fire data: **NASA FIRMS** (MODIS/VIIRS) · Named events: **NASA EONET** ·
Basemap: © [CARTO](https://carto.com/attributions), © OpenStreetMap contributors.
