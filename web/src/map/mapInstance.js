import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { FLAGS } from './perfFlags.js';
import { installSmoothWheelZoom } from './smoothWheelZoom.js';

let mapInstance = null;

// Starting view. theme.json's center/zoom suit a desktop window; on smaller
// maps (phones, embeds) that zoom crops islands, so homeCamera() zooms out to
// fit `homeBounds` instead.
const MIN_ZOOM = 5;
let homeCenter = null;
let homeZoom = null;
let homeBounds = null; // [[west, south], [east, north]]
// Keep re-fitting the starting view as the container resizes (an iframe's
// layout settling, a phone rotating) until the user moves the map themselves.
let followHome = true;

// Room to leave around the islands. The top clears the 42px frosted strip over
// the map's top edge (.map-wrap::before). The legend card sits in the
// lower-left corner, so the islands also clear it, by padding past either its
// right edge or its top edge, whichever leaves them bigger.
function fitPaddings(map) {
  const pad = 24;
  const base = { top: 48, right: pad, bottom: pad, left: pad };
  const legend = document.getElementById('main-map-legend')?.getBoundingClientRect();
  if (!legend || !legend.width) return [base];
  const box = map.getContainer().getBoundingClientRect();
  return [
    { ...base, left: Math.max(pad, legend.right - box.left + 12) },
    { ...base, bottom: Math.max(pad, box.bottom - legend.top + 12) },
  ];
}

// The islands' size in pixels at `zoom`.
function islandsSize(zoom) {
  const world = 512 * 2 ** zoom;
  const sw = maplibregl.MercatorCoordinate.fromLngLat(homeBounds[0]);
  const ne = maplibregl.MercatorCoordinate.fromLngLat(homeBounds[1]);
  return { width: (ne.x - sw.x) * world, height: (sw.y - ne.y) * world };
}

function homeCamera() {
  const configured = { center: homeCenter, zoom: homeZoom };
  const map = mapInstance;
  if (!map || !homeBounds) return configured;
  const best = fitPaddings(map)
    .map((padding) => map.cameraForBounds(homeBounds, { padding }))
    .filter(Boolean)
    .reduce((a, b) => (!a || b.zoom > a.zoom ? b : a), null);
  // Only ever zoom out: where the configured view already fits, keep it.
  if (best && best.zoom >= homeZoom) return configured;
  if (best && best.zoom >= MIN_ZOOM) return { center: best.center, zoom: best.zoom };

  // Phones: the legend runs most of the map's height, so not even the minimum
  // zoom clears it. Put the islands just under the top strip at that zoom,
  // centered across; the legend then covers only open ocean south of Kauaʻi
  // and Oʻahu. (Letting MapLibre clamp a smaller fit's zoom instead would keep
  // that fit's center and push islands off an edge.)
  const { clientWidth, clientHeight } = map.getContainer();
  const { width, height } = islandsSize(MIN_ZOOM);
  if (48 + height + 12 <= clientHeight && width + 24 <= clientWidth) {
    const side = (clientWidth - width) / 2;
    const cam = map.cameraForBounds(homeBounds, {
      padding: { top: 48, bottom: clientHeight - 48 - height, left: side, right: side },
    });
    if (cam) return { center: cam.center, zoom: MIN_ZOOM };
  }
  // A phone on its side leaves too short a map even for that: zoom out past
  // the minimum so no island is cut off (goHome lowers minZoom to match).
  const fit = map.cameraForBounds(homeBounds, { padding: { top: 48, right: 12, bottom: 12, left: 12 } });
  return fit ? { center: fit.center, zoom: fit.zoom } : configured;
}

// Move to the starting view. minZoom stays at MIN_ZOOM except on a map too
// short for the islands at that zoom, where it drops only as far as needed.
function goHome(animate) {
  const cam = homeCamera();
  mapInstance.setMinZoom(Math.min(MIN_ZOOM, cam.zoom));
  if (animate) mapInstance.easeTo({ ...cam, duration: 400 });
  else mapInstance.jumpTo(cam);
}

