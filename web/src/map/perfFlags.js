// Runtime A/B toggles for performance investigation. All flags are URL-param
// driven so a single dev build can serve every combination without recompiling.
// Production loads with no params → every flag is false → behavior unchanged.
//
// Flags:
//   ?notrans=1   — strip *-opacity-transition directives in layerManager
//                  (kills the 300ms tween that runs after every hover state change)
//   ?nohover=1   — don't bind the layer-scoped mousemove/click handlers at all
//                  (kills MapLibre's per-mousemove queryRenderedFeatures hit-test)
//   ?noglass=1   — at boot, strip the backdrop-filter blur on .map-legend
//   ?nopanel=1   — disable info-panel + its sliding transition
//   ?nofade=1    — disable the 300ms layer-switch fade animation
//   ?nonav=1     — don't add NavigationControl / ResetControl
//   ?lowdpr=N    — clamp pixelRatio to N (e.g. ?lowdpr=1)
//   ?smooth=1    — smoother map motion, on trial: hover outlines that fade in
//                  and out (featureFade.js), one timed zoom engine behind the
//                  wheel, trackpad, +/− buttons and double-click
//                  (zoomEngine.js; it takes over from ?stock), camera trips
//                  paced by distance (motion.js), a new geography fading in
//                  over the old, and the map dimming around a picked area
//                  gradually (layerManager.js)

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();

function flag(name) {
  return params.has(name) && params.get(name) !== '0' && params.get(name) !== 'false';
}

export const FLAGS = {
  noTransitions: flag('notrans'),
  noHover: flag('nohover'),
  noGlass: flag('noglass'),
  noPanel: flag('nopanel'),
  noFade: flag('nofade'),
  noNav: flag('nonav'),
  lowDpr: params.has('lowdpr') ? parseFloat(params.get('lowdpr')) : null,
  stockWheelZoom: flag('stock'), // ?stock=1 keeps MapLibre's built-in wheel handler (for A/B)
  smooth: flag('smooth'),
};

if (typeof window !== 'undefined') {
  window.__perfFlags = FLAGS;
  // Apply CSS-level kills synchronously at module load so they take effect
  // before first paint.
  if (FLAGS.noGlass) {
    const css = `
      .map-wrap::before { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
      .map-legend { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
    `;
    const el = document.createElement('style');
    el.setAttribute('data-perf-flag', 'noglass');
    el.textContent = css;
    document.head.appendChild(el);
  }
  if (FLAGS.noPanel) {
    const el = document.createElement('style');
    el.setAttribute('data-perf-flag', 'nopanel');
    el.textContent = `.info-panel { display: none !important; }`;
    document.head.appendChild(el);
  }
  // Only worth logging when a flag is actually set.
  if (Object.values(FLAGS).some((v) => v !== false && v !== null)) {
    // eslint-disable-next-line no-console
    console.log('[perfFlags]', FLAGS);
  }
}
