import { getState, subscribe } from '../state/store.js';
import { getCachedGeoJson } from '../map/layerManager.js';
import { lookupRep, selectFeature } from '../map/popup.js';

// "Find an area": a search box over the map that lists the counties or
// districts of the current geography and selects one as a click would. It is
// the keyboard (and screen-reader) way into the map, and a quicker one for
// anyone who knows a place name or their legislator but not the district.
// Pattern: WAI-ARIA combobox with a listbox popup; focus stays in the input
// and aria-activedescendant tracks the highlighted option.

let els = null;
let options = []; // [{ feature, name, detail, terms }]
let active = -1;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Lowercase, without accents or ʻokina, for matching.
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f\u02bb\u2018\u2019']/g, '').toLowerCase();
}

function cleanName(raw) {
  return String(raw || 'Unknown').replace(/[,;]\s*Hawaii/g, '').replace(/\s*\(\d{4}\)\s*/g, '').trim();
}

// Natural order, so District 2 comes before District 10.
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

function buildOptions() {
  const level = getState().activeLayer;
  const data = getCachedGeoJson(level);
  if (!data) return [];
  return data.features.map((feature) => {
    const p = feature.properties || {};
    const name = cleanName(p.display_name || p.NAME || p.name);
    const rep = lookupRep(p, level);
    const detail = rep ? `${rep.title} ${rep.name}` : '';
    return { feature, level, name, detail, terms: fold([name, rep?.name, rep?.areas].filter(Boolean).join(' ')) };
  }).sort(byName);
}

function render(query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const shown = options.filter((o) => words.every((w) => o.terms.includes(w)));
  els.list.innerHTML = shown.length
    ? shown.map((o, i) => `<li role="option" id="area-opt-${i}" class="area-option" data-i="${options.indexOf(o)}" aria-selected="false">
        <span class="area-option-name">${escapeHtml(o.name)}</span>${o.detail ? `<span class="area-option-detail">${escapeHtml(o.detail)}</span>` : ''}
      </li>`).join('')
    : '<li class="area-empty" role="presentation">No matching areas</li>';
  setActive(shown.length ? 0 : -1);
}

function items() {
  return [...els.list.querySelectorAll('.area-option')];
}

function setActive(i) {
  const list = items();
  list.forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
  active = i;
  if (i >= 0 && list[i]) {
    els.input.setAttribute('aria-activedescendant', list[i].id);
    const li = list[i];
    // Scroll within the list only (scrollIntoView would also move the page).
    if (li.offsetTop < els.list.scrollTop) els.list.scrollTop = li.offsetTop;
    else if (li.offsetTop + li.offsetHeight > els.list.scrollTop + els.list.clientHeight) {
      els.list.scrollTop = li.offsetTop + li.offsetHeight - els.list.clientHeight;
    }
  } else {
    els.input.removeAttribute('aria-activedescendant');
  }
}

function open() {
  if (!options.length) options = buildOptions();
  render(els.input.value);
  els.list.hidden = false;
  els.input.setAttribute('aria-expanded', 'true');
}

function close() {
  els.list.hidden = true;
  els.input.setAttribute('aria-expanded', 'false');
  els.input.removeAttribute('aria-activedescendant');
  active = -1;
}

function choose(li, fromKeyboard) {
  const o = options[Number(li.dataset.i)];
  if (!o) return;
  els.input.value = o.name;
  close();
  // Keyboard users follow the selection into the info panel; Escape brings
  // them back here.
  selectFeature(o.level, o.feature, { focusPanel: fromKeyboard });
}

export function initAreaSearch() {
  const root = document.getElementById('area-search');
  if (!root) return;
  els = {
    input: root.querySelector('input'),
    list: root.querySelector('[role="listbox"]'),
  };
  const { input, list } = els;

  // The list opens on typing, a click or ArrowDown — not on focus alone, so
  // tabbing through (or coming back from the info panel) stays quiet.
  input.addEventListener('click', () => { if (list.hidden) open(); });
  input.addEventListener('input', () => { if (list.hidden) open(); else render(input.value); });
  input.addEventListener('keydown', (e) => {
    const n = items().length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (list.hidden) open(); else if (n) setActive((active + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (n) setActive((active - 1 + n) % n);
        break;
      case 'Enter':
        if (!list.hidden && active >= 0) { e.preventDefault(); choose(items()[active], true); }
        break;
      case 'Escape':
        if (!list.hidden) {
          // Handled here: don't let it also close the info panel.
          e.preventDefault();
          if (input.value) { input.value = ''; render(''); } else close();
        }
        break;
      case 'Tab':
        close();
        break;
      default:
        break;
    }
  });
  // Keep focus in the box while clicking an option.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.area-option');
    if (li) setActive(items().indexOf(li));
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.area-option');
    if (li) choose(li, false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!list.hidden && !root.contains(e.target)) close();
  }, true);

  // A new geography means a new list of areas.
  const placeholder = (level) => {
    const text = level === 'house' || level === 'senate' ? 'Find a district or legislator' : 'Find a county';
    input.placeholder = text;
  };
  placeholder(getState().activeLayer);
  subscribe((state, changed) => {
    if ('activeLayer' in changed) {
      options = [];
      input.value = '';
      close();
      placeholder(state.activeLayer);
    }
  });
}
