import { getState } from '../state/store.js';
import { lookupRep } from '../map/popup.js';
import { getColorForValue } from '../map/colors.js';

let VARIABLES = null;
let CATEGORIES = null;
let floatingTip = null;

export function initInfoPanel(variablesConfig) {
  VARIABLES = variablesConfig.variables;
  CATEGORIES = variablesConfig.info_panel_categories;
}

function extractYear(source) {
  if (!source) return '';
  const m = String(source).match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

function ensureFloatingTip() {
  if (floatingTip) return floatingTip;
  floatingTip = document.createElement('div');
  floatingTip.className = 'ip-floating-tip';
  floatingTip.setAttribute('role', 'tooltip');
  document.body.appendChild(floatingTip);
  return floatingTip;
}

function positionTip(target) {
  const tip = ensureFloatingTip();
  const r = target.getBoundingClientRect();
  tip.classList.remove('below');
  // Measure off-screen without touching visibility/opacity
  const savedPos = tip.style.cssText;
  tip.style.position = 'fixed';
  tip.style.left = '-9999px';
  tip.style.top = '-9999px';
  const tipRect = tip.getBoundingClientRect();
  const wantTop = r.top - tipRect.height - 10;
  const placeBelow = wantTop < 8;
  let left = r.left + r.width / 2 - tipRect.width / 2;
  const margin = 8;
  if (left < margin) left = margin;
  if (left + tipRect.width > window.innerWidth - margin)
    left = window.innerWidth - margin - tipRect.width;
  const top = placeBelow ? r.bottom + 10 : wantTop;
  tip.classList.toggle('below', placeBelow);
  const arrowX = r.left + r.width / 2 - left;
  tip.style.setProperty('--tip-arrow-x', `${arrowX}px`);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function bindMetricTooltips(panel) {
  const tip = ensureFloatingTip();
  let hideTimer = null;

  const cancelHide = () => { clearTimeout(hideTimer); hideTimer = null; };
  const scheduleHide = () => {
    cancelHide();
    hideTimer = setTimeout(() => tip.classList.remove('visible'), 200);
  };

  const showFor = (el) => {
    cancelHide();
    const html = tipHtml(el);
    if (!html) return;
    tip.innerHTML = html;
    tip.classList.add('visible');
    positionTip(el);
  };

  panel.querySelectorAll('.ip-metric').forEach((el) => {
    el.addEventListener('mouseenter', () => showFor(el));
    el.addEventListener('mouseleave', scheduleHide);
    el.addEventListener('focus', () => showFor(el));
    el.addEventListener('blur', scheduleHide);
  });
  panel.addEventListener('scroll', () => { cancelHide(); tip.classList.remove('visible'); }, { passive: true });
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

// Formats a margin of error in the metric's own units, prefixed with ±.
// Returns '' if there is no usable MOE value.
function formatMoe(moe, dataType) {
  if (moe === undefined || moe === null || moe === '') return '';
  const num = parseFloat(moe);
  if (isNaN(num)) return '';
  if (dataType === 'percentage' || /rate|pct|percent/.test(dataType || '')) return `± ${num.toFixed(1)}%`;
  if (dataType === 'currency' || /income|value|benefit|amount/.test(dataType || '')) return `± $${Math.round(num).toLocaleString()}`;
  if (dataType === 'minutes') return `± ${num.toFixed(1)} min`;
  if (dataType === 'decimal') return `± ${num.toFixed(2)}`;
  if (dataType === 'count') return `± ${Math.round(num).toLocaleString()}`;
  return `± ${num.toLocaleString()}`;
}

// Honest note for statistics that have no sampling margin of error
// (administrative counts and modeled estimates from non-ACS sources).
function moeNote(dataSource) {
  if (dataSource === 'snap' || dataSource === 'cep') return 'Administrative data — no sampling margin of error';
  if (dataSource === 'alice' || dataSource === 'tax_credits') return 'Modeled estimate — margin of error not published';
  return 'Margin of error not available';
}

// Resolves the {moe, note} pair for a variable + feature: a formatted ±MOE
// string for ACS metrics that carry one, otherwise an explanatory note.
function moeFor(meta, properties) {
  const col = meta.csv_column || meta.key;
  const raw = col ? properties[`${col}_moe`] : undefined;
  const moe = formatMoe(raw, meta.data_type);
  return moe ? { moe, note: '' } : { moe: '', note: moeNote(meta.data_source) };
}

// Tooltip markup for the MOE line (either the ± value at 90% CI, or the note).
function moeTipHtml(moe, note) {
  if (moe) return `<div class="ip-tip-moe">${escapeHtml(moe)} <span class="ip-tip-moe-ci">90% confidence</span></div>`;
  if (note) return `<div class="ip-tip-moe ip-tip-moe-na">${escapeHtml(note)}</div>`;
  return '';
}

// Tooltip markup for the headline or a metric, built from its data-*
// attributes; '' when there's nothing to show. getAttribute returns the
// unescaped text, so everything is escaped (and **phrases** highlighted) here.
function tipHtml(el) {
  const desc = el.getAttribute('data-desc') || '';
  const year = el.getAttribute('data-year') || '';
  const label = el.getAttribute('data-label') || '';
  const moe = el.getAttribute('data-moe') || '';
  const note = el.getAttribute('data-moe-note') || '';
  if (!desc && !year && !moe && !note) return '';
  return `
    ${label ? `<div class="ip-tip-title">${escapeHtml(label)}</div>` : ''}
    ${desc ? `<div class="ip-tip-desc">${renderDescription(desc)}</div>` : ''}
    ${moeTipHtml(moe, note)}
    ${year ? `<div class="tip-year">Data year ${escapeHtml(year)}</div>` : ''}
  `;
}

function variablesByCategory() {
  const map = {};
  for (const [key, v] of Object.entries(VARIABLES || {})) {
    if (!v.show_in_info_panel) continue;
    const cat = v.info_panel_category;
    if (!cat) continue;
    if (!map[cat]) map[cat] = [];
    map[cat].push({ key, ...v });
  }
  for (const cat of Object.keys(map)) {
    map[cat].sort((a, b) => (a.info_panel_order || 999) - (b.info_panel_order || 999));
  }
  return map;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Renders a description for tooltip display: converts **phrase** to <mark>
// pills, auto-highlights percentages and dollar amounts. Returns HTML.
function renderDescription(text) {
  if (!text) return '';
  const highlightNumbers = (esc) => esc
    .replace(/(\$[\d,]+(?:\.\d+)?)/g, '<mark>$1</mark>')
    .replace(/(\d+(?:\.\d+)?%)/g, '<mark>$1</mark>');
  const re = /\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let result = '';
  let match;
  while ((match = re.exec(text)) !== null) {
    result += highlightNumbers(escapeHtml(text.slice(lastIdx, match.index)));
    result += `<mark>${escapeHtml(match[1])}</mark>`;
    lastIdx = match.index + match[0].length;
  }
  result += highlightNumbers(escapeHtml(text.slice(lastIdx)));
  return result;
}

function cleanName(rawName) {
  let name = rawName || 'Unknown';
  name = name.replace(/[,;]\s*Hawaii/g, '').trim();
  name = name.replace(/\s*\(\d{4}\)\s*/g, '').trim();
  return name;
}

// Where focus goes back to when a panel opened from the keyboard closes.
let returnFocus = null;

export function showInfoPanel(properties, { focus = false } = {}) {
  const panel = document.getElementById('info-panel');
  if (!panel) return;
  if (focus) returnFocus = document.activeElement;

  const s = getState();
  const geoid = properties.GEOID || properties.geoid || '';
  const name = cleanName(properties.display_name || properties.NAME || properties.name || `Geography ${geoid}`);
  const factsheetUrl = `${import.meta.env.BASE_URL}factsheet.html?geo_id=${encodeURIComponent(geoid)}&level=${encodeURIComponent(s.activeLayer)}`;

  const selectedVar = VARIABLES?.[s.selectedVariable];
  const selectedDisplayName =
    selectedVar?.info_panel_label || selectedVar?.display_name || (s.selectedVariable || '').replace(/_/g, ' ');
  const selectedValue = formatValue(properties[s.selectedVariable], selectedVar?.data_type);
  const selectedDesc = selectedVar?.description || '';
  const selectedYear = extractYear(selectedVar?.source);
  const selectedMoe = selectedVar
    ? moeFor({ ...selectedVar, key: s.selectedVariable }, properties)
    : { moe: '', note: '' };

  const grouped = variablesByCategory();
  const cats = Object.entries(CATEGORIES || {})
    .sort((a, b) => (a[1].order || 0) - (b[1].order || 0))
    .map(([k]) => k);

  let body = '';
  for (const cat of cats) {
    const items = (grouped[cat] || []).filter((m) => properties[m.key] !== undefined && properties[m.key] !== null);
    if (!items.length) continue;
    body += `<section class="ip-category"><h3>${escapeHtml(cat)}</h3><div class="ip-metrics">`;
    for (const m of items) {
      const isSelected = m.key === s.selectedVariable;
      let displayValue = formatValue(properties[m.key], m.data_type);
      if (m.key === 'cep_display') {
        displayValue = String(properties[m.key]).replace(/\s*CEP\s*schools?/i, '').trim();
      }
      const desc = m.description || '';
      const year = extractYear(m.source);
      const label = m.info_panel_label || m.display_name || '';
      const { moe, note } = moeFor(m, properties);
      body += `
        <div class="ip-metric ${isSelected ? 'selected' : ''}"
             tabindex="0"
             data-desc="${escapeHtml(desc)}"
             data-year="${escapeHtml(year)}"
             data-label="${escapeHtml(label)}"
             data-moe="${escapeHtml(moe)}"
             data-moe-note="${escapeHtml(note)}">
          <div class="ip-metric-value">${escapeHtml(displayValue)}</div>
          <div class="ip-metric-label">${escapeHtml(label)}</div>
        </div>`;
    }
    body += '</div></section>';
  }

  const rep = lookupRep(properties, s.activeLayer);
  const repHtml = rep
    ? `<div class="ip-rep">
         <div class="ip-rep-label">${escapeHtml(rep.title)}</div>
         <div class="ip-rep-name">${escapeHtml(rep.name)} <span class="ip-rep-party">(${escapeHtml(rep.party)})</span></div>
         <div class="ip-rep-areas">${escapeHtml((rep.areas || '').trim())}</div>
       </div>`
    : '';

  // The place's own color on the map, beside the headline figure.
  const rawValue = parseFloat(properties[s.selectedVariable]);
  const swatch = !isNaN(rawValue) && selectedVar?.render_type !== 'points'
    ? `<span class="ip-swatch" style="background:${getColorForValue(rawValue, s.selectedVariable, s.colorScheme)}" aria-hidden="true"></span>`
    : '';

  panel.innerHTML = `
    <div class="ip-head">
      <h2 class="ip-title" tabindex="-1">${escapeHtml(name)}</h2>
      <button type="button" class="icon-btn ip-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <div class="ip-headline"
         tabindex="0"
         data-desc="${escapeHtml(selectedDesc)}"
         data-year="${escapeHtml(selectedYear)}"
         data-label="${escapeHtml(selectedDisplayName)}"
         data-moe="${escapeHtml(selectedMoe.moe)}"
         data-moe-note="${escapeHtml(selectedMoe.note)}">
      <div class="ip-headline-label">${swatch}${escapeHtml(selectedDisplayName)}</div>
      <div class="ip-headline-value">${escapeHtml(selectedValue)}</div>
      ${selectedYear ? `<div class="ip-headline-meta">Data year ${escapeHtml(selectedYear)}</div>` : ''}
    </div>
    ${repHtml}
    <a class="btn btn-primary ip-btn" href="${factsheetUrl}" target="_blank" rel="noopener">
      <span>View / print fact sheet</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></svg>
    </a>
    ${body}
  `;
  panel.classList.add('visible');

  panel.querySelector('.ip-close')?.addEventListener('click', hideInfoPanel);
  // Opened from the keyboard: take focus into the panel so it's read out.
  if (focus) panel.querySelector('.ip-title')?.focus({ preventScroll: true });

  // Bind tooltips for headline + each metric
  const headline = panel.querySelector('.ip-headline');
  if (headline) bindHeadlineTooltip(headline);
  bindMetricTooltips(panel);
}

function bindHeadlineTooltip(el) {
  const tip = ensureFloatingTip();
  const showFor = () => {
    const html = tipHtml(el);
    if (!html) return;
    tip.innerHTML = html;
    tip.classList.add('visible');
    positionTip(el);
  };
  const hide = () => tip.classList.remove('visible');
  el.addEventListener('mouseenter', showFor);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', showFor);
  el.addEventListener('blur', hide);
}

// Escape closes the panel (unless a menu or popover is handling it).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (document.querySelector('.cascade-root.open, #map-options:not([hidden])')) return;
  if (document.getElementById('info-panel')?.classList.contains('visible')) hideInfoPanel();
});

export function hideInfoPanel() {
  const panel = document.getElementById('info-panel');
  if (panel) {
    const hadFocus = panel.contains(document.activeElement);
    panel.classList.remove('visible');
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
  if (floatingTip) floatingTip.classList.remove('visible');
}
