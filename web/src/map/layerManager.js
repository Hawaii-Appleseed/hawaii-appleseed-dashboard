import { getMap, whenMapReady } from './mapInstance.js';
import { getThresholds, getSchemeColors, stepColorExpression } from './colors.js';
import { loadLayer, fetchJson } from '../data/loader.js';
import { bindLayerInteraction, bindPointsInteraction, clearSelectedLayer } from './popup.js';
import { registerShadowLayer, prewarmShadowLayer, setShadowFeature, SHADOW_LAYER_ID } from './shadowLayer.js';
import { FLAGS } from './perfFlags.js';

// Variables config — needed to look up render_type / points_data per variable.
// Set once at boot via initLayerManager(config.variables).
let VARIABLES = null;
export function initLayerManager(variablesConfig) {
  VARIABLES = variablesConfig?.variables || null;
}

// Tracks the currently-rendered Millionaires circle overlay. Null when off.
let pointsLayerActive = null; // { layerId, sourceId, countField }

const MILLIONAIRES_VAR_KEY = 'millionaires';

// Millionaires can be shown two ways, and the mode is derived from whether it
// is the *selected variable* rather than stored separately:
//
//   variable mode  — picked from the Economic Security dropdown (or the
//                    ?var=millionaires embed link). The circles ARE the data,
//                    so the choropleth mutes to a backdrop and the circles use
//                    the active color scheme. This is the original look.
//   overlay mode   — the "Show millionaires" legend checkbox, on top of some
//                    other variable. The choropleth keeps its real colors and
//                    the circles switch to a fixed accent ramp so the two
//                    layers can't be mistaken for one another.
//
// Deriving this (instead of tracking a flag) keeps the two entry points from
// drifting: there is exactly one definition of "muted".
function millionairesIsVariable() {
  return currentVariable === MILLIONAIRES_VAR_KEY;
}

// Muted backdrop fill applied to the choropleth in variable mode — the
// underlying islands stay recognizable since this map has no tile basemap.
const POINTS_MODE_MUTED_FILL = '#b8cdaf';
const POINTS_MODE_MUTED_LINE = '#5c7757';

// Fixed accent ramp for the composed overlay (circles on top of a real
// choropleth) — deliberately NOT tied to colorScheme, since the circles need
// to read as "millionaires" regardless of which of the 4 scheme hues the
// choropleth underneath is using. ColorBrewer YlOrBr-9, distinct from all of
// blue/green/red/purple in theme.json.
const MILLIONAIRES_ACCENT_COLORS = [
  '#ffffe5', '#fff7bc', '#fee391', '#fec44f', '#fe9929',
  '#ec7014', '#cc4c02', '#993404', '#662506',
];

// When ?notrans=1 strip the 300ms opacity transitions; when ?nofade=1 also
// skip the layer-switch fade-in/fade-out animation.
const TRANSITION_PAINT = FLAGS.noTransitions
  ? {}
  : { 'fill-opacity-transition': { duration: 300, delay: 0 } };
const LINE_TRANSITION_PAINT = FLAGS.noTransitions
  ? {}
  : { 'line-opacity-transition': { duration: 300, delay: 0 } };

const LEVELS = ['state', 'county', 'house', 'senate'];
const cachedGeoJson = new Map();
const registeredLevels = new Set();
let currentLevel = null;
let currentVariable = null;
let currentScheme = null;
let reliabilityOn = false;

// ── Reliability hatch overlay ───────────────────────────────────────────────
// Opt-in (checkbox) diagonal-hatch overlay marking districts whose ACS estimate
// for the active variable is statistically shaky. Two tiers by coefficient of
// variation (CV = (MOE/1.645)/|value|): caution 15–30% (sparse single hatch),
// unreliable >30% (denser cross-hatch). Computed client-side from the value and
// its <var>_moe column — no data change. A near-zero guard skips tiny estimates
// (where CV explodes but the absolute error is immaterial).
const RELIABILITY_PATTERN_CAUTION = 'reliability-hatch-caution';
const RELIABILITY_PATTERN_UNRELIABLE = 'reliability-hatch-unreliable';
const CV_CAUTION = 0.15;
const CV_UNRELIABLE = 0.30;
let hatchPatternsReady = false;

