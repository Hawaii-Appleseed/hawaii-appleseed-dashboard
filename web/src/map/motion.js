// Motion shared by the ?smooth=1 map (see perfFlags.js): the easing curves,
// the reduced-motion check, and the camera trip that frames a picked area or
// goes back to the starting view.

import maplibregl from 'maplibre-gl';

// A CSS cubic-bezier() timing function: finds the point on the curve whose x
// is `t` (Newton's method, then bisection if that stalls) and returns its y.
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (s) => ((ax * s + bx) * s + cx) * s;
  const y = (s) => ((ay * s + by) * s + cy) * s;
  const slope = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = x(s) - t;
      if (Math.abs(err) < 1e-6) return y(s);
      const d = slope(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0, hi = 1;
    s = t;
    for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
      if (x(s) < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return y(s);
  };
}

// Answering the user's own input (a pointer arriving, a click): under way at
// once, settling gently. The --ease curve in app.css, so the map moves like
// the rest of the page.
export const easeOut = cubicBezier(0.2, 0, 0, 1);

// Camera trips (framing a picked area, Reset view): a soft start, so going
// somewhere new reads as travel rather than a lurch.
export const easeInOut = cubicBezier(0.4, 0, 0.2, 1);

const reducedMotion = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;
export const prefersReducedMotion = () => !!reducedMotion?.matches;

// A trip takes longer the further it goes: about 0.45s to a neighbouring
// district, 0.8s from the whole state down to one, and at most TRIP_MAX_MS
// between islands.
const TRIP_MIN_MS = 350;
const TRIP_MS_PER_STEP = 100;
const TRIP_MAX_MS = 1000;
// A target further than this many screen widths away (measured at the
// zoomed-out end) flies, rising to keep both ends in view. Nearer ones glide
// straight there, so a short hop doesn't bob out and back in.
const FLY_BEYOND = 0.6;

// Move the camera to `cam` ({ center, zoom }, as from cameraForBounds), as
// fitBounds would but paced by the distance. Not marked essential, so MapLibre
// cuts straight there for anyone whose system asks for reduced motion.
export function cameraTrip(map, cam) {
  const z0 = map.getZoom();
  const z1 = cam.zoom ?? z0;
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const from = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());
  const to = maplibregl.MercatorCoordinate.fromLngLat(cam.center);
  const worldPx = 512 * 2 ** Math.min(z0, z1);
  const pan = (Math.hypot(to.x - from.x, to.y - from.y) * worldPx) / Math.max(w, h, 1);
  // Zoom levels crossed, plus the pan on a log scale (a pan of one screen
  // counts as two levels).
  const steps = Math.abs(z1 - z0) + 2 * Math.log2(1 + pan);
  const duration = Math.round(Math.min(TRIP_MAX_MS, TRIP_MIN_MS + TRIP_MS_PER_STEP * steps));
  const options = { center: cam.center, zoom: z1, duration, easing: easeInOut };
  if (pan > FLY_BEYOND) map.flyTo(options);
  else map.easeTo(options);
}
