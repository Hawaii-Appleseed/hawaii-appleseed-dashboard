import './map/perfFlags.js'; // must be first — applies CSS kills before paint
import { loadConfig, loadRepData } from './data/loader.js';
import { initColors } from './map/colors.js';
import { createMap, getMap } from './map/mapInstance.js';
import { setLayer, setVariable, setColorScheme, setReliability, setMillionairesOverlay, getFeatureProperties, initLayerManager } from './map/layerManager.js';
import { initPopup } from './map/popup.js';
import { initDiag } from './map/diag.js';
import { initLegend, renderLegend } from './ui/legend.js';
import { initSidebar, renderSidebar } from './ui/sidebar.js';
import { initInfoPanel, showInfoPanel } from './ui/infoPanel.js';
import { getState, subscribe } from './state/store.js';
import { readFromUrl, writeToUrl } from './state/urlSync.js';

async function main() {
  const [config, repData] = await Promise.all([loadConfig(), loadRepData()]);
  initColors(config.theme, config.variables);
  initLegend(config.variables);
  initSidebar(config.variables);
  initInfoPanel(config.variables);
  initPopup(config.variables, repData);
  initLayerManager(config.variables);

  createMap('main-map', config.theme);
  // Diagnostics are opt-in via URL param (?diag=1) to avoid an always-on
  // capture-phase mousemove listener + perpetual rAF FPS sampler.
  if (typeof window !== 'undefined' && /[?&]diag=1\b/.test(window.location.search)) {
    initDiag();
  }

  readFromUrl();
  const s0 = getState();

  // The circles are shown for either reason: the user checked "Show
  // millionaires", or Millionaires IS the selected variable (picked from the
  // Economic Security dropdown / the ?var=millionaires embed link). Muting of
  // the choropleth is derived from the latter inside layerManager, so this is
  // the only place the two entry points need to be OR'd together.
  const millionairesVisible = (state) =>
    state.showMillionaires || state.selectedVariable === 'millionaires';

  subscribe(async (state, changed) => {
    if ('activeLayer' in changed) {
      await setLayer(state.activeLayer);
      setVariable(state.selectedVariable);
      setColorScheme(state.colorScheme);
      renderLegend(state.selectedVariable, state.colorScheme);
    }
    if ('selectedVariable' in changed) {
      setVariable(state.selectedVariable);
      // Must follow setVariable: layerManager derives variable-vs-overlay mode
      // (mute + circle colors) from the now-current variable.
      setMillionairesOverlay(millionairesVisible(state));
      renderLegend(state.selectedVariable, state.colorScheme);
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
      renderLegend(state.selectedVariable, state.colorScheme);
    }
    if ('showReliability' in changed) {
      setReliability(state.showReliability);
      renderLegend(state.selectedVariable, state.colorScheme);
    }
    if ('showMillionaires' in changed) {
      setMillionairesOverlay(millionairesVisible(state));
      renderLegend(state.selectedVariable, state.colorScheme);
    }
    writeToUrl();
    renderSidebar();
  });

  await setLayer(s0.activeLayer);
  setVariable(s0.selectedVariable);
  setColorScheme(s0.colorScheme);
  setReliability(s0.showReliability);
  setMillionairesOverlay(millionairesVisible(s0));
  renderLegend(s0.selectedVariable, s0.colorScheme);
  renderSidebar();
  writeToUrl();

  // No background preload: it was causing main-thread contention (worker tile
  // messages during user interaction → micro-stutters). Layers load on-demand
  // when the user switches; the network fetch is fast enough.

  // Update tab text nodes from ui_strings.json (preserves SVG icon child nodes)
  const tabs = config.uiStrings?.tabs || {};
  function setTabText(btn, fullLabel) {
    if (!btn || !fullLabel) return;
    // Strip leading emoji (everything before the first space after a non-letter char)
    const text = fullLabel.replace(/^[\p{Emoji}\s]+/u, '').trim();
    const textNode = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (textNode) textNode.textContent = ' ' + (text || fullLabel);
  }
  setTabText(document.querySelector('.main-tab[data-tab="map"]'), tabs.map);
  setTabText(document.querySelector('.main-tab[data-tab="data"]'), tabs.data);

  // Detect iframe embedding — drives both the "Open" button and layout tweaks.
  // Also honors ?embed=1 so the embed view can be previewed without an iframe.
  let isEmbedded = false;
  try { isEmbedded = window.self !== window.top; } catch (_) { isEmbedded = true; }
  if (!isEmbedded && /[?&]embed=1\b/.test(window.location.search)) {
    isEmbedded = true;
  }

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
      chartEl.innerHTML = '<p style="color:#c0392b;padding:20px">Couldn’t load the data view. Check your connection and try again.</p>';
    }
  }
}

main().catch((err) => {
  console.error('Dashboard init failed:', err);
  const root = document.querySelector('.map-wrap');
  if (root) {
    root.innerHTML = `<div class="error-banner">Failed to load dashboard: ${err.message}<br><small>Make sure the data pipeline has run: <code>bash ../scripts/build_static/run_all.sh</code></small></div>`;
  }
});