function makeHatchImage({ size, spacing, cross, alpha }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = `rgba(40, 50, 56, ${alpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -size; i < size * 2; i += spacing) {
    ctx.moveTo(i, 0); ctx.lineTo(i + size, size);        // "\" diagonal
    if (cross) { ctx.moveTo(i + size, 0); ctx.lineTo(i, size); } // "/" diagonal
  }
  ctx.stroke();
  const img = ctx.getImageData(0, 0, size, size);
  return { width: size, height: size, data: new Uint8Array(img.data.buffer) };
}

function registerHatchPatterns(map) {
  if (hatchPatternsReady) return;
  if (!map.hasImage(RELIABILITY_PATTERN_CAUTION)) {
    map.addImage(RELIABILITY_PATTERN_CAUTION,
      makeHatchImage({ size: 12, spacing: 6, cross: false, alpha: 0.40 }), { pixelRatio: 2 });
  }
  if (!map.hasImage(RELIABILITY_PATTERN_UNRELIABLE)) {
    map.addImage(RELIABILITY_PATTERN_UNRELIABLE,
      makeHatchImage({ size: 12, spacing: 4, cross: true, alpha: 0.55 }), { pixelRatio: 2 });
  }
  hatchPatternsReady = true;
}

// Reliability flags only apply to Census (ACS) variables that carry a margin of
// error. Other sources (SNAP/ALICE/tax credits) have no sampling MOE to assess.
function variableHasMoe(varKey) {
  return VARIABLES?.[varKey]?.data_source === 'acs';
}

function cvExpression(variable) {
  // CV = (MOE / 1.645) / max(|value|, ε)
  return ['/',
    ['/', ['to-number', ['get', `${variable}_moe`]], 1.645],
    ['max', ['abs', ['to-number', ['get', variable]]], 1e-9],
  ];
}

function reliabilityFilter(variable) {
  const thresholds = getThresholds(variable) || [];
  const floor = (thresholds[0] || 0) * 0.5; // near-zero guard anchored to scale
  return [
    'all',
    ['has', variable],
    ['has', `${variable}_moe`],
    ['==', ['typeof', ['get', variable]], 'number'],
    ['==', ['typeof', ['get', `${variable}_moe`]], 'number'],
    ['>=', ['abs', ['to-number', ['get', variable]]], floor],
    ['>', cvExpression(variable), CV_CAUTION],
  ];
}

function reliabilityPatternExpr(variable) {
  return ['case',
    ['>', cvExpression(variable), CV_UNRELIABLE], RELIABILITY_PATTERN_UNRELIABLE,
    RELIABILITY_PATTERN_CAUTION,
  ];
}

const FADE_MS = 300;
const pendingHide = new Map(); // level → setTimeout id

// Opacity expressions as constants so fade-in can restore them after zeroing out.
// Solid fills (the legend shows the same colors), lightening a touch under
// the cursor; with the 300ms fill-opacity-transition that reads as a soft
// hover cue. The selected area stays solid.
const FILL_OPACITY_EXPR = [
  'case',
  ['boolean', ['feature-state', 'selected'], false], 1.0,
  ['boolean', ['feature-state', 'hover'], false], 0.82,
  1.0,
];
// While an area is picked, the others fade back so it stands out whatever
// its color (a dark outline alone vanishes on the darkest classes).
const FILL_OPACITY_FOCUS_EXPR = [
  'case',
  ['boolean', ['feature-state', 'selected'], false], 1.0,
  ['boolean', ['feature-state', 'hover'], false], 0.7,
  0.45,
];
let selectionFocus = false;
const fillOpacity = () => (selectionFocus ? FILL_OPACITY_FOCUS_EXPR : FILL_OPACITY_EXPR);

// Borders between areas: thin white lines that thicken as you zoom in, so
// Honolulu's small districts don't blur into a mesh at the statewide view.
const LINE_COLOR = '#ffffff';
const LINE_OPACITY = 0.95;
const LINE_WIDTH_EXPR = ['interpolate', ['linear'], ['zoom'], 6, 0.5, 9, 1, 12, 1.75];

// The islands' coastline (the county outline), drawn over the fills and the
// white borders, so every island has a clean dark edge against the light
// background, even when a variable colors it in its palest shade.
const COAST_LAYER_ID = 'coastline';
const COAST_COLOR = '#5b645b';
const COAST_WIDTH_EXPR = ['interpolate', ['linear'], ['zoom'], 6, 0.6, 9, 1, 12, 1.5];

// Coastline over the level's fill and borders, under its selection and hover
// outlines.
function placeCoastline(map, level) {
  if (map.getLayer(COAST_LAYER_ID) && map.getLayer(`${level}-selected`)) {
    map.moveLayer(COAST_LAYER_ID, `${level}-selected`);
  }
}

// Feature-state gated value: returns `whenSelected` if the feature has selected
// state, else `whenNot` (0). Used for opacity, width, etc.
const selectedCase = (whenSelected, whenNot = 0) => [
  'case',
  ['boolean', ['feature-state', 'selected'], false], whenSelected,
  whenNot,
];

// The selected-feature drop shadow lives in a custom WebGL layer
// (`./shadowLayer.js`) registered globally on the map — see
// `registerShadowLayer()`. The legacy stacked fill-translate shadow has
// been removed in favor of a true Gaussian blur.

// Some variables carry text-prefixed numeric values (e.g., cep_display = "5/9 CEP
// schools"). MapLibre's to-number returns NaN for those strings, so we mirror
// every string-numeric property as `_num_<key>` (a real number) at cache time
// and prefer that mirror in the color expression.
function preprocessFeatures(data) {
  if (!data || !data.features) return data;
  for (const feat of data.features) {
    const props = feat.properties;
    if (!props) continue;
    for (const [k, v] of Object.entries(props)) {
      if (typeof v !== 'string' || v.length === 0) continue;
      if (k.startsWith('_num_')) continue;
      const n = parseFloat(v);
      if (isFinite(n)) props['_num_' + k] = n;
    }
  }
  return data;
}

function colorExpression(variable, scheme) {
  const thresholds = getThresholds(variable);
  const colors = getSchemeColors(scheme);
  if (!variable || !thresholds || thresholds.length === 0 || !colors || colors.length === 0) {
    return '#cccccc';
  }
  const numField = '_num_' + variable;
  // Resolve a numeric value: prefer the precomputed mirror, else the native
  // number if the property is numeric, else 0 (the outer case catches missing
  // data and routes to gray, so this 0 path is unreachable for real renders).
  const numericValue = [
    'case',
    ['has', numField], ['get', numField],
    ['==', ['typeof', ['get', variable]], 'number'], ['to-number', ['get', variable]],
    0,
  ];
  return [
    'case',
    ['all',
      ['!', ['has', numField]],
      ['!=', ['typeof', ['get', variable]], 'number'],
    ], '#cccccc',
    stepColorExpression(numericValue, thresholds, colors),
  ];
}

let coastRequested = false;
async function ensureCoastline(map) {
  if (coastRequested) return;
  coastRequested = true;
  let data;
  try {
    data = await loadLayer('county');
  } catch (err) {
    console.warn('coastline: county outline failed to load', err);
    return;
  }
  if (map.getLayer(COAST_LAYER_ID)) return;
  map.addSource(COAST_LAYER_ID, { type: 'geojson', data });
  map.addLayer({
    id: COAST_LAYER_ID,
    type: 'line',
    source: COAST_LAYER_ID,
    paint: { 'line-color': COAST_COLOR, 'line-width': COAST_WIDTH_EXPR, 'line-opacity': 0.9 },
  });
  if (currentLevel) placeCoastline(map, currentLevel);
  if (pointsLayerActive && map.getLayer(pointsLayerActive.layerId)) map.moveLayer(pointsLayerActive.layerId);
}

function fillLayerIds(level) {
  return [
    `${level}-fill`,
    `${level}-line`,
    `${level}-selected`,
    `${level}-hover`,
  ];
}

function ensureSourceAndLayers(map, level, data) {
  if (registeredLevels.has(level)) return;

  registerHatchPatterns(map);

  map.addSource(level, {
    type: 'geojson',
    data,
    promoteId: 'GEOID',
  });

  // Fill — colored by current variable. The drop shadow lives in a separate
  // global custom WebGL layer (`./shadowLayer.js`); we just make sure it
  // remains below this fill via `map.moveLayer` after registration.
  map.addLayer({
    id: `${level}-fill`,
    type: 'fill',
    source: level,
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#cccccc',
      'fill-opacity': fillOpacity(),
      ...TRANSITION_PAINT,
    },
  });

  // Reliability hatch overlay — sits above the colored fill, below the
  // outlines. Hidden by default; shown (and filtered to flagged features for
  // the active variable) only when the reliability checkbox is on.
  map.addLayer({
    id: `${level}-reliability`,
    type: 'fill',
    source: level,
    layout: { visibility: 'none' },
    paint: {
      'fill-pattern': RELIABILITY_PATTERN_CAUTION,
      'fill-opacity': 0.9,
    },
    filter: ['==', ['get', 'GEOID'], '\u0000'], // matches nothing until applied
  });

  // Default outline
  map.addLayer({
    id: `${level}-line`,
    type: 'line',
    source: level,
    layout: { visibility: 'none' },
    paint: {
      'line-color': LINE_COLOR,
      'line-width': LINE_WIDTH_EXPR,
      'line-opacity': LINE_OPACITY,
      ...LINE_TRANSITION_PAINT,
    },
  });

  // Selected: thin, soft inner outline. Kept subtle so the drop shadow
  // does the heavy visual lifting and the polygon "lifts off" the map
  // without a heavy black border competing for attention.
  map.addLayer({
    id: `${level}-selected`,
    type: 'line',
    source: level,
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#161c17',
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 2,
        0,
      ],
      'line-opacity': 0.9,
      ...LINE_TRANSITION_PAINT,
    },
  });

  // Hover: thin, light inner ring + opacity bump on the fill (see
  // FILL_OPACITY_EXPR). Suppressed when selected so the selection
  // outline doesn't fight a hover ring.
  map.addLayer({
    id: `${level}-hover`,
    type: 'line',
    source: level,
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#1a1a1a',
      'line-width': [
        'case',
        ['all',
          ['boolean', ['feature-state', 'hover'], false],
          ['!', ['boolean', ['feature-state', 'selected'], false]],
        ], 1.25,
        0,
      ],
      'line-opacity': 0.45,
      ...LINE_TRANSITION_PAINT,
    },
  });

  if (!FLAGS.noHover) bindLayerInteraction(map, level);
  registeredLevels.add(level);
}

function restoreTargetOpacities(map, level) {
  if (map.getLayer(`${level}-fill`))
    map.setPaintProperty(`${level}-fill`, 'fill-opacity', fillOpacity());
  if (map.getLayer(`${level}-line`))
    map.setPaintProperty(`${level}-line`, 'line-opacity', LINE_OPACITY);
  if (map.getLayer(`${level}-selected`))
    map.setPaintProperty(`${level}-selected`, 'line-opacity', 0.9);
  if (map.getLayer(`${level}-hover`))
    map.setPaintProperty(`${level}-hover`, 'line-opacity', 0.45);
}

function fadeInLevel(map, level) {
  // Cancel any in-flight hide for this level
  if (pendingHide.has(level)) {
    clearTimeout(pendingHide.get(level));
    pendingHide.delete(level);
  }

  const ids = fillLayerIds(level);
  for (const id of ids) {
    if (!map.getLayer(id)) continue;
    const layerType = map.getLayer(id).type;
    if (layerType === 'fill') map.setPaintProperty(id, 'fill-opacity', 0);
    else map.setPaintProperty(id, 'line-opacity', 0);
    map.setLayoutProperty(id, 'visibility', 'visible');
  }

  // Restore target opacities on the next frame so MapLibre animates from 0.
  requestAnimationFrame(() => restoreTargetOpacities(map, level));
}

function fadeOutLevel(map, level) {
  const ids = fillLayerIds(level);
  for (const id of ids) {
    if (!map.getLayer(id)) continue;
    const layerType = map.getLayer(id).type;
    if (layerType === 'fill') map.setPaintProperty(id, 'fill-opacity', 0);
    else map.setPaintProperty(id, 'line-opacity', 0);
  }
  const tid = setTimeout(() => {
    pendingHide.delete(level);
    for (const id of ids) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    }
  }, FADE_MS + 50);
  pendingHide.set(level, tid);
}

function applyColorExpression(map, level) {
  if (!map.getLayer(`${level}-fill`)) return;
  // Variable mode mutes the choropleth to a backdrop (the circles are the
  // data). Overlay mode leaves the real variable's fill untouched underneath.
  // Note this is gated on the variable, NOT on the overlay being up yet:
  // adding the circle layer is async (it fetches GeoJSON), and keying off
  // pointsLayerActive would flash a gray "no data" choropleth in between.
  if (millionairesIsVariable()) {
    map.setPaintProperty(`${level}-fill`, 'fill-color', POINTS_MODE_MUTED_FILL);
    if (map.getLayer(`${level}-line`)) {
      map.setPaintProperty(`${level}-line`, 'line-color', POINTS_MODE_MUTED_LINE);
    }
  } else {
    map.setPaintProperty(`${level}-fill`, 'fill-color', colorExpression(currentVariable, currentScheme));
    if (map.getLayer(`${level}-line`)) {
      map.setPaintProperty(`${level}-line`, 'line-color', LINE_COLOR);
    }
  }
}

// Apply the reliability overlay for one level: visible only when the toggle is
// on, the active variable is an ACS metric with MOE, and the choropleth isn't
// muted by Millionaires variable mode (overlay mode leaves it eligible — the
// real variable is still on screen under the circles).
function applyReliability(map, level) {
  const layerId = `${level}-reliability`;
  if (!map.getLayer(layerId)) return;
  const on = reliabilityOn && !millionairesIsVariable() && variableHasMoe(currentVariable);
  if (!on) {
    map.setLayoutProperty(layerId, 'visibility', 'none');
    return;
  }
  map.setFilter(layerId, reliabilityFilter(currentVariable));
  map.setPaintProperty(layerId, 'fill-pattern', reliabilityPatternExpr(currentVariable));
  map.setLayoutProperty(layerId, 'visibility', 'visible');
}

// Re-apply across all levels: show the active level's overlay, hide the rest.
function refreshReliability() {
  const map = getMap();
  if (!map) return;
  for (const level of registeredLevels) {
    if (level === currentLevel) applyReliability(map, level);
    else if (map.getLayer(`${level}-reliability`)) {
      map.setLayoutProperty(`${level}-reliability`, 'visibility', 'none');
    }
  }
}

export function setReliability(on) {
  reliabilityOn = on;
  refreshReliability();
}

// ---------------------------------------------------------------------------
// Millionaires circle overlay — circle markers per town, in either variable
// mode or overlay mode (see millionairesIsVariable() above).
//
// Driven by the `millionaires` entry in variables.json (`render_type:
// "points"`, `points_data: "<file>.json"`, a GeoJSON FeatureCollection in
// /public/data/). Markers scale with sqrt(count) and grow with zoom via a
// MapLibre `interpolate` expression so single-count dots stay legible when
// zoomed into one island, without dwarfing islands at fit-bounds.
//
// Whether the circles are up is decided in main.js (checkbox OR selected
// variable) and pushed in via setMillionairesOverlay.
// ---------------------------------------------------------------------------

function buildCircleRadiusExpr(countField) {
  // base = max(5, min(20, 3 + sqrt(count) * 1.4))  — the "fit-bounds" size
  const sqrtCount = ['sqrt', ['to-number', ['coalesce', ['get', countField], 0]]];
  const base = ['max', 5, ['min', 20, ['+', 3, ['*', sqrtCount, 1.4]]]];
  return [
    'interpolate', ['linear'], ['zoom'],
    6,  base,
    11, ['min', 32, ['*', base, 1.75]],
    14, ['min', 36, ['*', base, 2.5]],
  ];
}

function buildCircleColorExpr(countField, thresholds, colors) {
  const value = ['to-number', ['coalesce', ['get', countField], 0]];
  return stepColorExpression(value, thresholds, colors);
}

// Variable mode → scheme-tied colors (the circles are the data, so they follow
// the user's color-scheme pick). Overlay mode → fixed accent ramp, since the
// circles sit on top of a real, differently-colored choropleth and need to
// read as their own layer.
function pointsColors() {
  return millionairesIsVariable() ? getSchemeColors(currentScheme) : MILLIONAIRES_ACCENT_COLORS;
}

async function showMillionairesOverlay(map) {
  const meta = VARIABLES?.[MILLIONAIRES_VAR_KEY];
  if (!meta || meta.render_type !== 'points') return;

  // Already up: just refresh paint (mode or scheme may have changed).
  if (pointsLayerActive) {
    updatePointsPaint(map);
    if (currentLevel) applyColorExpression(map, currentLevel);
    refreshReliability();
    return;
  }

  const sourceId = `points-source-${MILLIONAIRES_VAR_KEY}`;
  const layerId = `points-${MILLIONAIRES_VAR_KEY}`;
  const dataPath = meta.points_data || `${MILLIONAIRES_VAR_KEY}.json`;
  const countField = meta.csv_column || 'value';

  let data;
  try {
    data = await fetchJson(`/data/${dataPath}`);
  } catch (err) {
    console.error('Millionaires overlay load failed:', err);
    return;
  }

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, { type: 'geojson', data });
  }

  const colors = pointsColors();
  const thresholds = getThresholds(MILLIONAIRES_VAR_KEY);

  map.addLayer({
    id: layerId,
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-radius': buildCircleRadiusExpr(countField),
      'circle-color': buildCircleColorExpr(countField, thresholds, colors),
      'circle-opacity': 0.85,
      'circle-stroke-color': '#1f2d3d',
      'circle-stroke-width': 1.25,
      'circle-stroke-opacity': 0.95,
    },
  });

  pointsLayerActive = { layerId, sourceId, countField };

  // Hover tooltip on the circles — city + count, no PII.
  bindPointsInteraction(map, layerId);

  // Variable mode mutes the choropleth underneath; overlay mode leaves it be.
  if (currentLevel) applyColorExpression(map, currentLevel);
  refreshReliability();
}

