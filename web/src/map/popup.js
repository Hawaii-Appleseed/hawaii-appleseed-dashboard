import { getState, setState } from '../state/store.js';
import { showInfoPanel } from '../ui/infoPanel.js';
import { getMap, releaseHome } from './mapInstance.js';
import { setShadowFeature } from './shadowLayer.js';
import { getFeatureById } from './layerManager.js';
import { FLAGS } from './perfFlags.js';
import { fadeHover, fadeFeatureState } from './featureFade.js';
import { cameraTrip } from './motion.js';

let VARIABLES = null;
let REP_DATA = {};

const boundLevels = new Set();
const boundPointsLayers = new Set();
let tooltipEl = null;
let hoveredFeature = null;       // { level, id }
let selectedFeature = null;      // { level, id }
let isAnimating = false;
let animationListenersBound = false;

// rAF throttle for tooltip position updates — caps layout reads+writes to
// the display refresh rate instead of raw mousemove rate (100–200 Hz).
let _moveRafId = null;
let _lastMovePoint = null;

// ?smooth=1 (perfFlags.js) tooltip timing. The first card waits a moment, so
// a pointer just crossing the map doesn't flash one; back within REGROUP_MS
// of one hiding, the next shows at once.
const SHOW_DELAY_MS = 70;
const REGROUP_MS = 300;
let showTimer = null;
let hiddenAt = -Infinity;
// ?smooth=1: where the pointer last was over the map (null once it leaves),
// and whether to re-hover there when the current pan or zoom stops.
let pointer = null;
let resyncAfterMove = false;
// ?smooth=1: areas drawn solid over the dimmed map (the -lift layer in
// layerManager.js), as `${level}|${id}` → { level, id }, and how long one
// takes to sink back once another area is picked.
const lifted = new Map();
const LIFT_DROP_MS = 250;

export function initPopup(variablesConfig, repData) {
  VARIABLES = variablesConfig.variables;
  REP_DATA = repData || {};
}

function ensureTooltipEl(map) {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'custom-tooltip map-tooltip';
  tooltipEl.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    'pointer-events:none',
    'z-index:1100',
    // ?smooth=1 fades and lifts the card in CSS instead (.is-smooth, app.css).
    ...(FLAGS.smooth ? [] : ['opacity:0', 'transition:opacity 0.12s ease-out']),
    'will-change:transform',
  ].join(';');
  if (FLAGS.smooth) tooltipEl.classList.add('is-smooth');
  const container = map.getContainer();
  container.appendChild(tooltipEl);
  return tooltipEl;
}

function hideTooltip() {
  if (!tooltipEl) return;
  if (FLAGS.smooth) {
    clearTimeout(showTimer);
    showTimer = null;
    if (tooltipEl.classList.contains('is-visible')) hiddenAt = performance.now();
    tooltipEl.classList.remove('is-visible');
    return;
  }
  tooltipEl.style.opacity = '0';
}

function showTooltip() {
  if (!tooltipEl) return;
  if (FLAGS.smooth) {
    if (showTimer || tooltipEl.classList.contains('is-visible')) return;
    if (performance.now() - hiddenAt < REGROUP_MS) {
      tooltipEl.classList.add('is-visible');
    } else {
      showTimer = setTimeout(() => {
        showTimer = null;
        tooltipEl.classList.add('is-visible');
      }, SHOW_DELAY_MS);
    }
    return;
  }
  tooltipEl.style.opacity = '1';
}

function ensureAnimationListeners(map) {
  if (animationListenersBound) return;
  map.on('movestart', () => {
    isAnimating = true;
    // ?smooth=1: a pan or zoom that starts over an area ends over another;
    // show that one when it stops rather than waiting for the pointer to move.
    resyncAfterMove = FLAGS.smooth && !!hoveredFeature;
    hideTooltip();
  });
  map.on('zoomstart', () => { isAnimating = true; hideTooltip(); });
  map.on('moveend', () => {
    isAnimating = false;
    if (resyncAfterMove) {
      resyncAfterMove = false;
      resyncHover(map);
    }
  });
  map.on('zoomend', () => { isAnimating = false; });
  if (FLAGS.smooth) {
    map.on('mousemove', (e) => { pointer = e.point; });
    map.on('mouseout', () => { pointer = null; });
  }
  animationListenersBound = true;
}

function cleanName(rawName) {
  let name = rawName || 'Unknown';
  name = name.replace(/[,;]\s*Hawaii/g, '').trim();
  name = name.replace(/\s*\(\d{4}\)\s*/g, '').trim();
  return name;
}

