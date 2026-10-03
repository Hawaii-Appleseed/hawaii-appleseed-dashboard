// Hover fades for ?smooth=1 (see perfFlags.js).
//
// MapLibre can't fade the hover itself: its paint transitions skip any value
// that depends on feature state, so a `hover` flag changes the style in a
// single frame. Here `hover` is a number from 0 to 1 instead, stepped every
// frame — up over IN_MS when the pointer arrives, down over OUT_MS after it
// leaves — and the paint expressions in layerManager.js interpolate on it.
// Sweeping across districts cross-fades one outline into the next.

import { easeOut, prefersReducedMotion } from './motion.js';

const IN_MS = 140;
const OUT_MS = 220;

const fades = new Map(); // `${level}|${id}` → { map, level, id, from, to, start, ms, value }
let rafId = null;

// Fade the hover on `id` in `level`'s source on or off. A fade already under
// way turns around from where it is, over the share of the time left to go.
export function fadeHover(map, level, id, on) {
  if (id == null) return;
  const key = `${level}|${id}`;
  const to = on ? 1 : 0;
  const running = fades.get(key);
  const from = running ? running.value : Number(map.getFeatureState({ source: level, id })?.hover) || 0;
  const ms = prefersReducedMotion() ? 0 : (on ? IN_MS : OUT_MS) * Math.abs(to - from);
  if (ms <= 0) {
    fades.delete(key);
    if (from !== to) map.setFeatureState({ source: level, id }, { hover: to });
    return;
  }
  fades.set(key, { map, level, id, from, to, start: performance.now(), ms, value: from });
  if (rafId == null) rafId = requestAnimationFrame(step);
}

function step(now) {
  rafId = null;
  for (const [key, f] of fades) {
    const t = Math.min(1, Math.max(0, (now - f.start) / f.ms));
    f.value = f.from + (f.to - f.from) * easeOut(t);
    f.map.setFeatureState({ source: f.level, id: f.id }, { hover: f.value });
    if (t >= 1) fades.delete(key);
  }
  if (fades.size) rafId = requestAnimationFrame(step);
}
