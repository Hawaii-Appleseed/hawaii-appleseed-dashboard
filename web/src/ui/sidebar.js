import { getState, setState } from '../state/store.js';

const LAYERS = [
  { key: 'state', label: 'State Boundary' },
  { key: 'county', label: 'Counties' },
  { key: 'house', label: 'House Districts' },
  { key: 'senate', label: 'Senate Districts' },
];

const TAX_CREDIT_KEYS = new Set([
  'ctc_avg_amount',
  'ctc_participation_rate',
  'federal_eitc_avg_amount',
  'eitc_participation_rate',
  'state_eitc_avg_amount',
]);
const EDUCATION_KEYS = new Set([
  'high_school_or_higher_pct',
  'college_educated_pct',
]);
const RACE_ETHNICITY_KEYS = new Set([
  'nhpi_pct',
  'asian_pct',
  'white_pct',
  'black_pct',
  'hispanic_pct',
]);
const SNAP_KEYS = new Set([
  'snap_household_rate',
  'snap_benefit_annual_per_household',
  'snap_benefits_annual_total',
]);
const CEP_KEYS = new Set(['cep_percentage', 'cep_display']);
const TRANSPORTATION_KEYS = new Set([
  'travel_time_to_work_minutes',
  'public_transportation_pct',
  'avg_vehicles_per_household',
  'zero_vehicle_household_pct',
  'vehicles_per_capita',
]);

const GROUP_DESCRIPTIONS = {
  'Tax Credits': 'Refundable tax credits — like the **Child Tax Credit** and **Earned Income Tax Credit** — that put money back in **working families’** pockets at tax time.',
  'Educational Attainment': 'The **highest level of school or degree** completed by adult residents.',
  'Race & Ethnicity': 'Self-reported race and Hispanic origin from the Census. Race uses **alone or in combination**, so multi-racial residents are counted in every group they identify with — categories overlap and don’t sum to 100%.',
  'SNAP': 'Supplemental Nutrition Assistance Program — **federal food benefits** (formerly food stamps) that help **low-income households** afford groceries.',
  'CEP': 'Community Eligibility Provision — lets schools in high-poverty areas serve **free breakfast and lunch** to **every student** without individual applications.',
  'Housing': 'Cost, ownership, **affordability**, and availability of housing.',
  'Transportation': 'How long, and by what means, residents **commute to work**.',
};

let VARIABLES = null;
let GROUPS = null;

export function initSidebar(variablesConfig) {
  VARIABLES = variablesConfig.variables;
  GROUPS = variablesConfig.dropdown_groups;
}

function variablesForGroup(groupKey) {
  const items = [];
  for (const [key, v] of Object.entries(VARIABLES || {})) {
    if (!v.show_in_dropdown) continue;
    if (v.dropdown_group !== groupKey) continue;
    items.push({ key, ...v });
  }
  items.sort((a, b) => (a.dropdown_order || 999) - (b.dropdown_order || 999));
  return items;
}

