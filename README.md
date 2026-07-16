# Ember 🔥🌍

**Live global wildfire monitoring map** — a dark, rotating Earth in space, covered in glowing
near-real-time fire detections from NASA satellites. Mission-control aesthetics, GPU rendering,
real data only.

> Build spec: [`docs/BRIEF.md`](docs/BRIEF.md) · Decisions log: [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Status

| Phase | Scope | State |
|---|---|---|
| **0 — Scaffold & spike** | Globe + atmosphere + starfield, live FIRMS world data on a deck.gl scatterplot, Path A proxy stub | ✅ done |
| 1 — Rendering engine + wow core | heatmap↔points swap, additive glow, bloom, entrance animation, idle rotation | ⏳ next |
| 2 — Controls & filters | source/FRP/confidence/day-night filters, layer toggles | — |
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
one upstream fetch serves every visitor and quota is protected.

## Data attribution

Active fire data: **NASA FIRMS** (MODIS/VIIRS) · Named events: **NASA EONET** ·
Basemap: © [CARTO](https://carto.com/attributions), © OpenStreetMap contributors.