function updatePointsPaint(map) {
  if (!pointsLayerActive) return;
  const { layerId, countField } = pointsLayerActive;
  if (!map.getLayer(layerId)) return;
  const colors = pointsColors();
  const thresholds = getThresholds(MILLIONAIRES_VAR_KEY);
  map.setPaintProperty(layerId, 'circle-color', buildCircleColorExpr(countField, thresholds, colors));
}

function removeMillionairesOverlay(map) {
  if (!pointsLayerActive) return;
  const { layerId, sourceId } = pointsLayerActive;
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  pointsLayerActive = null;
  // Restore data-driven choropleth fill on the active level (no-op if it
  // was never muted, i.e. we're coming out of composed mode).
  if (currentLevel) applyColorExpression(getMap(), currentLevel);
  refreshReliability();
}

export function isPointsModeActive() {
  return !!pointsLayerActive;
}

// Public entry point: called from main.js whenever the "Show millionaires"
// checkbox OR the selected variable changes. Mirrors setVariable's
// initial-load race guard: the map may not have a `currentLevel` yet
// (style/choropleth still loading), so defer to map.once('load', ...) in that
// case rather than silently no-op'ing — this is exactly what left the embed
// showing a bare choropleth with no circles before that guard existed.
export function setMillionairesOverlay(on) {
  const map = getMap();
  if (!map) return;

  const apply = () => {
    if (on) {
      showMillionairesOverlay(map);
    } else {
      removeMillionairesOverlay(map);
    }
  };

  if (currentLevel) {
    apply();
  } else {
    map.once('load', apply);
  }
}