// Snap to the starting view, unless the user has already moved the map.
export function fitHome() {
  if (!mapInstance || !followHome) return;
  mapInstance.resize();
  goHome(false);
}

class ResetControl {
  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'maplibre-reset-zoom';
    btn.title = 'Reset view';
    btn.setAttribute('aria-label', 'Reset view');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      followHome = true;
      goHome(true);
    });
    container.appendChild(btn);
    this._container = container;
    return container;
  }
  onRemove() {
    this._container?.parentNode?.removeChild(this._container);
    this._map = undefined;
  }
}

export function createMap(containerId, theme) {
  if (mapInstance) return mapInstance;

  const mapCfg = (theme && theme.map) || {};
  // theme.json stores center as [lat, lng] (Leaflet order). MapLibre wants [lng, lat].
  const themeCenter = mapCfg.center || [20.65, -157.65];
  const center = [themeCenter[1], themeCenter[0]];
  const zoom = mapCfg.zoom || 6.8;
  homeCenter = center;
  homeZoom = zoom;
  // bounds uses the same [lat, lng] order as center: [southwest, northeast].
  homeBounds = Array.isArray(mapCfg.bounds) ? mapCfg.bounds.map(([lat, lng]) => [lng, lat]) : null;
  const background = (theme && theme.background) || '#fcfcf9';

  const container = document.getElementById(containerId);
  if (container) container.style.backgroundColor = 'white';

  const mapOpts = {
    container: containerId,
    style: {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': background } },
      ],
    },
    center,
    zoom,
    minZoom: MIN_ZOOM,
    maxZoom: 16,
    attributionControl: false,
    fadeDuration: mapCfg.fade_animation === false ? 0 : 300,
    dragRotate: false,
    pitchWithRotate: false,
    touchZoomRotate: true,
  };
  if (FLAGS.lowDpr != null && !Number.isNaN(FLAGS.lowDpr)) {
    mapOpts.pixelRatio = FLAGS.lowDpr;
  }
  mapInstance = new maplibregl.Map(mapOpts);
  mapInstance.touchZoomRotate?.disableRotation();

  // Self-heal against container-size races (e.g. embedded in an iframe whose
  // layout isn't settled yet when this constructor measures it — MapLibre
  // falls back to a hardcoded 400x300 canvas and never grows out of it
  // without an explicit resize()). Watching the container directly catches
  // that first real layout pass plus any later reflow (iframe resize, tab
  // becoming visible, etc.) without relying on call sites to remember to
  // call map.resize() themselves.
  if (container && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      mapInstance.resize();
      if (followHome) goHome(false);
    });
    ro.observe(container);
  }
  // Any direct interaction hands the camera to the user (until Reset view).
  // Listening for input rather than 'movestart' matters: resize() and the
  // custom wheel zoom fire movestart too, without an originalEvent.
  if (container) {
    for (const type of ['pointerdown', 'wheel', 'keydown']) {
      container.addEventListener(type, () => { followHome = false; }, { capture: true, passive: true });
    }
  }

  if (!FLAGS.noNav) {
    mapInstance.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-left');
    mapInstance.addControl(new ResetControl(), 'top-left');
  }

  // Replace MapLibre's built-in wheel-zoom handler with a custom rAF-driven
  // one that produces 0% zoom-progression stalls (the built-in handler
  // stalls every ~3rd frame during continuous wheel input). Opt out with
  // ?stock=1 for A/B testing.
  if (!FLAGS.stockWheelZoom) {
    installSmoothWheelZoom(mapInstance);
  }

  // Dev only: expose the map on window for in-browser debugging.
  if (typeof window !== 'undefined' && import.meta.env?.DEV) window.__map = mapInstance;


  return mapInstance;
}

export function getMap() {
  return mapInstance;
}
