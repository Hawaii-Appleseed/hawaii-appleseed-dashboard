// Zoom engine: one animation loop behind
// every zoom the user asks for — wheel, trackpad, pinch, the +/− buttons and
// double-click — so they all move alike and add up. A second click while the
// first is still settling lengthens the same glide instead of restarting it.
//
// What changes from smoothWheelZoom.js (now only a fallback):
//   • The easing is timed, not counted in frames. Each frame closes
//     1 − e^(−dt/τ) of the gap to the target, so a glide takes as long at
//     120Hz as at 60Hz, and a late frame catches up instead of lurching.
//   • τ suits the input. A mouse wheel moves in clicks, so it glides
//     longest; a trackpad already carries the system's momentum, so it barely
//     smooths; a pinch follows the fingers.
//   • The zoom stays on the pointer: each wheel event re-anchors where the
//     cursor is now, not where the gesture began.
//   • The camera moves once a frame, the way MapLibre's own gesture handlers
//     move it (the transform, then 'move' and 'zoom' events), so
//     movestart/zoomstart and zoomend/moveend fire once per gesture instead
//     of twice a frame.
//   • Frames stop once the zoom lands; the gesture ends GESTURE_QUIET_MS after
//     the last input.

import { prefersReducedMotion } from './motion.js';

const ZOOM_PER_PX = 0.003;       // wheel and trackpad, as in smoothWheelZoom.js
const PINCH_ZOOM_PER_PX = 0.012; // a pinch sends small deltas
// A slow click of a mouse wheel on a Mac reports about 4px, a zoom of 0.01:
// too little to see. Each click moves at least this far.
const WHEEL_MIN_STEP = 0.1;
// Time constants in ms; a glide is about 95% done after 3τ.
const TAU = { wheel: 85, trackpad: 28, pinch: 22, button: 80 };
const SETTLE = 0.004;            // zoom levels (0.3% of scale): nearer than this, land
const GESTURE_QUIET_MS = 250;    // no input for this long ends a gesture
const MAX_FRAME_MS = 100;        // how much a stalled frame may catch up
// Safari and Chrome on a Mac report every mouse-wheel delta as a multiple of
// this; MapLibre's own scroll handler tells wheels from trackpads the same way.
const WHEEL_DELTA_UNIT = 4.000244140625;

function wheelInputType(e, delta, previous, sincePrevious) {
  if (e.ctrlKey) return 'pinch'; // a trackpad pinch arrives as ctrl+wheel
  if (e.deltaMode !== 0) return 'wheel'; // lines or pages: a mouse wheel
  if (delta % WHEEL_DELTA_UNIT === 0) return 'wheel';
  if (Math.abs(delta) < 4) return 'trackpad';
  if (previous && sincePrevious < 400) return previous; // same gesture
  return Math.abs(delta) >= 50 ? 'wheel' : 'trackpad';
}

