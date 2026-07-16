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
| 2 — Controls & filters | source/FRP/confidence/day-night filters, layer toggles | ⏳ next |
| 3 — Time & named events | time slider + playback, EONET events, auto-refresh | — |
| 4 — Panels, detail, polish | stats, detail cards, terminator, responsive | — |

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

### Dev/test URL params

`?quality=high|balanced|performance` force a quality tier · `?stride=N` decimate
points · `?lat=&lon=&z=` jump the camera (skips the entrance) · `?debug=1` FPS +
render counts in the HUD.

## Data attribution

Active fire data: **NASA FIRMS** (MODIS/VIIRS) · Named events: **NASA EONET** ·
Basemap: © [CARTO](https://carto.com/attributions), © OpenStreetMap contributors.