export async function setLayer(level) {
  if (level === currentLevel) return;
  if (!cachedGeoJson.has(level)) {
    const data = await loadLayer(level);
    preprocessFeatures(data);
    cachedGeoJson.set(level, data);
  }
  const map = getMap();
  if (!map) return;

  const apply = () => {
    ensureSourceAndLayers(map, level, cachedGeoJson.get(level));

    // Register the global shadow layer (idempotent) and pre-warm it so the
    // first click has no shader-compile / FBO-create delay. Keep it strictly
    // below the active level's colored fill so the shadow renders under
    // the polygon body.
    ensureCoastline(map);
    registerShadowLayer(map);
    prewarmShadowLayer(`${level}-fill`);
    if (map.getLayer(SHADOW_LAYER_ID) && map.getLayer(`${level}-fill`)) {
      map.moveLayer(SHADOW_LAYER_ID, `${level}-fill`);
    }

    if (currentLevel && currentLevel !== level) {
      fadeOutLevel(map, currentLevel);
    }

    fadeInLevel(map, level);
    applyColorExpression(map, level);

    // ensureSourceAndLayers just added this level's fill/line/reliability
    // layers, which land on top of the stack by default — above the
    // Millionaires overlay if it was already active from a prior level.
    // Re-assert it above everything so switching geography (e.g. Counties
    // → House Districts) doesn't bury the circles under the new fill.
    placeCoastline(map, level);
    if (pointsLayerActive && map.getLayer(pointsLayerActive.layerId)) {
      map.moveLayer(pointsLayerActive.layerId);
    }

    clearSelectedLayer();
    setShadowFeature(level, null); // clear any prior selection's shadow
    currentLevel = level;
    refreshReliability();
  };

  // Not isStyleLoaded(): a variable picked right after this geography (as the
  // Data tab does when both change) repaints the old level, which reads as
  // "not loaded" until the next render, and the switch was being dropped.
  whenMapReady(apply);
}

