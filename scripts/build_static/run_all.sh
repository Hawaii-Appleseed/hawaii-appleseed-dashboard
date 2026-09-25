#!/usr/bin/env bash
# Run all build-time data pipeline scripts in order.
# Output goes to web/public/data/.
#
# The web app's config isn't built here: /config/variables.json comes from
# src/config/variables.json via the Vite plugin (web/scripts/variables-config.mjs),
# and theme.json and ui_strings.json are the web app's own, in
# web/public/config/. The files of those names in src/config/ are the
# Streamlit app's and differ (map view, tab labels).
set -euo pipefail

cd "$(dirname "$0")/../.."

PY="${PYTHON:-python3}"

echo "==> 02_build_layer_geojsons"
"$PY" scripts/build_static/02_build_layer_geojsons.py

echo "==> 03_build_state_summary"
"$PY" scripts/build_static/03_build_state_summary.py

echo "==> 04_build_rep_data"
"$PY" scripts/build_static/04_build_rep_data.py

echo "==> done"