// Take over zooming on `map`. Returns { zoomBy } for the buttons, or null when
// this MapLibre's transform isn't the one the engine was written against (the
// caller then keeps the old wheel zoom).
export function installZoomEngine(map) {
  if (typeof map.transform?.setLocationAtPoint !== 'function') {
    console.warn('[smooth] map.transform has changed; keeping the old wheel zoom');
    return null;
  }
  if (map.scrollZoom) map.scrollZoom.disable();

  const canvas = map.getCanvasContainer();

  let rafId = null;       // the next frame, while gliding
  let quietTimer = null;  // ends the gesture once the input stops
  let inGesture = false;  // movestart/zoomstart sent; zoomend/moveend owed
  let view = 0;           // zoom on screen
  let goal = 0;           // zoom the input has asked for
  let tau = 0;
  let lastFrame = 0;
  let anchor = null;      // { lngLat, point }: the spot that stays put
  let lastInput = null;   // DOM event behind the latest input
  let placed = null;      // { zoom, lng, lat } as the engine last left the camera
  let wheelType = null;
  let lastWheelAt = -Infinity;
  let lastPointerType = 'mouse';

  function remember() {
    const { zoom, center } = map.transform;
    placed = { zoom, lng: center.lng, lat: center.lat };
  }

  // Has something else (a drag, an easeTo, a resize) moved the camera since
  // the engine last did?
  function movedElsewhere() {
    const { zoom, center } = map.transform;
    return !placed || zoom !== placed.zoom || center.lng !== placed.lng || center.lat !== placed.lat;
  }

  function place(z) {
    const tr = map.transform;
    tr.zoom = z; // clamped to the min and max zoom
    if (anchor) tr.setLocationAtPoint(anchor.lngLat, anchor.point);
    remember();
    // The map redraws, and reloads tiles for the new zoom, on these.
    map.fire('move', { originalEvent: lastInput });
    map.fire('zoom', { originalEvent: lastInput });
  }

  // End the gesture. When another camera move has taken over, it sends its
  // own moveend, and ours would land in the middle of it.
  function close() {
    if (!inGesture) return;
    inGesture = false;
    anchor = null;
    if (map.isMoving()) return;
    map.fire('zoomend', { originalEvent: lastInput });
    map.fire('moveend', { originalEvent: lastInput });
  }

  // Stop where the zoom has got to.
  function halt() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    clearTimeout(quietTimer);
    quietTimer = null;
    close();
  }

  function frame(now) {
    rafId = null;
    if (movedElsewhere()) { halt(); return; }
    // The first frame can be stamped before the input that started it.
    const dt = Math.min(now > lastFrame ? now - lastFrame : 8, MAX_FRAME_MS);
    lastFrame = now;
    const gap = goal - view;
    view = Math.abs(gap) < SETTLE || tau <= 0 ? goal : view + gap * (1 - Math.exp(-dt / tau));
    place(view);
    if (view !== goal) rafId = requestAnimationFrame(frame);
    else if (quietTimer == null) close();
  }

  // Add `dz` to the zoom target, keeping `point` (px within the map) where it
  // is on screen, and glide there with time constant `inputTau`.
  function feed(e, dz, point, inputTau) {
    if (inGesture && movedElsewhere()) halt(); // another move took over
    if (!inGesture) {
      map.stop(); // drop an easeTo or flyTo in flight
      view = goal = map.getZoom();
      remember();
      inGesture = true;
      map.fire('movestart', { originalEvent: e });
      map.fire('zoomstart', { originalEvent: e });
    }
    lastInput = e;
    anchor = { point, lngLat: map.unproject([point.x, point.y]) };
    goal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), goal + dz));
    tau = prefersReducedMotion() ? 0 : inputTau;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = null;
      if (rafId == null) close(); // still gliding: the landing frame closes it
    }, GESTURE_QUIET_MS);
    if (rafId == null) {
      lastFrame = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  }

  function pointIn(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Lines → ~40px each, pages → the map's height.
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 40;
    else if (e.deltaMode === 2) delta *= canvas.clientHeight;
    if (!delta) return; // a sideways scroll
    const now = performance.now();
    wheelType = wheelInputType(e, delta, wheelType, now - lastWheelAt);
    lastWheelAt = now;
    let dz = -delta * (wheelType === 'pinch' ? PINCH_ZOOM_PER_PX : ZOOM_PER_PX);
    if (wheelType === 'wheel') dz = Math.sign(dz) * Math.max(Math.abs(dz), WHEEL_MIN_STEP);
    feed(e, dz, pointIn(e), TAU[wheelType]);
  }, { passive: false });

  // Grabbing the map stops a glide where it is.
  canvas.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    halt();
  }, { capture: true, passive: true });

  // Double-click zooms in (shift: out) on the pointer, through the engine.
  // Caught on the way down to the canvas so MapLibre's own double-click zoom
  // never sees it. Touch double-taps are left to MapLibre, which zooms them.
  map.getContainer().addEventListener('dblclick', (e) => {
    if (!canvas.contains(e.target) || lastPointerType === 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    feed(e, e.shiftKey ? -1 : 1, pointIn(e), TAU.button);
  }, { capture: true });

  return {
    // Zoom by `dz` levels on `point` (px within the map; the center if null).
    zoomBy(dz, point, e = null) {
      const p = point ?? map.project(map.getCenter());
      feed(e, dz, { x: p.x, y: p.y }, TAU.button);
    },
  };
}

// The +/− buttons, zooming through the engine. Same markup and classes as
// MapLibre's NavigationControl, so maplibre-gl.css and app.css style them as
// before.
export class ZoomControl {
  constructor(engine) {
    this._engine = engine;
  }

  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = (className, label, dz) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      const icon = document.createElement('span');
      icon.className = 'maplibregl-ctrl-icon';
      icon.setAttribute('aria-hidden', 'true');
      btn.appendChild(icon);
      btn.addEventListener('click', (e) => this._engine.zoomBy(dz, null, e));
      container.appendChild(btn);
      return btn;
    };
    this._in = button('maplibregl-ctrl-zoom-in', 'Zoom in', 1);
    this._out = button('maplibregl-ctrl-zoom-out', 'Zoom out', -1);
    // Grey out a button at the zoom limit, as NavigationControl does.
    this._sync = () => {
      const zoom = map.getZoom();
      const atMax = zoom >= map.getMaxZoom();
      const atMin = zoom <= map.getMinZoom();
      this._in.disabled = atMax;
      this._out.disabled = atMin;
      this._in.setAttribute('aria-disabled', String(atMax));
      this._out.setAttribute('aria-disabled', String(atMin));
    };
    map.on('zoom', this._sync);
    this._sync();
    this._container = container;
    return container;
  }

  onRemove() {
    this._map?.off('zoom', this._sync);
    this._container?.remove();
    this._map = undefined;
  }
}
