// Feature-state fades for ?smooth=1 (see perfFlags.js).
//
// MapLibre can't fade a style that depends on feature state: its paint
// transitions skip any value that reads it, so a state change shows in a
// single frame. The states here are numbers from 0 to 1 instead, stepped
// every frame, and the paint expressions in layerManager.js interpolate on
// them:
//   hover  up over HOVER_IN_MS when the pointer arrives, down over
//          HOVER_OUT_MS after it leaves, so sweeping across districts
//          cross-fades one outline into the next;
//   lift   draws a picked area solid over the dimmed map (popup.js).

import { easeOut, prefersReducedMotion } from './motion.js';

const HOVER_IN_MS = 140;
const HOVER_OUT_MS = 220;

const fades = new Map(); // `${source}|${id}|${key}` → { map, source, id, key, from, to, start, ms, value }
let rafId = null;

// Fade state `key` of feature `id` in `source` to `to`, over `ms` for a full
// change from 0 to 1 (a smaller one takes its share). A fade already under
// way turns around from where it is; `ms` of 0 sets the state at once.
export function fadeFeatureState(map, source, id, key, to, ms) {
  if (id == null) return;
  const name = `${source}|${id}|${key}`;
  const running = fades.get(name);
  const from = running ? running.value : Number(map.getFeatureState({ source, id })?.[key]) || 0;
  const time = prefersReducedMotion() ? 0 : ms * Math.abs(to - from);
  if (time <= 0) {
    fades.delete(name);
    if (from !== to) map.setFeatureState({ source, id }, { [key]: to });
    return;
  }
  fades.set(name, { map, source, id, key, from, to, start: performance.now(), ms: time, value: from });
  if (rafId == null) rafId = requestAnimationFrame(step);
}

// Fade the hover on `id` in `level`'s source on or off.
export function fadeHover(map, level, id, on) {
  fadeFeatureState(map, level, id, 'hover', on ? 1 : 0, on ? HOVER_IN_MS : HOVER_OUT_MS);
}

function step(now) {
  rafId = null;
  for (const [name, f] of fades) {
    const t = Math.min(1, Math.max(0, (now - f.start) / f.ms));
    f.value = f.from + (f.to - f.from) * easeOut(t);
    f.map.setFeatureState({ source: f.source, id: f.id }, { [f.key]: f.value });
    if (t >= 1) fades.delete(name);
  }
  if (fades.size) rafId = requestAnimationFrame(step);
}
