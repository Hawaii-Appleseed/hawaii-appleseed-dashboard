import './map/perfFlags.js'; // must be first — applies CSS kills before paint
import { loadConfig, loadRepData } from './data/loader.js';
import { initColors, listSchemes } from './map/colors.js';
import { createMap, getMap, fitHome } from './map/mapInstance.js';
import { setLayer, setVariable, setColorScheme, setReliability, setMillionairesOverlay, getFeatureProperties, initLayerManager, setSelectionFocus, getCurrentLevel, KNOWN_LEVELS } from './map/layerManager.js';
import { initPopup, clearSelectedLayer } from './map/popup.js';
import { initDiag } from './map/diag.js';
import { initLegend, renderLegend } from './ui/legend.js';
import { initSidebar, renderSidebar } from './ui/sidebar.js';
import { initInfoPanel, showInfoPanel, hideInfoPanel } from './ui/infoPanel.js';
import { initAreaSearch } from './ui/areaSearch.js';
import { getState, setState, subscribe } from './state/store.js';
import { readFromUrl, writeToUrl } from './state/urlSync.js';

// Detect iframe embedding — drives the "Open" button and the legend's reduced
// controls. Also honors ?embed=1 so the embed view can be previewed without an
// iframe.
function detectEmbedded() {
  let embedded = false;
  try { embedded = window.self !== window.top; } catch (_) { embedded = true; }
  return embedded || /[?&]embed=1\b/.test(window.location.search);
}

