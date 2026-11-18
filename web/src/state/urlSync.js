import { getState, setState } from './store.js';

// selectedVariable is intentionally NOT *written* to the URL — within a
// normal session it should reset to ALICE on each load. But it IS read
// one-way on initial load (?var=<key>) so an embed/iframe URL can deep-
// link to a specific variable like Millionaires. Geography + color
// scheme persist round-trip as before.
const KEYS = ['activeLayer', 'colorScheme'];
const READ_ONLY_KEYS = ['selectedVariable']; // read from URL, never written

// `allowed` lists the accepted values per state key. Anything else (a stale or
// mistyped link, or markup pasted into one) is ignored, so the dashboard opens
// on its defaults instead of a geography, variable or scheme it doesn't have.
export function readFromUrl(allowed) {
  // Accept both hash (#layer=...) and search (?var=...) so embed URLs work
  // even without the # — query strings are more iframe-friendly.
  const sources = [];
  if (window.location.hash) sources.push(window.location.hash.slice(1));
  if (window.location.search) sources.push(window.location.search.slice(1));
  if (!sources.length) return;
  const params = new URLSearchParams(sources.join('&'));
  const patch = {};
  for (const k of [...KEYS, ...READ_ONLY_KEYS]) {
    const v = params.get(shortKey(k));
    if (v && allowed[k].includes(v)) patch[k] = v;
  }

  // `?overlay=` lists what to layer on top of the selected variable, comma
  // separated: `millionaires` for the town circles, and/or one area variable
  // drawn as sized rings ("Compare with"), e.g. `?overlay=snap_household_rate,millionaires`.
  // (`?var=millionaires` needs no special handling — Millionaires is a real
  // dropdown variable, so the generic `var` read above already reproduces
  // the Millionaire Report embed's muted look.)
  const overlays = params.getAll('overlay').flatMap((v) => v.split(',')).map((v) => v.trim());
  for (const o of overlays) {
    if (o === 'millionaires') patch.showMillionaires = true;
    else if (!patch.compareVariable && allowed.compareVariable?.includes(o)) patch.compareVariable = o;
  }
  if (patch.compareVariable && patch.compareVariable === (patch.selectedVariable || getState().selectedVariable)) {
    delete patch.compareVariable;
  }

  // Reliability toggle is a boolean — coerce rather than store the raw string.
  const rel = params.get('rel');
  if (rel === '1' || rel === 'true') patch.showReliability = true;
  if (Object.keys(patch).length) setState(patch);
}

export function writeToUrl() {
  const s = getState();
  const params = new URLSearchParams();
  for (const k of KEYS) params.set(shortKey(k), s[k]);
  // Only emit rel when on, to keep the default URL clean.
  if (s.showReliability) params.set('rel', '1');
  // Overlays round-trip so a combination can be linked. Millionaires is only
  // written when it is an overlay: with Millionaires as the variable the
  // switch follows it, and the variable itself is not persisted.
  const overlays = [];
  if (s.compareVariable) overlays.push(s.compareVariable);
  if (s.showMillionaires && s.selectedVariable !== 'millionaires') overlays.push('millionaires');
  if (overlays.length) params.set('overlay', overlays.join(','));
  // Commas read better unescaped in an overlay list, and URLSearchParams
  // decodes them either way.
  const newHash = '#' + params.toString().replace(/%2C/g, ',');
  if (window.location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }
}

function shortKey(k) {
  return { activeLayer: 'layer', selectedVariable: 'var', colorScheme: 'scheme' }[k] || k;
}
