import { getSchemeColors, getThresholds, listSchemes, classColor } from '../map/colors.js';
import { getState, setState } from '../state/store.js';

let VARIABLES = null;
let schemeBound = false;

export function initLegend(variablesConfig) {
  VARIABLES = variablesConfig.variables;
}

// Choose enough decimals that EVERY consecutive pair of thresholds renders
// distinctly at the chosen divisor (k or M). E.g. thresholds 8500/8650/8700
// all round to "9k" at 0 decimals — bump to 1 decimal so they read 8.5k/8.7k.
function pickDecimalsForGrades(grades, divisor) {
  for (let d = 0; d <= 2; d++) {
    let ok = true;
    for (let i = 0; i < grades.length - 1; i++) {
      if ((grades[i] / divisor).toFixed(d) === (grades[i + 1] / divisor).toFixed(d)) {
        ok = false;
        break;
      }
    }
    if (ok) return d;
  }
  return 2;
}

// One boundary on its own, as the open-ended rows print it: the "45%" in
// "45%+", the "$50k" in "<$50k".
function formatBound(value, dataType, decimals, divisor) {
  const isPct = dataType === 'percentage' || /rate|pct|percent/.test(dataType || '');
  const isCurrency = dataType === 'currency' || /income|value|benefit|amount/.test(dataType || '');
  if (isPct) return `${value}%`;
  if (isCurrency) {
    // 2-decimal k/M reads worse than full numbers — fall back to comma form.
    if (divisor > 1 && value >= 1_000_000 && decimals < 2) return `$${(value / 1_000_000).toFixed(Math.max(1, decimals))}M`;
    if (divisor > 1 && value >= 1000 && decimals < 2) return `$${(value / 1000).toFixed(decimals)}k`;
    return `$${value.toLocaleString()}`;
  }
  if (dataType === 'count') return value.toLocaleString();
  if (dataType === 'decimal') return value.toFixed(decimals);
  return `${value}`;
}

function formatRange(from, next, dataType, decimals, divisor) {
  if (next === undefined) return `${formatBound(from, dataType, decimals, divisor)}+`;

  const isPct = dataType === 'percentage' || /rate|pct|percent/.test(dataType || '');
  const isCurrency = dataType === 'currency' || /income|value|benefit|amount/.test(dataType || '');
  const isCount = dataType === 'count';
  const isDecimal = dataType === 'decimal';

  if (isDecimal) return `${from.toFixed(decimals)}-${next.toFixed(decimals)}`;
  if (isPct) return `${from}-${next}%`;
  if (isCurrency) {
    // k/M only when the whole legend is in thousands (divisor > 1), since
    // `decimals` was picked for that divisor. A legend that starts in the
    // hundreds stays in full dollars, or $1,000–1,250 would print "$1k-1k".
    if (divisor > 1 && from >= 1_000_000 && decimals < 2) {
      const d = Math.max(1, decimals);
      return `$${(from / 1_000_000).toFixed(d)}M-${(next / 1_000_000).toFixed(d)}M`;
    }
    if (divisor > 1 && from >= 1000 && decimals < 2) {
      return `$${(from / 1000).toFixed(decimals)}k-${(next / 1000).toFixed(decimals)}k`;
    }
    return `$${from.toLocaleString()}-${next.toLocaleString()}`;
  }
  if (isCount) return `${from.toLocaleString()}-${next.toLocaleString()}`;
  return `${from}-${next}`;
}

function ensureColorSchemeOptions() {
  const select = document.getElementById('color-scheme-select');
  if (!select) return;
  const s = getState();
  if (!select.options.length) {
    select.innerHTML = listSchemes()
      .map((sk) => `<option value="${sk}">${capitalize(sk)}</option>`)
      .join('');
  }
  if (select.value !== s.colorScheme) {
    select.value = s.colorScheme;
  }
  if (!schemeBound) {
    select.addEventListener('change', (e) => setState({ colorScheme: e.target.value }));
    schemeBound = true;
  }
}