async function main() {
  const [config, repData] = await Promise.all([loadConfig(), loadRepData()]);
  const isEmbedded = detectEmbedded();
  initColors(config.theme, config.variables);
  initLegend(config.variables, { embedded: isEmbedded });
  initSidebar(config.variables);
  initInfoPanel(config.variables);
  initAreaSearch();
  initPopup(config.variables, repData);
  initLayerManager(config.variables);

  createMap('main-map', config.theme);
  // Diagnostics are opt-in via URL param (?diag=1) to avoid an always-on
  // capture-phase mousemove listener + perpetual rAF FPS sampler.
  if (typeof window !== 'undefined' && /[?&]diag=1\b/.test(window.location.search)) {
    initDiag();
  }

  readFromUrl({
    activeLayer: KNOWN_LEVELS,
    colorScheme: listSchemes(),
    selectedVariable: Object.entries(config.variables.variables)
      .filter(([, v]) => v.show_in_dropdown)
      .map(([key]) => key),
  });
  const s0 = getState();

  // The circles are shown for either reason: the user checked "Show
  // millionaires", or Millionaires IS the selected variable (picked from the
  // Economic Security dropdown / the ?var=millionaires embed link). Muting of
  // the choropleth is derived from the latter inside layerManager, so this is
  // the only place the two entry points need to be OR'd together.
  const millionairesVisible = (state) =>
    state.showMillionaires || state.selectedVariable === 'millionaires';

  // The geography picks the scale for variables with one per level. (Not
  // getCurrentLevel(): on first load setLayer returns before the map has
  // applied the level.)
  const drawLegend = (state) => renderLegend(state.selectedVariable, state.colorScheme, state.activeLayer);

  subscribe(async (state, changed) => {
    if ('selectedFeatureId' in changed) {
      setSelectionFocus(!!state.selectedFeatureId);
      if (!state.selectedFeatureId) clearSelectedLayer();
    }
    if ('activeLayer' in changed) {
      // The panel describes an area of the old geography; close it.
      hideInfoPanel();
      const level = state.activeLayer;
      try {
        await setLayer(level);
      } catch (err) {
        // Couldn't load it (offline?): go back to the geography still on the
        // map, so the controls match it and picking this one again retries.
        console.error(`Couldn't load the ${level} layer:`, err);
        if (getState().activeLayer === level && getCurrentLevel()) {
          setState({ activeLayer: getCurrentLevel() });
        }
        return;
      }
      setVariable(state.selectedVariable);
      setColorScheme(state.colorScheme);
      drawLegend(state);
    }
    if ('selectedVariable' in changed) {
      setVariable(state.selectedVariable);
      // Must follow setVariable: layerManager derives variable-vs-overlay mode
      // (mute + circle colors) from the now-current variable.
      setMillionairesOverlay(millionairesVisible(state));
      drawLegend(state);
      // If a geo is selected and the info panel is open, re-render it so the
      // headline reflects the newly chosen variable.
      const panel = document.getElementById('info-panel');
      if (state.selectedFeatureId && panel?.classList.contains('visible')) {
        const props = getFeatureProperties(state.selectedFeatureId);
        if (props) showInfoPanel(props);
      }
    }
    if ('colorScheme' in changed) {
      setColorScheme(state.colorScheme);
      drawLegend(state);
    }
    if ('showReliability' in changed) {
      setReliability(state.showReliability);
      drawLegend(state);
    }
    if ('showMillionaires' in changed) {
      setMillionairesOverlay(millionairesVisible(state));
      drawLegend(state);
    }
    writeToUrl();
    // Only these two show in the bar. Re-rendering it replaces its buttons,
    // which would drop keyboard focus on unrelated changes (e.g. closing the
    // info panel with Escape).
    if ('activeLayer' in changed || 'selectedVariable' in changed) renderSidebar();
  });

  await setLayer(s0.activeLayer);
  setVariable(s0.selectedVariable);
  setColorScheme(s0.colorScheme);
  setReliability(s0.showReliability);
  setMillionairesOverlay(millionairesVisible(s0));
  drawLegend(s0);
  renderSidebar();
  writeToUrl();

  // No background preload: it was causing main-thread contention (worker tile
  // messages during user interaction → micro-stutters). Layers load on-demand
  // when the user switches; the network fetch is fast enough.

  // Tab labels from ui_strings.json (the icon stays).
  const tabs = config.uiStrings?.tabs || {};
  function setTabText(btn, fullLabel) {
    if (!btn || !fullLabel) return;
    // Strip leading emoji (everything before the first space after a non-letter char)
    const text = fullLabel.replace(/^[\p{Emoji}\s]+/u, '').trim() || fullLabel;
    const label = btn.querySelector('.seg-label');
    if (label) label.textContent = text;
  }
  setTabText(document.querySelector('.main-tab[data-tab="map"]'), tabs.map);
  setTabText(document.querySelector('.main-tab[data-tab="data"]'), tabs.data);

  if (isEmbedded) {
    document.body.classList.add('is-embedded');

    // "Open" button: visible only when embedded.
    const fsBtn = document.getElementById('fullscreen-btn');
    if (fsBtn) {
      fsBtn.hidden = false;
      fsBtn.addEventListener('click', () => {
        window.open(window.location.href, '_blank', 'noopener');
      });
    }
  }

  // The controls bar, legend and embed styling are all in place now, and each
  // changes how much of the map is visible — so settle the starting view here.
  fitHome();

  // Tab switching
  document.querySelectorAll('.main-tab').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.main-tab').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      document.getElementById('tab-map').hidden = tab !== 'map';
      document.getElementById('tab-data').hidden = tab !== 'data';
      if (tab === 'map') {
        const map = getMap();
        if (map) map.resize();
      }
      if (tab === 'data') {
        await openDataTab(config);
      }
    });
  });
}

// The Data tab brings in Plotly (~1.4 MB gzipped, most of the app's JS), so it
// loads the first time the tab opens instead of with the map.
let analysisModule = null;
async function openDataTab(config) {
  const chartEl = document.getElementById('da-chart');
  if (!analysisModule) {
    if (chartEl) chartEl.innerHTML = '<p class="da-loading">Loading…</p>';
    analysisModule = import('./analysis-main.js');
  }
  try {
    const { initAnalysis } = await analysisModule;
    await initAnalysis(config);
  } catch (err) {
    analysisModule = null; // let the next click retry
    console.error('Data tab failed to load:', err);
    if (chartEl) {
      chartEl.innerHTML = '<p class="da-error">Couldn’t load the data view. Check your connection and try again.</p>';
    }
  }
}

main().catch((err) => {
  console.error('Dashboard init failed:', err);
  const root = document.querySelector('.map-wrap');
  if (root) {
    // Built from text nodes: the message can carry text from the URL.
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    const detail = document.createElement('small');
    detail.textContent = import.meta.env.DEV
      ? `${err.message} — make sure the data pipeline has run: bash ../scripts/build_static/run_all.sh`
      : err.message;
    banner.append('Couldn’t load the dashboard. Check your connection and reload the page.', document.createElement('br'), detail);
    root.replaceChildren(banner);
  }
});