function formatValue(value, dataType) {
  if (value === undefined || value === null || value === '') return 'N/A';
  if (dataType === 'text') return String(value);
  const num = parseFloat(value);
  if (isNaN(num)) return String(value);
  if (dataType === 'percentage' || /rate|pct|percent/.test(dataType || '')) {
    return num.toFixed(1) + '%';
  }
  if (dataType === 'currency' || /income|value|benefit|amount/.test(dataType || '')) {
    return '$' + Math.round(num).toLocaleString();
  }
  if (dataType === 'minutes') return num.toFixed(1) + ' min';
  if (dataType === 'decimal') return num.toFixed(2);
  if (dataType === 'count') return num.toLocaleString();
  return num.toLocaleString();
}

export function lookupRep(properties, activeLayer) {
  if (activeLayer !== 'house' && activeLayer !== 'senate') return null;

  let key = null;
  if (properties.house_id) key = `house_${parseInt(properties.house_id, 10)}`;
  else if (properties.senate_id) key = `senate_${parseInt(properties.senate_id, 10)}`;
  else {
    const raw = properties.GEOID || properties.geoid || properties.id;
    if (raw != null) {
      let num;
      const str = String(raw);
      if (str.startsWith('150') && str.length === 5) {
        num = parseInt(str.slice(3), 10);
      } else {
        num = parseInt(str, 10);
      }
      if (!Number.isNaN(num)) key = `${activeLayer}_${num}`;
    }
  }
  if (key && REP_DATA[key]) {
    return { ...REP_DATA[key], title: key.startsWith('senate_') ? 'Senator' : 'Representative' };
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildTooltipContent(properties, level) {
  const s = getState();
  const name = cleanName(properties.display_name || properties.NAME || properties.name);
  const varKey = s.selectedVariable;
  const meta = VARIABLES?.[varKey];
  const displayName = meta?.display_name_long || meta?.display_name || varKey || '';
  const value = formatValue(properties[varKey], meta?.data_type);

  let html = `<div class="tt-name">${escapeHtml(name)}</div>`;
  // Points variables (Millionaires) are counted by town — the circles carry
  // them — so an area has no figure of its own to show.
  if (meta?.render_type !== 'points') {
    html += `<div class="tt-stat-card">` +
            `<div class="tt-stat-label">${escapeHtml(displayName)}</div>` +
            `<div class="tt-stat-value">${escapeHtml(value)}</div>` +
            `</div>`;
  }

  const rep = lookupRep(properties, level);
  if (rep) {
    let areas = (rep.areas || '').trim();
    if (areas.length > 80) {
      const list = areas.split(', ');
      areas = list.slice(0, 2).join(', ');
      if (list.length > 2) areas += `, +${list.length - 2} more`;
    }
    html += `<div class="tt-rep-card">` +
            `<div class="tt-rep-label">${escapeHtml(rep.title)}</div>` +
            `<div class="tt-rep-name">${escapeHtml(rep.name)} <span class="tt-rep-party">${escapeHtml(rep.party)}</span></div>` +
            `<div class="tt-areas">${escapeHtml(areas)}</div>` +
            `</div>`;
  }

  return html;
}

function positionTooltip(map, point) {
  if (!tooltipEl) return;
  const w = tooltipEl.offsetWidth || 220;
  const h = tooltipEl.offsetHeight || 100;
  const size = { x: map.getContainer().clientWidth, y: map.getContainer().clientHeight };
  const margin = 12;
  const cursorOffset = 14;

  // Default: above the cursor, centered.
  let x = point.x - w / 2;
  let y = point.y - h - cursorOffset;

  // Vertical: flip below if it would clip the top.
  if (y < margin) y = point.y + cursorOffset;

  // Horizontal: clamp within viewport, but if cursor is near a side, swap to opposite.
  if (point.x - w / 2 < margin) {
    x = point.x + cursorOffset;
  } else if (point.x + w / 2 > size.x - margin) {
    x = point.x - w - cursorOffset;
  }

  // Final clamp.
  x = Math.max(margin, Math.min(size.x - w - margin, x));
  y = Math.max(margin, Math.min(size.y - h - margin, y));

  tooltipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function setHoverState(map, level, id, on) {
  if (id == null) return;
  if (FLAGS.smooth) fadeHover(map, level, id, on);
  else map.setFeatureState({ source: level, id }, { hover: on });
}

function setSelectedState(map, level, id, on) {
  if (id == null) return;
  map.setFeatureState({ source: level, id }, { selected: on });
  if (FLAGS.smooth && on) liftArea(map, level, id);
}

// ?smooth=1: draw the picked area solid at once, and let any area picked
// before sink back into the dimmed map. Letting go of an area leaves it
// lifted: that shows nothing while the map isn't dimmed, and keeps the area
// from dipping while the rest of the map brightens back up around it.
function liftArea(map, level, id) {
  for (const [key, area] of lifted) {
    if (area.level === level && area.id === id) continue;
    fadeFeatureState(map, area.level, area.id, 'lift', 0, LIFT_DROP_MS);
    lifted.delete(key);
  }
  fadeFeatureState(map, level, id, 'lift', 1, 0);
  lifted.set(`${level}|${id}`, { level, id });
}

export function clearSelectedLayer() {
  const map = getMap();
  if (map && selectedFeature) {
    setSelectedState(map, selectedFeature.level, selectedFeature.id, false);
  }
  selectedFeature = null;
  setShadowFeature(null, null); // fade out the WebGL drop shadow
  if (map && hoveredFeature) {
    setHoverState(map, hoveredFeature.level, hoveredFeature.id, false);
  }
  hoveredFeature = null;
  hideTooltip();
}

function clearHoverFor(map) {
  if (hoveredFeature) {
    setHoverState(map, hoveredFeature.level, hoveredFeature.id, false);
    hoveredFeature = null;
  }
}

// Hover `feature` of `level`, under the pointer at `point`: highlight it, fill
// the tooltip in, and bring the tooltip to the pointer.
function hoverAt(map, level, feature, point) {
  const id = feature.id;

  // Hover state + content: update immediately on feature change only.
  if (!hoveredFeature || hoveredFeature.id !== id || hoveredFeature.level !== level) {
    if (hoveredFeature) setHoverState(map, hoveredFeature.level, hoveredFeature.id, false);
    hoveredFeature = { level, id };
    setHoverState(map, level, id, true);
    tooltipEl.innerHTML = buildTooltipContent(feature.properties, level);
  }

  // Position + show: rAF-throttled so layout reads/writes run at most once
  // per display frame rather than at raw pointer rate (100–200 Hz).
  // Cursor is set on the map container via a native CSS url() cursor in
  // mapInstance.js — no per-mousemove style mutation needed here.
  _lastMovePoint = point;
  if (!_moveRafId) {
    _moveRafId = requestAnimationFrame(() => {
      _moveRafId = null;
      if (_lastMovePoint) {
        positionTooltip(map, _lastMovePoint);
        showTooltip();
      }
    });
  }
}

// ?smooth=1: hover whatever is under the pointer now, as moving onto it would.
function resyncHover(map) {
  if (!pointer || !tooltipEl) return;
  const level = getState().activeLayer;
  const fillId = `${level}-fill`;
  if (!map.getLayer(fillId)) return;
  const feature = map.queryRenderedFeatures([pointer.x, pointer.y], { layers: [fillId] })[0];
  if (feature?.id != null) {
    hoverAt(map, level, feature, pointer);
  } else {
    clearHoverFor(map);
    hideTooltip();
  }
}

function computeBounds(geometry) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  function visit(coords) {
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const c of coords) visit(c);
  }
  if (geometry && geometry.coordinates) visit(geometry.coordinates);
  if (!isFinite(minLng) || !isFinite(minLat)) return null;
  return [[minLng, minLat], [maxLng, maxLat]];
}

export function bindLayerInteraction(map, level) {
  if (boundLevels.has(level)) return;
  boundLevels.add(level);

  ensureTooltipEl(map);
  ensureAnimationListeners(map);

  const fillId = `${level}-fill`;

  // A geography stays drawn while the next one loads and fades in; only the
  // one the controls show answers the pointer.
  const isActive = () => getState().activeLayer === level;

  map.on('mousemove', fillId, (e) => {
    if (isAnimating) return;
    if (!isActive()) return;
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    if (feature.id == null) return;
    hoverAt(map, level, feature, e.point);
  });

  map.on('mouseleave', fillId, () => {
    if (_moveRafId) { cancelAnimationFrame(_moveRafId); _moveRafId = null; }
    _lastMovePoint = null;
    clearHoverFor(map);
    hideTooltip();
  });

  map.on('click', fillId, (e) => {
    if (!isActive()) return;
    if (!e.features || !e.features.length) return;
    if (e.features[0].id == null) return;
    selectFeature(level, e.features[0]);
  });
}

// Select a district or county, as a click on it does: highlight it, open the
// info panel and frame it. Also used by the "Find an area" search, which
// passes the cached GeoJSON feature (its id is the promoted GEOID).
export function selectFeature(level, feature, { focusPanel = false } = {}) {
  const map = getMap();
  if (!map || !feature) return;
  // Sources promote GEOID to the feature id, so key on GEOID: a cached
  // GeoJSON feature carries its own numeric id, which the map doesn't use.
  const id = feature.properties?.GEOID ?? feature.id;
  if (id == null) return;

  // Drop hover so it doesn't compete with the selected styling.
  clearHoverFor(map);
  hideTooltip();

  // Replace existing selection.
  if (selectedFeature && (selectedFeature.id !== id || selectedFeature.level !== level)) {
    setSelectedState(map, selectedFeature.level, selectedFeature.id, false);
  }
  selectedFeature = { level, id };
  setSelectedState(map, level, id, true);
  setShadowFeature(level, { ...feature, id }); // push the new selection into the WebGL shadow layer

  const props = feature.properties;
  setState({ selectedFeatureId: props.GEOID || String(id) });
  showInfoPanel(props, { focus: focusPanel });

  // A clicked feature's geometry is only the part inside the map tile under
  // the pointer; frame the whole area from the loaded GeoJSON instead.
  const bounds = computeBounds((getFeatureById(level, id) || feature).geometry);
  if (bounds) {
    // The camera now belongs to this area: a resize (a tab switch, a phone
    // rotating) mustn't snap back to the starting view.
    releaseHome();
    const panel = document.getElementById('info-panel');
    const panelOpen = panel && panel.classList.contains('visible');
    const sidePad = 70;
    // Leave room for the panel beside the district, unless the panel
    // covers most of the map (phones), where there is no room to leave.
    const panelW = panelOpen ? (panel.getBoundingClientRect().width || 360) : 0;
    const mapW = map.getContainer().clientWidth;
    const rightPad = panelW && panelW + sidePad * 2 < mapW * 0.8 ? panelW + sidePad : sidePad;
    // Phones: the panel is a full-width sheet along the bottom, so frame the
    // district in the space above it.
    const sheet = panelOpen && panelW >= mapW - 1;
    const padding = sheet
      ? { top: 56, left: 24, right: 24, bottom: panel.offsetHeight + 16 }
      : { top: sidePad, bottom: sidePad, left: sidePad, right: rightPad };
    // Stop short of filling the screen with a small district, so its
    // neighbours stay in view and it's clear where it is.
    const maxZoom = 11;
    try {
      if (FLAGS.smooth) {
        // Paced by how far it goes, gliding to nearby areas and flying to far
        // ones (motion.js).
        const cam = map.cameraForBounds(bounds, { padding, maxZoom });
        if (cam) cameraTrip(map, cam);
      } else {
        map.fitBounds(bounds, { padding, maxZoom, duration: 600, essential: true });
      }
    } catch (_) { /* no-op */ }
  }
}

// ---------------------------------------------------------------------------
// Points-layer interaction (Millionaires-style city markers)
//
// Simpler than the polygon path: just a hover tooltip showing
// `<city>: <count> <noun>`. No info-panel open on click — the marker
// itself is the deliverable. Privacy: never reads name/org/age/gender
// (those fields don't exist in the source GeoJSON anyway).
// ---------------------------------------------------------------------------

function buildPointsTooltipContent(properties) {
  const city = properties.city || 'Unknown';
  const count = Number(properties.millionaire_count) || 0;
  const noun = count === 1 ? 'millionaire' : 'millionaires';
  return `<div class="tt-name">${escapeHtml(city)}</div>` +
         `<div class="tt-stat-card">` +
         `<div class="tt-stat-value">${count.toLocaleString()} ${noun}</div>` +
         `</div>`;
}

export function bindPointsInteraction(map, layerId) {
  if (boundPointsLayers.has(layerId)) return;
  boundPointsLayers.add(layerId);

  ensureTooltipEl(map);
  ensureAnimationListeners(map);

  map.on('mousemove', layerId, (e) => {
    if (isAnimating) return;
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];

    map.getCanvas().style.cursor = 'pointer';
    tooltipEl.innerHTML = buildPointsTooltipContent(feature.properties);

    _lastMovePoint = e.point;
    if (!_moveRafId) {
      _moveRafId = requestAnimationFrame(() => {
        _moveRafId = null;
        if (_lastMovePoint) {
          positionTooltip(map, _lastMovePoint);
          showTooltip();
        }
      });
    }
  });

  map.on('mouseleave', layerId, () => {
    if (_moveRafId) { cancelAnimationFrame(_moveRafId); _moveRafId = null; }
    _lastMovePoint = null;
    map.getCanvas().style.cursor = '';
    hideTooltip();
    // The tooltip still holds this circle's text; drop the district hover so
    // the district under the pointer writes its own on the next move.
    clearHoverFor(map);
  });
}