export function renderLegend(varKey, scheme) {
  ensureColorSchemeOptions();

  const titleEl = document.querySelector('#main-map-legend .legend-title');
  const itemsEl = document.getElementById('main-map-legend-items');
  if (!titleEl || !itemsEl) return;

  const meta = VARIABLES?.[varKey];
  const title = meta?.display_name_long || meta?.display_name || varKey;
  titleEl.textContent = title;

  const colors = getSchemeColors(scheme);
  const grades = getThresholds(varKey);
  const dataType = meta?.data_type;
  const isCurrency = dataType === 'currency' || /income|value|benefit|amount/.test(dataType || '');
  const divisor =
    isCurrency && grades[0] >= 1_000_000 ? 1_000_000 :
    isCurrency && grades[0] >= 1000 ? 1000 : 1;
  // Decimal-typed variables (e.g. vehicles per capita 0.45–0.78) need enough
  // places that consecutive thresholds stay distinct — reuse the same chooser.
  const decimals = divisor > 1 ? pickDecimalsForGrades(grades, divisor)
    : dataType === 'decimal' ? pickDecimalsForGrades(grades, 1) : 0;

  // Variables that render as circle markers (e.g. Millionaires) get round
  // swatches with a dark slate border that mirrors the on-map stroke.
  const isPoints = meta?.render_type === 'points';
  const swatchStyle = isPoints
    ? 'border-radius:50%;border:1px solid #1f2d3d;'
    : '';

  let html = '';
  for (let i = 0; i < grades.length; i++) {
    // The first class also holds everything below grades[0] (see
    // stepColorExpression), so it reads "<next" instead of "from-next".
    const range = i === 0 && grades.length > 1
      ? `&lt;${formatBound(grades[1], dataType, decimals, divisor)}`
      : formatRange(grades[i], grades[i + 1], dataType, decimals, divisor);
    const c = classColor(i, colors);
    html += `<div class="legend-item"><i style="background:${c};${swatchStyle}"></i><span>${range}</span></div>`;
  }

  itemsEl.innerHTML = html;

  updateReliabilityControl(varKey);
  updateMillionairesControl();
}

let reliabilityBound = false;

// Wires the reliability checkbox: binds the toggle once, reflects current
// state, disables it for non-ACS variables (no MOE to assess), and renders the
// two-tier hatch key when active.
function updateReliabilityControl(varKey) {
  const cb = document.getElementById('reliability-toggle');
  if (!cb) return;
  const s = getState();
  const isAcs = VARIABLES?.[varKey]?.data_source === 'acs';

  if (!reliabilityBound) {
    cb.addEventListener('change', (e) => setState({ showReliability: e.target.checked }));
    reliabilityBound = true;
  }

  cb.checked = !!s.showReliability;
  cb.disabled = !isAcs;
  const wrap = cb.closest('.legend-reliability-toggle');
  if (wrap) {
    wrap.classList.toggle('disabled', !isAcs);
    wrap.title = isAcs ? '' : 'Reliability flags are only available for Census (ACS) estimates';
  }

  const key = document.getElementById('reliability-key');
  if (key) {
    const show = s.showReliability && isAcs;
    key.hidden = !show;
    key.innerHTML = show
      ? `<div class="rel-key-row"><span class="rel-key-swatch rel-caution"></span>Higher uncertainty (CV 15–30%)</div>
         <div class="rel-key-row"><span class="rel-key-swatch rel-unreliable"></span>Unreliable (CV &gt; 30%)</div>`
      : '';
  }
}

let millionairesBound = false;

// Wires the "Show millionaires" checkbox: binds once, reflects current
// state, and shows a compact key (circle = accent color, size = count) only
// while the overlay is on. Unlike reliability, this control stays visible in
// embed mode — the Millionaire Report embeds the dashboard specifically to
// show this overlay, so hiding its own on/off switch there would be wrong.
function updateMillionairesControl() {
  const cb = document.getElementById('millionaires-toggle');
  if (!cb) return;
  const s = getState();

  if (!millionairesBound) {
    cb.addEventListener('change', (e) => setState({ showMillionaires: e.target.checked }));
    millionairesBound = true;
  }

  // When Millionaires IS the selected variable the circles are the map's
  // whole point, so the box reads checked and locks — unchecking it would
  // leave a muted backdrop showing nothing. Pick another variable to get the
  // checkbox back.
  const isVariable = s.selectedVariable === 'millionaires';
  cb.checked = isVariable || !!s.showMillionaires;
  cb.disabled = isVariable;
  const wrap = cb.closest('.legend-millionaires-toggle');
  if (wrap) {
    wrap.classList.toggle('disabled', isVariable);
    wrap.title = isVariable
      ? 'Millionaires is the selected variable — choose another variable to turn this off'
      : '';
  }

  const key = document.getElementById('millionaires-key');
  if (key) {
    const showing = cb.checked;
    key.hidden = !showing;
    // Variable mode colors circles from the scheme picker; overlay mode uses
    // the fixed accent. Mirror whichever is actually on the map.
    const swatchColor = isVariable
      ? (getSchemeColors(s.colorScheme)[6] || '#2171b5')
      : '#ec7014';
    key.innerHTML = showing
      ? `<div class="rel-key-row"><span class="rel-key-swatch" style="border-radius:50%;background-color:${swatchColor};"></span>Circle size = number of millionaires</div>`
      : '';
  }
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
