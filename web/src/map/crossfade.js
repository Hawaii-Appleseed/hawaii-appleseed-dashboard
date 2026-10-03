// Crossfades for changes MapLibre can't fade
// itself: new colors for every area (a variable or a color scheme), which read
// each area's data, along with the reliability hatching and the Millionaires
// circles that change with them.
//
// The frame on screen is copied onto a canvas laid over the map, the change is
// made underneath, and once the new tiles have drawn the canvas fades out
// (.map-crossfade in app.css). Any camera move or resize meanwhile drops the
// canvas at once, since it would no longer line up with the map.

import { prefersReducedMotion } from './motion.js';

const FADE_MS = 300; // the .map-crossfade transition
const TILES_TIMEOUT_MS = 1500; // fade regardless after this long

let current = null; // the crossfade under way: { canvas, end }

// Run `fn` once `sourceId`'s tiles have loaded with the paint they have now
// (or the source has gone). A paint change that re-tiles the source starts on
// the next render, so look then; give up waiting after TILES_TIMEOUT_MS.
export function whenTilesReady(map, sourceId, fn) {
  let done = false;
  const ready = () => !map.getSource(sourceId) || map.isSourceLoaded(sourceId);
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    map.off('sourcedata', onData);
    fn();
  };
  const onData = (e) => {
    if (e.sourceId === sourceId && ready()) finish();
  };
  const timer = setTimeout(finish, TILES_TIMEOUT_MS);
  map.once('render', () => {
    if (ready()) finish();
    else map.on('sourcedata', onData);
  });
}

// Restyle the map with `change()`, crossfading from how it looks now. `sources`
// lists the sources whose tiles the change rebuilds; the fade waits for them.
export function crossfadeMap(map, change, sources) {
  const gl = map.getCanvas();
  if (prefersReducedMotion() || !gl.width || !gl.height || !map.getContainer().clientWidth) {
    change();
    return;
  }
  current?.end(); // one already under way stops where it is

  // Draw the frame now and copy it straight away: the drawing buffer isn't
  // kept (preserveDrawingBuffer is off), so it's only readable right after.
  map.redraw();
  const canvas = document.createElement('canvas');
  canvas.className = 'map-crossfade';
  canvas.width = gl.width;
  canvas.height = gl.height;
  canvas.style.width = gl.style.width;
  canvas.style.height = gl.style.height;
  canvas.getContext('2d').drawImage(gl, 0, 0);
  gl.after(canvas);
  void canvas.offsetWidth; // lay it out opaque first, so the fade has a start

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    map.off('move', end);
    map.off('resize', end);
    canvas.remove();
    if (current?.canvas === canvas) current = null;
  };
  current = { canvas, end };
  map.on('move', end);
  map.on('resize', end);

  change();

  // Fade once every rebuilt source has its new tiles and a frame has drawn them.
  let waiting = sources.length;
  const sourceReady = () => {
    if (--waiting > 0 || ended) return;
    map.once('render', () => {
      if (ended) return;
      canvas.style.opacity = '0';
      setTimeout(end, FADE_MS + 50);
    });
    map.triggerRepaint();
  };
  if (!waiting) {
    waiting = 1;
    sourceReady();
  } else {
    for (const id of sources) whenTilesReady(map, id, sourceReady);
  }
}
