import { getState, setState } from '../state/store.js';
import { showInfoPanel } from '../ui/infoPanel.js';
import { getMap } from './mapInstance.js';
import { setShadowFeature } from './shadowLayer.js';

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
    'opacity:0',
    'transition:opacity 0.12s ease-out',
    'will-change:transform',
  ].join(';');
  const container = map.getContainer();
  container.appendChild(tooltipEl);
  return tooltipEl;
}

function hideTooltip() {
  if (!tooltipEl) return;
  tooltipEl.style.opacity = '0';
}

function showTooltip() {
  if (!tooltipEl) return;
  tooltipEl.style.opacity = '1';
}

function ensureAnimationListeners(map) {
  if (animationListenersBound) return;
  map.on('movestart', () => { isAnimating = true; hideTooltip(); });
  map.on('zoomstart', () => { isAnimating = true; hideTooltip(); });
  map.on('moveend', () => { isAnimating = false; });
  map.on('zoomend', () => { isAnimating = false; });
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

function buildTooltipContent(properties) {
  const s = getState();
  const name = cleanName(properties.display_name || properties.NAME || properties.name);
  const varKey = s.selectedVariable;
  const meta = VARIABLES?.[varKey];
  const displayName = meta?.display_name_long || meta?.display_name || varKey || '';
  const value = formatValue(properties[varKey], meta?.data_type);

  let html = `<div class="tt-name">${escapeHtml(name)}</div>` +
             `<div class="tt-stat-card">` +
             `<div class="tt-stat-label">${escapeHtml(displayName)}</div>` +
             `<div class="tt-stat-value">${escapeHtml(value)}</div>` +
             `</div>`;

  const rep = lookupRep(properties, s.activeLayer);
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
  map.setFeatureState({ source: level, id }, { hover: on });
}

function setSelectedState(map, level, id, on) {
  if (id == null) return;
  map.setFeatureState({ source: level, id }, { selected: on });
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

  map.on('mousemove', fillId, (e) => {
    if (isAnimating) return;
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    const id = feature.id;
    if (id == null) return;

    // Hover state + content: update immediately on feature change only.
    if (!hoveredFeature || hoveredFeature.id !== id || hoveredFeature.level !== level) {
      if (hoveredFeature) setHoverState(map, hoveredFeature.level, hoveredFeature.id, false);
      hoveredFeature = { level, id };
      setHoverState(map, level, id, true);
      tooltipEl.innerHTML = buildTooltipContent(feature.properties);
    }

    // Position + show: rAF-throttled so layout reads/writes run at most once
    // per display frame rather than at raw pointer rate (100–200 Hz).
    // Cursor is set on the map container via a native CSS url() cursor in
    // mapInstance.js — no per-mousemove style mutation needed here.
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

  map.on('mouseleave', fillId, () => {
    if (_moveRafId) { cancelAnimationFrame(_moveRafId); _moveRafId = null; }
    _lastMovePoint = null;
    clearHoverFor(map);
    hideTooltip();
  });

  map.on('click', fillId, (e) => {
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    const id = feature.id;
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
    setShadowFeature(level, feature); // push the new selection into the WebGL shadow layer

    const props = feature.properties;
    setState({ selectedFeatureId: props.GEOID || String(id) });
    showInfoPanel(props);

    const bounds = computeBounds(feature.geometry);
    if (bounds) {
      const panel = document.getElementById('info-panel');
      const panelOpen = panel && panel.classList.contains('visible');
      const sidePad = 70;
      // Leave room for the panel beside the district, unless the panel
      // covers most of the map (phones), where there is no room to leave.
      const panelW = panelOpen ? (panel.getBoundingClientRect().width || 360) : 0;
      const mapW = map.getContainer().clientWidth;
      const rightPad = panelW && panelW + sidePad * 2 < mapW * 0.8 ? panelW + sidePad : sidePad;
      try {
        map.fitBounds(bounds, {
          padding: { top: sidePad, bottom: sidePad, left: sidePad, right: rightPad },
          maxZoom: 13,
          duration: 600,
          essential: true,
        });
      } catch (_) { /* no-op */ }
    }
  });
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
  });
}
