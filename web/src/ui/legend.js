import { getSchemeColors, getThresholds, listSchemes, classColor } from '../map/colors.js';
import { getState, setState } from '../state/store.js';

// The map legend: a stepped color bar with the class boundaries under it, and
// a "Map options" menu (color scheme, reliability flags, millionaires).

let VARIABLES = null;
let els = null;

// Binds the legend's controls once. Embeds drop the color-scheme and
// reliability options, and show the millionaires switch in the legend itself:
// the Millionaire Report embeds the dashboard to show that overlay, so its
// on/off switch has to stay in view there.
export function initLegend(variablesConfig, { embedded = false } = {}) {
  VARIABLES = variablesConfig.variables;
  const legend = document.getElementById('main-map-legend');
  if (!legend) return;
  els = {
    legend,
    title: legend.querySelector('.legend-title'),
    scale: legend.querySelector('.legend-scale'),
    bar: legend.querySelector('.legend-bar'),
    ticks: legend.querySelector('.legend-ticks'),
    source: legend.querySelector('.legend-source'),
    relKey: document.getElementById('reliability-key'),
    milKey: document.getElementById('millionaires-key'),
    optionsBtn: document.getElementById('map-options-btn'),
    options: document.getElementById('map-options'),
    schemes: document.getElementById('color-scheme-options'),
    relToggle: document.getElementById('reliability-toggle'),
    relHelp: document.getElementById('reliability-help'),
    milToggle: document.getElementById('millionaires-toggle'),
    milHelp: document.getElementById('millionaires-help'),
  };

  // The bar and ticks are for the eye; screen readers get the ranges as a list.
  els.bar.setAttribute('aria-hidden', 'true');
  els.ticks.setAttribute('aria-hidden', 'true');
  els.ranges = document.createElement('ul');
  els.ranges.className = 'sr-only';
  els.scale.appendChild(els.ranges);

  if (embedded) {
    legend.appendChild(els.milToggle.closest('.mo-switch'));
    els.options.remove();
    els.optionsBtn.remove();
    els.options = els.optionsBtn = els.schemes = els.relToggle = els.relHelp = null;
  } else {
    buildSchemeOptions();
    bindOptionsMenu();
  }

  els.relToggle?.addEventListener('change', (e) => setState({ showReliability: e.target.checked }));
  els.milToggle.addEventListener('change', (e) => setState({ showMillionaires: e.target.checked }));

  // Tick labels thin out when they would collide. Re-check when the legend
  // changes size (breakpoints) or reappears (it has no size behind the Data tab).
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fitTicks()).observe(els.ticks);
}

// ── Labels ─────────────────────────────────────────────────────────────────

function isPercent(dataType) {
  return dataType === 'percentage' || /rate|pct|percent/.test(dataType || '');
}

