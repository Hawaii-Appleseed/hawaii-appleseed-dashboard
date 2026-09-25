import { fetchJson } from './data/loader.js';
import { buildGeoData } from './factsheet/formatters.js';
import { generateFactSheetHTML } from './factsheet/template.js';

const LEVELS = ['state', 'county', 'house', 'senate'];

// Messages are set as text: they can carry values from the URL.
function showError(root, message) {
  const p = document.createElement('p');
  p.className = 'fs-error';
  p.textContent = message;
  root.replaceChildren(p);
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  const geoId = params.get('geo_id');
  const level = params.get('level') || 'county';

  const root = document.getElementById('factsheet-root');

  if (!geoId || !LEVELS.includes(level)) {
    showError(root, 'No geography selected. Open this page from the map by clicking a region.');
    return;
  }

  try {
    const [geojson, stateSummary] = await Promise.all([
      fetchJson(`/data/${level}.geojson`),
      fetchJson('/data/state_summary.json').catch(() => ({})),
    ]);

    const feature = geojson.features.find(
      (f) => String(f.properties.GEOID) === String(geoId) || String(f.properties.geoid) === String(geoId),
    );

    if (!feature) {
      showError(root, `Geography not found: ${geoId}`);
      return;
    }

    const geo = buildGeoData(feature.properties, stateSummary);
    document.title = `Fact Sheet: ${geo.name}`;
    root.innerHTML = generateFactSheetHTML(geo);
  } catch (err) {
    console.error('Fact sheet error:', err);
    showError(root, `Failed to load fact sheet: ${err.message}`);
  }
}

main();
