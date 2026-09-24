import { loadConfig, loadLayer } from './data/loader.js';
import { renderChart, renderFullTable } from './analysis/charts.js';
import { getState, setState } from './state/store.js';

const LAYERS = [
  { key: 'state', label: 'State Boundary' },
  { key: 'county', label: 'Counties' },
  { key: 'house', label: 'House Districts' },
  { key: 'senate', label: 'Senate Districts' },
];

let config = null;
let activeLayer = 'county';
let activeVar = 'poverty_rate';
let initialized = false;
let layerSel = null;
let varSel = null;
let refreshId = 0; // the latest refreshChart call; older ones drop their result
// Inside the dashboard the Data tab shares the map's geography and variable:
// it opens on whatever the map shows, and a change here carries back to the
// map. (The standalone data-analysis.html page has no map and reads ?layer=
// and ?var= instead.)
let linkedToMap = false;

// Called every time the dashboard's Data tab opens.
export async function initAnalysis(sharedConfig) {
  linkedToMap = true;
  config = config || sharedConfig || await loadConfig();
  const s = getState();
  const layer = LAYERS.some((l) => l.key === s.activeLayer) ? s.activeLayer : activeLayer;
  // Map-only variables (the Millionaires markers) have no Data view, so keep
  // the tab's own pick for those, without touching the map's.
  const variable = isChartable(s.selectedVariable) ? s.selectedVariable : activeVar;
  const changed = layer !== activeLayer || variable !== activeVar;
  activeLayer = layer;
  activeVar = variable;
  if (!initialized) {
    initialized = true;
    buildControls();
    await refreshChart();
  } else if (changed) {
    layerSel.value = activeLayer;
    varSel.value = activeVar;
    await refreshChart();
  }
}

// Whether a variable is offered in the Data tab (see buildControls).
function isChartable(key) {
  const v = config.variables?.variables?.[key];
  return !!v && v.show_in_dropdown && v.render_type !== 'points';
}

async function main() {
  config = await loadConfig();
  const params = new URLSearchParams(window.location.search);
  if (params.get('layer')) activeLayer = params.get('layer');
  if (params.get('var')) activeVar = params.get('var');

  buildControls();
  await refreshChart();
}

function buildControls() {
  const root = document.getElementById('da-controls');
  if (!root) return;

  const vars = config.variables?.variables || {};
  const groups = config.variables?.dropdown_groups || {};

  // Layer selector
  layerSel = document.createElement('select');
  layerSel.className = 'da-select';
  layerSel.innerHTML = LAYERS.map((l) => `<option value="${l.key}" ${l.key === activeLayer ? 'selected' : ''}>${l.label}</option>`).join('');
  layerSel.addEventListener('change', async () => {
    activeLayer = layerSel.value;
    if (linkedToMap) setState({ activeLayer });
    await refreshChart();
  });

  // Variable selector — grouped optgroups
  varSel = document.createElement('select');
  varSel.className = 'da-select da-select-wide';
  const byGroup = {};
  for (const [key, v] of Object.entries(vars)) {
    if (!v.show_in_dropdown) continue;
    // Points variables (Millionaires) are town-level markers, not a value per
    // county/district — there is nothing to rank or tabulate by geography, so
    // they'd render an all-empty chart and table. Map-only by design.
    if (v.render_type === 'points') continue;
    if (!byGroup[v.dropdown_group]) byGroup[v.dropdown_group] = [];
    byGroup[v.dropdown_group].push({ key, ...v });
  }
  for (const [grpKey, items] of Object.entries(byGroup)) {
    const label = groups[grpKey]?.label || grpKey;
    const og = document.createElement('optgroup');
    og.label = label;
    items.sort((a, b) => (a.dropdown_order || 999) - (b.dropdown_order || 999));
    for (const v of items) {
      const opt = document.createElement('option');
      opt.value = v.key;
      opt.textContent = v.dropdown_label || v.display_name;
      if (v.key === activeVar) opt.selected = true;
      og.appendChild(opt);
    }
    varSel.appendChild(og);
  }
  varSel.addEventListener('change', async () => {
    activeVar = varSel.value;
    if (linkedToMap) setState({ selectedVariable: activeVar });
    await refreshChart();
  });

  root.innerHTML = '';
  const layerWrap = document.createElement('label');
  layerWrap.className = 'da-label';
  layerWrap.textContent = 'Geography: ';
  layerWrap.appendChild(layerSel);

  const varWrap = document.createElement('label');
  varWrap.className = 'da-label';
  varWrap.textContent = 'Variable: ';
  varWrap.appendChild(varSel);

  root.appendChild(layerWrap);
  root.appendChild(varWrap);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshChart() {
  const id = ++refreshId;
  const chartEl = document.getElementById('da-chart');
  const tableEl = document.getElementById('da-side-table');
  const fullTableEl = document.getElementById('da-full-table');
  if (chartEl) chartEl.innerHTML = '<p class="da-loading">Loading…</p>';
  if (tableEl) tableEl.innerHTML = '';
  if (fullTableEl) fullTableEl.innerHTML = '';
  document.querySelector('.da-caption')?.remove();

  try {
    const [geojson, stateGeojson] = await Promise.all([
      loadLayer(activeLayer),
      activeLayer !== 'state' ? loadLayer('state') : Promise.resolve(null),
    ]);
    if (id !== refreshId) return; // a newer pick is already loading

    const varMeta = config.variables?.variables?.[activeVar];
    const layerLabel = LAYERS.find((l) => l.key === activeLayer)?.label || activeLayer;

    if (chartEl) chartEl.innerHTML = '';

    renderChart(
      'da-chart',
      'da-side-table',
      geojson.features,
      activeVar,
      varMeta,
      layerLabel,
      stateGeojson?.features || null,
    );

    renderFullTable('da-full-table', geojson.features, config.variables, activeLayer);
  } catch (err) {
    console.error('Analysis error:', err);
    if (chartEl) chartEl.innerHTML = `<p class="da-error">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// Only auto-run on the standalone data-analysis.html page
if (document.getElementById('da-standalone')) {
  main().catch(console.error);
}