function isMoney(dataType) {
  return dataType === 'currency' || /income|value|benefit|amount/.test(dataType || '');
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

// One class boundary as a tick label under the bar: 10%, $750, $1.25k, $75M.
function formatTick(value, dataType, decimals) {
  if (isPercent(dataType)) return `${value}%`;
  if (isMoney(dataType)) {
    const short = (x) => String(Number(x.toFixed(2)));
    if (value >= 1_000_000) return `$${short(value / 1_000_000)}M`;
    if (value >= 1000) return `$${short(value / 1000)}k`;
    return `$${value.toLocaleString()}`;
  }
  if (dataType === 'count') return value.toLocaleString();
  if (dataType === 'decimal') return value.toFixed(decimals);
  return `${value}`;
}

// One boundary on its own, as the open-ended ranges print it: the "45%" in
// "45%+", the "$50k" in "<$50k".
function formatBound(value, dataType, decimals, divisor) {
  if (isPercent(dataType)) return `${value}%`;
  if (isMoney(dataType)) {
    // 2-decimal k/M reads worse than full numbers — fall back to comma form.
    if (divisor > 1 && value >= 1_000_000 && decimals < 2) return `$${(value / 1_000_000).toFixed(Math.max(1, decimals))}M`;
    if (divisor > 1 && value >= 1000 && decimals < 2) return `$${(value / 1000).toFixed(decimals)}k`;
    return `$${value.toLocaleString()}`;
  }
  if (dataType === 'count') return value.toLocaleString();
  if (dataType === 'decimal') return value.toFixed(decimals);
  return `${value}`;
}

// A whole class as a range, for the screen-reader list: "10-15%".
function formatRange(from, next, dataType, decimals, divisor) {
  if (next === undefined) return `${formatBound(from, dataType, decimals, divisor)}+`;
  if (dataType === 'decimal') return `${from.toFixed(decimals)}-${next.toFixed(decimals)}`;
  if (isPercent(dataType)) return `${from}-${next}%`;
  if (isMoney(dataType)) {
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
  if (dataType === 'count') return `${from.toLocaleString()}-${next.toLocaleString()}`;
  return `${from}-${next}`;
}

function rangeLabels(grades, dataType) {
  const divisor =
    isMoney(dataType) && grades[0] >= 1_000_000 ? 1_000_000 :
    isMoney(dataType) && grades[0] >= 1000 ? 1000 : 1;
  const decimals = divisor > 1 ? pickDecimalsForGrades(grades, divisor)
    : dataType === 'decimal' ? pickDecimalsForGrades(grades, 1) : 0;
  // The first class also holds everything below grades[0] (see
  // stepColorExpression), so it reads "<next" instead of "from-next".
  return grades.map((g, i) => (i === 0 && grades.length > 1
    ? `<${formatBound(grades[1], dataType, decimals, divisor)}`
    : formatRange(g, grades[i + 1], dataType, decimals, divisor)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── Render ─────────────────────────────────────────────────────────────────

export function renderLegend(varKey, scheme) {
  if (!els) return;
  const meta = VARIABLES?.[varKey];
  const dataType = meta?.data_type;
  els.title.textContent = meta?.display_name_long || meta?.display_name || varKey;

  const colors = getSchemeColors(scheme);
  const grades = getThresholds(varKey);
  const n = grades.length;
  // Circle variables (Millionaires) get dots instead of blocks.
  els.bar.classList.toggle('is-points', meta?.render_type === 'points');
  els.bar.innerHTML = grades
    .map((_, i) => `<span class="legend-step" style="--c:${classColor(i, colors)}"></span>`)
    .join('');
  const decimals = dataType === 'decimal' ? pickDecimalsForGrades(grades, 1) : 0;
  els.ticks.innerHTML = grades.slice(1)
    .map((g, i) => `<span class="legend-tick" style="left:${(((i + 1) / n) * 100).toFixed(3)}%">${escapeHtml(formatTick(g, dataType, decimals))}</span>`)
    .join('');
  fitTicks();
  els.ranges.innerHTML = rangeLabels(grades, dataType).map((r) => `<li>${escapeHtml(r)}</li>`).join('');
  els.source.textContent = meta?.source ? `Source: ${meta.source}` : '';

  updateSchemeOptions(scheme);
  updateReliabilityControl(varKey);
  updateMillionairesControl();
}

// Hide every other tick label when the widest one wouldn't fit its slot.
function fitTicks() {
  const ticks = els?.ticks;
  if (!ticks) return;
  ticks.classList.remove('is-sparse');
  const labels = [...ticks.children];
  const width = ticks.clientWidth;
  if (labels.length < 2 || !width) return;
  const slot = width / (labels.length + 1);
  const widest = Math.max(...labels.map((l) => l.offsetWidth));
  if (widest > slot - 4) ticks.classList.add('is-sparse');
}

// ── Map options menu ───────────────────────────────────────────────────────

function buildSchemeOptions() {
  els.schemes.innerHTML = listSchemes().map((key) => {
    const ramp = getSchemeColors(key).join(', ');
    return `<button type="button" class="scheme-opt" role="radio" aria-checked="false" tabindex="-1" data-scheme="${escapeHtml(key)}"><span class="scheme-ramp" style="background:linear-gradient(90deg, ${ramp})"></span><span>${escapeHtml(capitalize(key))}</span></button>`;
  }).join('');
  els.schemes.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scheme]');
    if (btn) setState({ colorScheme: btn.dataset.scheme });
  });
  // Radio-group keys: arrows move the choice, and focus goes with it.
  els.schemes.addEventListener('keydown', (e) => {
    const buttons = [...els.schemes.querySelectorAll('[data-scheme]')];
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const n = buttons.length;
    const next = {
      ArrowRight: (i + 1) % n,
      ArrowDown: (i + 1) % n,
      ArrowLeft: (i - 1 + n) % n,
      ArrowUp: (i - 1 + n) % n,
      Home: 0,
      End: n - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    buttons[next].focus();
    setState({ colorScheme: buttons[next].dataset.scheme });
  });
}

function updateSchemeOptions(scheme) {
  if (!els.schemes) return;
  for (const btn of els.schemes.querySelectorAll('[data-scheme]')) {
    const on = btn.dataset.scheme === scheme;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
}

function setOptionsOpen(open, focusInside = false) {
  els.options.hidden = !open;
  els.optionsBtn.setAttribute('aria-expanded', String(open));
  if (open && focusInside) {
    (els.schemes.querySelector('[aria-checked="true"]') || els.options.querySelector('button, input:not(:disabled)'))?.focus();
  }
}

function bindOptionsMenu() {
  els.optionsBtn.addEventListener('click', (e) => {
    const open = els.options.hidden;
    // A keyboard click (detail 0) takes focus into the menu.
    setOptionsOpen(open, open && e.detail === 0);
  });
  els.legend.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || els.options.hidden) return;
    e.preventDefault();
    setOptionsOpen(false);
    els.optionsBtn.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!els.options.hidden && !els.legend.contains(e.target)) setOptionsOpen(false);
  }, true);
  els.legend.addEventListener('focusout', (e) => {
    if (!els.options.hidden && e.relatedTarget && !els.legend.contains(e.relatedTarget)) setOptionsOpen(false);
  });
}

