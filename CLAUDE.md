---
name: hawaii-appleseed-dashboard
description: Interactive data dashboard for Hawaii Appleseed with maps and visualizations
---

# Hawaii Appleseed Data Dashboard

> **Default working branch: `rebuild` (NOT `main`).**
> Always start work on `rebuild` — check it out, pull, branch from, commit to,
> and push to it unless explicitly told otherwise. The active app is the
> **`web/` Vite frontend** (JS + MapLibre/Leaflet), not the legacy Streamlit app
> described below. `gh-pages` is the built deploy branch — don't hand-edit it.

## Variables: one file, checked

- Every map variable is defined in **`src/config/variables.json`** — edit only
  that. The web app's `/config/variables.json` is built from it by the Vite
  plugin in `web/scripts/variables-config.mjs`; the Python side reads it via
  `src/config/variable_registry.py`.
- Most fields can be left out. The defaults are listed at the top of
  `web/scripts/variables-config.mjs`; `_expand()` in `variable_registry.py`
  mirrors them, so change both together.
- Run `npm run check` in `web/` after editing. It fails on unknown or
  misspelled fields, bad group/category/data-source references, unsorted or
  too many `color_thresholds`, duplicate keys or dropdown orders, and any
  displayed variable missing from the built GeoJSON in `web/public/data/`.
  `vite build` and the deploy workflow run the same check.

An interactive data visualization dashboard built with Streamlit and Leaflet.js, visualizing demographics, economics, and policy data for Hawaii.

## Project Overview

- **Purpose**: Interactive dashboard for Hawaii Appleseed staff and partners to explore state, county, and district-level data
- **Stack**: Python, Streamlit, Leaflet.js, GeoJSON, CSV data
- **Entry point**: `run_leaflet.py`
- **Location**: `/Users/devinthomas/hawaii-appleseed-dashboard/`

## Key Components

### UI Layer
- `src/ui/leaflet_map_view.py` — Main interactive map interface
- `src/ui/leaflet_component.py` — Map rendering and interaction logic
- `src/ui/sidebar.py` — Filters and controls
- `src/ui/leaflet_legend.py` — Map legend
- `src/ui/enhanced_style.css` — Custom styling

### Data Layer
- `src/data/data_loader.py` — Loads and caches data (GeoJSON, CSV)
- Data sources: GeoJSON for boundaries, CSV for metrics
- Geographic levels: State, Counties, House Districts, Senate Districts

## Running the App

```bash
streamlit run run_leaflet.py
```

Access at `http://localhost:8501`

## Common Tasks

- Add new data layer (GeoJSON boundary + CSV metrics)
- Update color schemes or legends
- Fix data loading errors
- Improve map interactivity or performance

## Data Structure

Each visualization layer needs:
1. **GeoJSON file** — geographic boundaries (state, county, district)
2. **CSV file** — metrics keyed to geographic units
3. **Style config** — colors, legend, tooltips

## Style

- Accessible color schemes (colorblind-friendly when possible)
- Clear legends and tooltips
- Responsive to different screen sizes
- Fast load times (cache data)

## Development

- Use `src/` for modular components
- Keep data loading separate from UI logic
- Test with different data sizes
