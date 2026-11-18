const state = {
  activeLayer: 'county',
  selectedVariable: 'alice_rate',
  colorScheme: 'blue',
  showReliability: false,
  // "Show millionaires" checkbox — layers the circles on top of whatever
  // choropleth is selected. Selecting Millionaires as the variable itself
  // also shows the circles (in muted "variable mode"); that case is derived
  // from selectedVariable, not stored here.
  showMillionaires: false,
  // "Compare with" — a second area variable drawn as sized rings at each
  // area's center, on top of the choropleth (null when off). Never the same
  // as selectedVariable, and never a points variable (Millionaires has its
  // own switch above).
  compareVariable: null,
  displayOptions: { showLabels: false, showLegend: true },
  selectedFeatureId: null,
};

const subs = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  const before = { ...state };
  Object.assign(state, patch);
  const changed = {};
  for (const k of Object.keys(patch)) {
    if (before[k] !== state[k]) changed[k] = state[k];
  }
  if (Object.keys(changed).length === 0) return;
  subs.forEach((fn) => fn(state, changed));
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