// Reflects the reliability switch (only ACS variables carry a margin of error
// to assess) and shows the two-tier hatch key while it's on.
function updateReliabilityControl(varKey) {
  const s = getState();
  const isAcs = VARIABLES?.[varKey]?.data_source === 'acs';
  if (els.relToggle) {
    els.relToggle.checked = !!s.showReliability;
    els.relToggle.disabled = !isAcs;
    els.relToggle.closest('.mo-switch').classList.toggle('is-disabled', !isAcs);
    els.relHelp.textContent = isAcs
      ? 'Hatches areas where the Census estimate is uncertain'
      : 'Only for Census (ACS) estimates';
  }
  const show = s.showReliability && isAcs;
  els.relKey.hidden = !show;
  els.relKey.innerHTML = show
    ? `<div class="key-row"><span class="key-swatch rel-caution"></span>Higher uncertainty (CV 15–30%)</div>
       <div class="key-row"><span class="key-swatch rel-unreliable"></span>Unreliable (CV &gt; 30%)</div>`
    : '';
}

// Reflects the millionaires switch and shows its key while the circles are up.
// When Millionaires IS the selected variable the circles are the map's whole
// point, so the switch reads on and locks — turning it off would leave a
// muted backdrop showing nothing. Pick another variable to get it back.
function updateMillionairesControl() {
  const s = getState();
  const isVariable = s.selectedVariable === 'millionaires';
  const on = isVariable || !!s.showMillionaires;
  els.milToggle.checked = on;
  els.milToggle.disabled = isVariable;
  els.milToggle.closest('.mo-switch').classList.toggle('is-disabled', isVariable);
  els.milHelp.textContent = isVariable
    ? 'On while Millionaires is the selected variable'
    : 'Circles by town, sized by count';
  // Variable mode colors circles from the scheme picker; overlay mode uses
  // the fixed accent. Mirror whichever is actually on the map.
  const color = isVariable ? (getSchemeColors(s.colorScheme)[6] || '#2171b5') : '#ec7014';
  els.milKey.hidden = !on;
  els.milKey.innerHTML = on
    ? `<div class="key-row"><span class="key-swatch is-circle" style="background-color:${color}"></span>Circle size = number of millionaires</div>`
    : '';
}