// Preload and register all level GeoJSON in the background so layer switches
// are instant (no network wait) after initial load.
export async function preloadAll() {
  const map = getMap();
  for (const level of LEVELS) {
    if (cachedGeoJson.has(level)) continue;
    try {
      const data = await loadLayer(level);
      preprocessFeatures(data);
      cachedGeoJson.set(level, data);
      if (map && map.isStyleLoaded()) {
        ensureSourceAndLayers(map, level, data);
      }
    } catch (e) {
      console.warn(`preloadAll: failed to load ${level}`, e);
    }
  }
}

export function setVariable(varKey) {
  currentVariable = varKey;
  const map = getMap();
  if (!map) return;

  const apply = () => {
    if (!currentLevel) return;
    applyColorExpression(map, currentLevel);
    // Switching into or out of Millionaires flips the circles between the
    // scheme ramp (variable mode) and the accent ramp (overlay mode).
    if (pointsLayerActive) updatePointsPaint(map);
    refreshReliability();
  };

  // Initial-load race: setVariable may fire before setLayer's deferred
  // map.once('load', ...) callback runs, leaving currentLevel = null. Defer
  // too so the order ends up: style-loads → setLayer apply → setVariable
  // apply. (setMillionairesOverlay has its own copy of this same guard —
  // it used to piggyback on this one back when Millionaires was reached via
  // setVariable, but the two are independent now.)
  //
  // Gate on currentLevel, NOT isStyleLoaded(): setLayer's apply (which sets
  // currentLevel) runs only once the style is loaded, so a non-null
  // currentLevel means the map is ready for layer ops. Crucially, setLayer
  // also just added the choropleth source, which flips isStyleLoaded() back to
  // false while it streams in — the old `isStyleLoaded() && currentLevel` gate
  // then fell through to once('load'), which silently no-ops because 'load'
  // has already fired.
  if (currentLevel) {
    apply();
  } else {
    map.once('load', apply);
  }
}