function extractYear(source) {
  if (!source) return '';
  const m = String(source).match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

function leaf(v) {
  return {
    key: v.key,
    label: v.dropdown_label || v.display_name,
    tooltip: v.description || '',
    year: extractYear(v.source),
    category: v.info_panel_category || null,
  };
}

function buildEconCascadeItems() {
  const items = variablesForGroup('economic_security');
  const main = items.filter((v) =>
    !TAX_CREDIT_KEYS.has(v.key) &&
    !EDUCATION_KEYS.has(v.key) &&
    !RACE_ETHNICITY_KEYS.has(v.key));
  const tax = items.filter((v) => TAX_CREDIT_KEYS.has(v.key));
  const edu = items.filter((v) => EDUCATION_KEYS.has(v.key));
  const race = items.filter((v) => RACE_ETHNICITY_KEYS.has(v.key));
  const out = main.map(leaf);
  if (tax.length) {
    out.push({ label: 'Tax Credits', tooltip: GROUP_DESCRIPTIONS['Tax Credits'], children: tax.map(leaf) });
  }
  if (edu.length) {
    out.push({ label: 'Educational Attainment', tooltip: GROUP_DESCRIPTIONS['Educational Attainment'], children: edu.map(leaf) });
  }
  if (race.length) {
    out.push({ label: 'Race & Ethnicity', tooltip: GROUP_DESCRIPTIONS['Race & Ethnicity'], children: race.map(leaf) });
  }
  return out;
}

function buildFoodCascadeItems() {
  const items = variablesForGroup('food_security');
  const snap = items.filter((v) => SNAP_KEYS.has(v.key));
  const cep = items.filter((v) => CEP_KEYS.has(v.key));
  const other = items.filter((v) => !SNAP_KEYS.has(v.key) && !CEP_KEYS.has(v.key));
  const out = other.map(leaf);
  if (snap.length) {
    out.push({ label: 'SNAP', tooltip: GROUP_DESCRIPTIONS['SNAP'], children: snap.map(leaf) });
  }
  if (cep.length) {
    out.push({ label: 'CEP', tooltip: GROUP_DESCRIPTIONS['CEP'], children: cep.map(leaf) });
  }
  return out;
}

function buildHousingCascadeItems() {
  const items = variablesForGroup('housing_transportation');
  const housing = items.filter((v) => !TRANSPORTATION_KEYS.has(v.key));
  const transport = items.filter((v) => TRANSPORTATION_KEYS.has(v.key));
  const out = [];
  if (housing.length) {
    out.push({ label: 'Housing', tooltip: GROUP_DESCRIPTIONS['Housing'], children: housing.map(leaf) });
  }
  if (transport.length) {
    out.push({ label: 'Transportation', tooltip: GROUP_DESCRIPTIONS['Transportation'], children: transport.map(leaf) });
  }
  return out;
}

function buildHealthCascadeItems() {
  return variablesForGroup('health').map(leaf);
}

function buildGeographyCascadeItems() {
  return LAYERS.map((l) => ({ key: `layer:${l.key}`, label: l.label }));
}

function findLabelByKey(items, targetKey) {
  for (const it of items) {
    if (it.children) {
      const sub = findLabelByKey(it.children, targetKey);
      if (sub) return sub;
    } else if (it.key === targetKey) {
      return it.label;
    }
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICONS = {
  chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  check: '<svg class="cascade-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7.5"/></svg>',
};

// One line icon per column tag.
const TAG_ICONS = {
  geography: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.25"/>',
  economic_security: '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.4c-.5-.9-1.5-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2 0 2.8 5.6 1.4 5.6 4.1 0 1.2-1.2 2-2.8 2-1.3 0-2.4-.6-2.9-1.5M12 6.5v11"/>',
  food_security: '<path d="M4 3v6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V3M7 3v18M20 15V3a4 4 0 0 0-4 4v6a2 2 0 0 0 2 2h2zm0 0v6"/>',
  housing_transportation: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v11.5h13V9"/><path d="M10 20.5v-5.5h4v5.5"/>',
  health: '<path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
};

function tagIcon(rootKey) {
  const paths = TAG_ICONS[rootKey];
  return paths
    ? `<svg class="ctrl-tag-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
    : '';
}

function tipAttrs(tip, pos, year) {
  if (!tip) return '';
  const parts = [`data-tip="${escapeHtml(tip)}"`];
  if (pos) parts.push(`data-tip-pos="${escapeHtml(pos)}"`);
  if (year) parts.push(`data-tip-year="${escapeHtml(year)}"`);
  return ' ' + parts.join(' ');
}

function renderCascade(rootKey, items, currentKey, placeholder) {
  const currentLabel = currentKey ? findLabelByKey(items, currentKey) : null;
  const triggerText = currentLabel || placeholder;
  const isSelected = !!currentLabel;

  // Items take no Tab stop (tabindex -1): the trigger is the column's one Tab
  // stop and arrow keys move within the menu (see onMenuKeydown).
  function renderItems(list) {
    return list
      .map((it) => {
        if (it.children) {
          // Tooltip lives on the text span only — hovering the caret or
          // empty row area shouldn't fire it. Position "above" so it
          // doesn't cover the submenu that opens to the right on hover.
          return `
            <li class="cascade-parent" role="none">
              <div class="cascade-label" role="menuitem" tabindex="-1" aria-haspopup="menu" aria-expanded="false"><span class="cascade-label-text"${tipAttrs(it.tooltip, 'above')}>${escapeHtml(it.label)}</span><span class="cascade-caret" aria-hidden="true">${ICONS.chevronRight}</span></div>
              <ul class="cascade-menu" role="menu" aria-label="${escapeHtml(it.label)}">${renderItems(it.children)}</ul>
            </li>`;
        }
        const selected = it.key === currentKey;
        return `<li class="cascade-leaf ${selected ? 'cascade-leaf--selected' : ''}" role="none"><a href="#" role="menuitemradio" aria-checked="${selected}" tabindex="-1" data-cascade-key="${escapeHtml(it.key)}"><span class="cascade-leaf-text"${tipAttrs(it.tooltip, 'right', it.year)}>${escapeHtml(it.label)}</span>${ICONS.check}</a></li>`;
      })
      .join('');
  }

  // The trigger is a real button so it takes keyboard focus; its accessible
  // name is the column tag plus the current pick ("Economic Security, ALICE
  // Households").
  return `
    <div class="cascade-root" data-cascade-root="${rootKey}">
      <button type="button" class="cascade-trigger" aria-haspopup="menu" aria-expanded="false" aria-labelledby="ctrl-tag-${rootKey} cascade-current-${rootKey}">
        <span class="cascade-current ${isSelected ? 'is-selected' : 'is-placeholder'}" id="cascade-current-${rootKey}">${escapeHtml(triggerText)}</span>
        <span class="cascade-trigger-caret" aria-hidden="true"><svg viewBox="0 0 12 8" width="11" height="8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1.5l5 5 5-5"/></svg></span>
      </button>
      <ul class="cascade-menu" role="menu" aria-labelledby="ctrl-tag-${rootKey}">${renderItems(items)}</ul>
    </div>`;
}

function renderColumn(rootKey, tag, tagStyle, items, currentKey, placeholder) {
  // Pill style is fixed per column: Geography is solid, every topic is an
  // identical outline pill (we no longer flip the owning topic to solid, so
  // the four topics always read as a uniform set).
  return `
    <div class="ctrl-col">
      <div class="ctrl-tag-wrap"><span class="ctrl-tag ${tagStyle}" id="ctrl-tag-${rootKey}">${tagIcon(rootKey)}${escapeHtml(tag)}</span></div>
      ${renderCascade(rootKey, items, currentKey, placeholder)}
    </div>`;
}

// ── Keyboard and touch access ──────────────────────────────────────────────
// Mouse users open the menus by hovering (CSS). Keyboard users follow the
// WAI-ARIA menu-button pattern: Enter, Space or ArrowDown on a trigger opens
// its menu, arrow keys move through it, ArrowRight/ArrowLeft go into and out
// of sub-menus, and Escape backs out. Touch screens can't hover, so there a
// tap on a trigger or a sub-menu row toggles it open (the `.open` class).
const CAN_HOVER = window.matchMedia?.('(hover: hover)').matches ?? true;
// Below 900px sub-menus unfold in place and open on click, even with a mouse.
const NARROW = window.matchMedia?.('(max-width: 900px)');
let menusBound = false;
let focusTriggerAfterRender = null; // column whose trigger gets focus back after a keyboard pick

function menuItems(menu) {
  return [...menu.children].map((li) => li.firstElementChild).filter(Boolean);
}

// `el` is a .cascade-root or a .cascade-parent; closing it closes its sub-menus.
function setOpen(el, open) {
  el.classList.toggle('open', open);
  el.querySelector(':scope > .cascade-trigger, :scope > .cascade-label')
    ?.setAttribute('aria-expanded', String(open));
  if (!open) el.querySelectorAll('.cascade-parent.open').forEach((p) => setOpen(p, false));
}

function closeMenus(bar, except = null) {
  bar.querySelectorAll('.cascade-root.open').forEach((r) => { if (r !== except) setOpen(r, false); });
  hideTooltip();
}

// Focus a menu item and show the description mouse users get on hover.
function focusItem(el) {
  if (!el) return;
  el.focus();
  const tip = el.querySelector('[data-tip]');
  if (tip) showTooltip(tip, tip.dataset.tip, tip.dataset.tipPos, tip.dataset.tipYear);
  else hideTooltip();
}

function openRoot(bar, root, focus) {
  closeMenus(bar, root);
  setOpen(root, true);
  const items = menuItems(root.querySelector(':scope > .cascade-menu'));
  if (focus === 'first') focusItem(items[0]);
  if (focus === 'last') focusItem(items[items.length - 1]);
}

function openSubmenu(li, focus) {
  for (const sibling of li.parentElement.children) {
    if (sibling !== li && sibling.classList.contains('open')) setOpen(sibling, false);
  }
  setOpen(li, true);
  if (focus) focusItem(menuItems(li.querySelector(':scope > .cascade-menu'))[0]);
}

function pick(bar, leaf, byKeyboard) {
  const root = leaf.closest('.cascade-root');
  const key = leaf.dataset.cascadeKey;
  const patch = key.startsWith('layer:')
    ? { activeLayer: key.slice('layer:'.length) }
    : { selectedVariable: key };
  const [prop, value] = Object.entries(patch)[0];
  closeMenus(bar);
  if (byKeyboard) {
    // A real change re-renders the bar and destroys the focused item, so the
    // trigger gets focus back after that render; otherwise straight away.
    if (getState()[prop] !== value) focusTriggerAfterRender = root.dataset.cascadeRoot;
    else root.querySelector('.cascade-trigger').focus();
  }
  setState(patch);
}

function onMenuKeydown(bar, e) {
  const root = e.target.closest('.cascade-root');
  if (!root) return;
  if (e.target.matches('.cascade-trigger')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openRoot(bar, root, e.key === 'ArrowDown' ? 'first' : 'last');
    } else if (e.key === 'Escape') {
      closeMenus(bar);
    }
    return;
  }
  const item = e.target.closest('.cascade-label, a[data-cascade-key]');
  if (!item) return;
  const li = item.parentElement;
  const isParent = li.classList.contains('cascade-parent');
  const items = menuItems(li.parentElement);
  const i = items.indexOf(item);
  const owner = li.parentElement.parentElement.closest('.cascade-parent'); // set inside a sub-menu
  const backOut = () => {
    setOpen(owner, false);
    focusItem(owner.querySelector(':scope > .cascade-label'));
  };
  switch (e.key) {
    case 'ArrowDown': focusItem(items[(i + 1) % items.length]); break;
    case 'ArrowUp': focusItem(items[(i - 1 + items.length) % items.length]); break;
    case 'Home': focusItem(items[0]); break;
    case 'End': focusItem(items[items.length - 1]); break;
    case 'ArrowRight':
      if (!isParent) return;
      openSubmenu(li, true);
      break;
    case 'ArrowLeft':
      if (!owner) return;
      backOut();
      break;
    case 'Enter':
    case ' ':
      if (isParent) openSubmenu(li, true);
      else item.click();
      break;
    case 'Escape':
      if (owner) {
        backOut();
      } else {
        closeMenus(bar);
        root.querySelector('.cascade-trigger').focus();
      }
      break;
    case 'Tab':
      // Leave from the trigger, so Tab and Shift+Tab land on the neighbouring
      // columns rather than wherever the hidden item sat.
      root.querySelector('.cascade-trigger').focus();
      closeMenus(bar);
      return;
    default:
      return;
  }
  e.preventDefault();
}

// Bound once: the bar element persists while renderSidebar swaps its contents.
function bindMenus(bar) {
  bar.addEventListener('click', (e) => {
    const byKeyboard = e.detail === 0; // Enter/Space and item.click() report detail 0
    const trigger = e.target.closest('.cascade-trigger');
    const label = e.target.closest('.cascade-label');
    const leaf = e.target.closest('a[data-cascade-key]');
    if (trigger) {
      // A mouse has already opened the menu by hovering; toggling on its
      // click too would pin the menu open after the pointer leaves.
      if (CAN_HOVER && !byKeyboard) return;
      const root = trigger.closest('.cascade-root');
      if (root.classList.contains('open')) closeMenus(bar);
      else openRoot(bar, root, byKeyboard ? 'first' : null);
    } else if (label) {
      // Wide screens: hover opens sub-menus; keys go through keydown.
      if (CAN_HOVER && !NARROW?.matches) return;
      const li = label.parentElement;
      if (li.classList.contains('open')) setOpen(li, false);
      else openSubmenu(li, false);
    } else if (leaf) {
      e.preventDefault();
      pick(bar, leaf, byKeyboard);
    }
  });
  bar.addEventListener('keydown', (e) => onMenuKeydown(bar, e));
  // Tabbing away or tapping elsewhere closes a menu opened by keyboard or touch.
  bar.addEventListener('focusout', (e) => {
    const root = e.target.closest('.cascade-root');
    if (root && !root.contains(e.relatedTarget)) {
      setOpen(root, false);
      hideTooltip();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!bar.contains(e.target)) closeMenus(bar);
  }, true);
  // Hovering another column shouldn't leave a keyboard-opened menu showing too.
  bar.addEventListener('mouseover', (e) => {
    const root = e.target.closest('.cascade-root');
    if (!root) return;
    bar.querySelectorAll('.cascade-root.open').forEach((r) => { if (r !== root) setOpen(r, false); });
  });
}

let TOOLTIP_EL = null;
let TOOLTIP_TIMER = null;

function ensureTooltipEl() {
  if (TOOLTIP_EL) return TOOLTIP_EL;
  const el = document.createElement('div');
  el.className = 'cascade-tooltip';
  el.setAttribute('role', 'tooltip');
  el.style.opacity = '0';
  document.body.appendChild(el);
  TOOLTIP_EL = el;
  return el;
}

// Process tooltip body text:
//   1. **phrase** is converted to <mark>phrase</mark> (manual highlight markup)
//   2. percentages and dollar amounts outside of marked phrases are auto-highlighted
// Input is HTML-escaped per segment so no user content is injected as raw HTML.
function highlightNumbers(escaped) {
  return escaped
    .replace(/(\$[\d,]+(?:\.\d+)?)/g, '<mark>$1</mark>')
    .replace(/(\d+(?:\.\d+)?%)/g, '<mark>$1</mark>');
}

function buildTooltipBody(text) {
  const re = /\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let result = '';
  let match;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIdx, match.index);
    result += highlightNumbers(escapeHtml(before));
    result += `<mark>${escapeHtml(match[1])}</mark>`;
    lastIdx = match.index + match[0].length;
  }
  result += highlightNumbers(escapeHtml(text.slice(lastIdx)));
  return result;
}

function renderTooltipContent(text, year) {
  const yearBadge = year
    ? `<div class="tip-year">Data year ${escapeHtml(year)}</div>`
    : '';
  return `<div class="cascade-tooltip-text">${buildTooltipBody(text)}</div>${yearBadge}`;
}

function positionTooltip(target, pos) {
  const el = TOOLTIP_EL;
  if (!el) return;
  const r = target.getBoundingClientRect();
  const margin = 10;
  el.style.maxWidth = '280px';
  el.style.left = '0';
  el.style.top = '0';
  // Force layout to measure size
  const tw = el.offsetWidth;
  const th = el.offsetHeight;

  if (pos === 'above') {
    // Center horizontally on the text, place above; flip below if no room.
    let left = r.left + (r.width - tw) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.top - margin - th;
    if (top < 8) top = r.bottom + margin;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    return;
  }

  // Default: prefer to the right of the item; fall back to left if it would overflow.
  let left = r.right + margin;
  if (left + tw > window.innerWidth - 8) {
    left = Math.max(8, r.left - margin - tw);
  }
  let top = r.top + (r.height - th) / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function showTooltip(target, text, pos, year) {
  const el = ensureTooltipEl();
  el.innerHTML = renderTooltipContent(text, year);
  el.style.opacity = '0';
  el.style.display = 'block';
  // Delay so it doesn't fire on quick passes.
  clearTimeout(TOOLTIP_TIMER);
  TOOLTIP_TIMER = setTimeout(() => {
    positionTooltip(target, pos);
    el.style.opacity = '1';
  }, 220);
}

function hideTooltip() {
  clearTimeout(TOOLTIP_TIMER);
  if (!TOOLTIP_EL) return;
  TOOLTIP_EL.style.opacity = '0';
}

function attachTooltipListeners(root) {
  // On a touch screen a tap would pop the tooltip up over the menu being used,
  // so hover tooltips are mouse-only. Keyboard focus shows them via focusItem.
  if (!CAN_HOVER) return;
  const tipped = root.querySelectorAll('[data-tip]');
  tipped.forEach((node) => {
    const pos = node.dataset.tipPos;
    const year = node.dataset.tipYear;
    node.addEventListener('mouseenter', () => showTooltip(node, node.dataset.tip, pos, year));
    node.addEventListener('mouseleave', hideTooltip);
  });
}

export function renderSidebar() {
  const root = document.getElementById('controls-bar');
  if (!root) return;
  // Selecting a variable re-renders the whole controls bar via innerHTML,
  // which removes the currently-hovered node *without* firing its
  // mouseleave — leaving the global tooltip stuck at opacity:1. Hide it
  // (and cancel any pending show-timer) before we blow away the old DOM.
  hideTooltip();
  const s = getState();

  const geoItems = buildGeographyCascadeItems();
  const econItems = buildEconCascadeItems();
  const foodItems = buildFoodCascadeItems();
  const housingItems = buildHousingCascadeItems();
  const healthItems = buildHealthCascadeItems();

  const layerKey = `layer:${s.activeLayer}`;
  const variableKey = s.selectedVariable;

  const geoCol = renderColumn(
    'geography',
    'Geography',
    'tag-solid',
    geoItems,
    layerKey,
    'Select Geography',
    );
  const econCol = renderColumn(
    'economic_security',
    GROUPS?.economic_security?.label || 'Economic Security',
    'tag-outline',
    econItems,
    variableKey,
    'Select Variable',
    );
  const foodCol = renderColumn(
    'food_security',
    GROUPS?.food_security?.label || 'Food Security',
    'tag-outline',
    foodItems,
    variableKey,
    'Select Variable',
    );
  const housingCol = renderColumn(
    'housing_transportation',
    GROUPS?.housing_transportation?.label || 'Housing & Transportation',
    'tag-outline',
    housingItems,
    variableKey,
    'Select Variable',
    );
  const healthCol = renderColumn(
    'health',
    GROUPS?.health?.label || 'Health',
    'tag-outline',
    healthItems,
    variableKey,
    'Select Variable',
    );

  // "Choose your variable" label sits in its own grid row above the four
  // topic columns (CSS pins it to columns 2/-1, so it reads as a header for
  // the variable pickers, not for the Geography selector).
  const varHeader = '<div class="ctrl-header">Choose your variable</div>';
  root.innerHTML = geoCol + varHeader + econCol + foodCol + housingCol + healthCol;

  if (!menusBound) {
    bindMenus(root);
    menusBound = true;
  }
  attachTooltipListeners(root);

  if (focusTriggerAfterRender) {
    root.querySelector(`[data-cascade-root="${focusTriggerAfterRender}"] .cascade-trigger`)?.focus();
    focusTriggerAfterRender = null;
  }
}

export function reflectSidebar() {
  renderSidebar();
}