export function setColorScheme(scheme) {
  currentScheme = scheme;
  const map = getMap();
  if (!map || !currentLevel) return;
  applyColorExpression(map, currentLevel);
  if (pointsLayerActive) updatePointsPaint(map);
}

// Fade the unpicked areas (on) or bring them back (off).
export function setSelectionFocus(on) {
  selectionFocus = on;
  const map = getMap();
  if (!map || !currentLevel || !map.getLayer(`${currentLevel}-fill`)) return;
  map.setPaintProperty(`${currentLevel}-fill`, 'fill-opacity', fillOpacity());
}

export function getCurrentVariable() {
  return currentVariable;
}

export function getCurrentScheme() {
  return currentScheme;
}

export function getCurrentLevel() {
  return currentLevel;
}

export function getCachedGeoJson(level) {
  return cachedGeoJson.get(level);
}

export function getFeatureProperties(featureId) {
  if (!currentLevel) return null;
  const data = cachedGeoJson.get(currentLevel);
  if (!data || !data.features) return null;
  const target = String(featureId);
  for (const feat of data.features) {
    const id = String(feat.properties?.GEOID ?? feat.id ?? '');
    if (id === target) return feat.properties;
  }
  return null;
}

export function getFeatureById(level, featureId) {
  const data = cachedGeoJson.get(level);
  if (!data || !data.features) return null;
  const target = String(featureId);
  for (const feat of data.features) {
    const id = String(feat.properties?.GEOID ?? feat.id ?? '');
    if (id === target) return feat;
  }
  return null;
}

export const KNOWN_LEVELS = LEVELS;
