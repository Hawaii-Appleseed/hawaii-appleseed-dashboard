// Custom MapLibre WebGL layer: Gaussian-blurred directional drop shadow
// under the currently-selected polygon feature.
//
// Pipeline (per frame, only while opacity > 0 OR animating):
//   prerender:
//     1. Bind FBO A. Clear. Use mask program. Draw selected polygon triangles
//        in Mercator coords transformed by MapLibre's u_matrix → silhouette.
//     2. Bind FBO B. Clear. Blur program, horizontal direction. Sample FBO A.
//     3. Bind FBO A. Clear. Blur program, vertical direction. Sample FBO B.
//        FBO A now holds the soft shadow mask.
//   render:
//     - Use composite program. Sample FBO A with screen-space offset.
//       Premultiplied-alpha blend onto MapLibre's main framebuffer.
//
// Geometry: GeoJSON polygon rings → Mercator [0,1] coords → earcut → VBO+IBO.
// Cached per `${level}:${id}` to avoid re-triangulating Hawaii's coastlines.
//
// Lazy add/remove: the layer is added to the map stack only when a feature is
// selected and removed after the fade-out animation completes. When no feature
// is selected, MapLibre's render pipeline has no custom layer at all, so zoom
// animations are as smooth as the pre-WebGL baseline.
//
// VAO isolation: on WebGL2 (MapLibre 4.x default) we bind our own VAO around
// every draw call so our enableVertexAttribArray / vertexAttribPointer mutations
// don't corrupt whichever VAO MapLibre has bound, preventing pipeline stalls
// and occasional misrenders during zoom animations.

import maplibregl from 'maplibre-gl';
import earcut from 'earcut';
import { getFeatureById } from './layerManager.js';

export const SHADOW_LAYER_ID = 'selection-shadow';

// Visual tuning knobs.
// A small, light shadow: it lifts the selected area without a dark smudge
// around it (the selection outline in layerManager.js marks it clearly).
const BLUR_RADIUS_PX = 10;
const OFFSET_PX = [4, 7];
const SHADOW_RGB = [0.0, 0.0, 0.0];
const SHADOW_MAX_ALPHA = 0.35;
// Asymmetric fade: snap-on (0ms) so the shadow lands the moment you
// click — the pre-warmed layer is ready immediately, no reason to
// stall it behind a fade-in. Fade-off (180ms) is graceful so deselects
// don't pop.
const FADE_IN_MS = 0;
const FADE_OUT_MS = 180;
const GEOM_CACHE_MAX = 32;
// Render the blur FBOs at 1/SCALE per axis. The shadow is intentionally blurry,
// so 2× downscale (4× fewer fragments) is visually indistinguishable but
// drops per-frame GPU work dramatically during zoom. Blur kernel and composite
// offset are expressed in canvas pixels so the visual is scale-independent.
const FBO_DOWNSCALE = 2;

// ─── Shader sources ────────────────────────────────────────────────────────

const MASK_VS = `
  attribute vec2 a_pos;
  uniform mat4 u_matrix;
  void main() {
    gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  }
`;
const MASK_FS = `
  precision mediump float;
  void main() {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
  }
`;

const QUAD_VS = `
  attribute vec2 a_quad;
  varying vec2 v_uv;
  void main() {
    v_uv = a_quad * 0.5 + 0.5;
    gl_Position = vec4(a_quad, 0.0, 1.0);
  }
`;

// Separable Gaussian — 9-tap kernel collapsed to 5 linear-sampled taps.
// https://www.rastergrid.com/blog/2010/09/efficient-gaussian-blur-with-linear-sampling/
const BLUR_FS = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_direction;
  void main() {
    vec4 sum = texture2D(u_tex, v_uv) * 0.2270270270;
    sum += texture2D(u_tex, v_uv + u_direction * 1.3846153846) * 0.3162162162;
    sum += texture2D(u_tex, v_uv - u_direction * 1.3846153846) * 0.3162162162;
    sum += texture2D(u_tex, v_uv + u_direction * 3.2307692308) * 0.0702702703;
    sum += texture2D(u_tex, v_uv - u_direction * 3.2307692308) * 0.0702702703;
    gl_FragColor = sum;
  }
`;

const COMPOSITE_FS = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_offset_uv;
  uniform vec3 u_shadow_color;
  uniform float u_opacity;
  void main() {
    vec2 src = v_uv - u_offset_uv;
    if (src.x < 0.0 || src.x > 1.0 || src.y < 0.0 || src.y > 1.0) {
      gl_FragColor = vec4(0.0);
      return;
    }
    float a = texture2D(u_tex, src).a * u_opacity;
    gl_FragColor = vec4(u_shadow_color * a, a);
  }
`;

// ─── GL helpers ────────────────────────────────────────────────────────────

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile failed: ' + log);
  }
  return sh;
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Program link failed: ' + log);
  }
  return p;
}

function makeProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = link(gl, vs, fs);
  gl.detachShader(p, vs); gl.detachShader(p, fs);
  gl.deleteShader(vs);    gl.deleteShader(fs);
  return p;
}

function makeFBO(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fbo, tex, width: w, height: h };
}

function destroyFBO(gl, target) {
  if (!target) return;
  gl.deleteFramebuffer(target.fbo);
  gl.deleteTexture(target.tex);
}

// ─── Geometry ─────────────────────────────────────────────────────────────

function flattenPolygon(rings) {
  const flat = [], holes = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holes.push(flat.length / 2);
    for (const [lng, lat] of rings[r]) {
      const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat });
      flat.push(mc.x, mc.y);
    }
  }
  return { flat, holes };
}

function buildGeometry(gl, feature) {
  const geom = feature.geometry;
  if (!geom) return null;
  const polygons = geom.type === 'MultiPolygon' ? geom.coordinates
    : geom.type === 'Polygon' ? [geom.coordinates] : null;
  if (!polygons || !polygons.length) return null;

  const allPositions = [], allIndices = [];
  let vertexOffset = 0;
  for (const rings of polygons) {
    const { flat, holes } = flattenPolygon(rings);
    if (flat.length < 6) continue;
    const idx = earcut(flat, holes, 2);
    if (!idx.length) continue;
    allPositions.push(...flat);
    for (const i of idx) allIndices.push(i + vertexOffset);
    vertexOffset += flat.length / 2;
  }
  if (!allIndices.length) return null;

  const posArr = new Float32Array(allPositions);
  const idxArr = allIndices.length > 65535
    ? new Uint32Array(allIndices)
    : new Uint16Array(allIndices);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.STATIC_DRAW);

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxArr, gl.STATIC_DRAW);

  return {
    vbo, ibo,
    indexCount: idxArr.length,
    indexType: idxArr instanceof Uint32Array ? 0x1405 : gl.UNSIGNED_SHORT,
  };
}

function destroyGeometry(gl, g) {
  if (!g) return;
  gl.deleteBuffer(g.vbo);
  gl.deleteBuffer(g.ibo);
}

// ─── Custom layer class ────────────────────────────────────────────────────

class ShadowLayer {
  constructor() {
    this.id = SHADOW_LAYER_ID;
    this.type = 'custom';
    this.renderingMode = '2d';

    this.map = null;
    this.gl = null;

    // WebGL2 VAO isolation — prevents corrupting MapLibre's VAO state.
    this.isWebGL2 = false;
    this.vao = null;

    // GL programs + locations. maskProgram === null ↔ not yet initialized.
    this.maskProgram = null;
    this.maskAttribPos = -1;
    this.maskUniMatrix = null;
    this.blurProgram = null;
    this.blurAttribQuad = -1;
    this.blurUniTex = null;
    this.blurUniDir = null;
    this.compProgram = null;
    this.compAttribQuad = -1;
    this.compUniTex = null;
    this.compUniOffset = null;
    this.compUniColor = null;
    this.compUniOpacity = null;

    this.quadVBO = null;
    this.fboA = null;
    this.fboB = null;
    this.fboWidth = 0;
    this.fboHeight = 0;

    // Selection.
    this.currentLevel = null;
    this.currentId = null;
    this.currentGeom = null;
    this.geomCache = new Map();
    this._pendingFeature = null;

    // Animation.
    this.opacity = 0;
    this.targetOpacity = 0;
    this.lastTs = null;
    this._rafId = null;

    // Event listener refs.
    this._onResize = null;
    this._onContextLost = null;
    this._onContextRestored = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
      && gl instanceof WebGL2RenderingContext;

    // Re-add after a keepAlive removal: programs + buffers are still valid on
    // the same GL context — skip compile/link and reuse them.
    if (this.maskProgram) {
      this._attachListeners();
      this._ensureFBOs();
      return;
    }

    // First-time GL init.
    // Own VAO (WebGL2 only) — our vertex attrib mutations stay isolated.
    if (this.isWebGL2) this.vao = gl.createVertexArray();

    gl.getExtension('OES_element_index_uint');

    this.maskProgram    = makeProgram(gl, MASK_VS, MASK_FS);
    this.maskAttribPos  = gl.getAttribLocation(this.maskProgram, 'a_pos');
    this.maskUniMatrix  = gl.getUniformLocation(this.maskProgram, 'u_matrix');

    this.blurProgram    = makeProgram(gl, QUAD_VS, BLUR_FS);
    this.blurAttribQuad = gl.getAttribLocation(this.blurProgram, 'a_quad');
    this.blurUniTex     = gl.getUniformLocation(this.blurProgram, 'u_tex');
    this.blurUniDir     = gl.getUniformLocation(this.blurProgram, 'u_direction');

    this.compProgram    = makeProgram(gl, QUAD_VS, COMPOSITE_FS);
    this.compAttribQuad = gl.getAttribLocation(this.compProgram, 'a_quad');
    this.compUniTex     = gl.getUniformLocation(this.compProgram, 'u_tex');
    this.compUniOffset  = gl.getUniformLocation(this.compProgram, 'u_offset_uv');
    this.compUniColor   = gl.getUniformLocation(this.compProgram, 'u_shadow_color');
    this.compUniOpacity = gl.getUniformLocation(this.compProgram, 'u_opacity');

    // Fullscreen triangle covering [-1,1]².
    this.quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this._ensureFBOs();
    this._attachListeners();
  }

  onRemove(map, gl) {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    this._detachListeners();

    // Full teardown.
    if (this.vao)        { gl.deleteVertexArray(this.vao); this.vao = null; }
    if (this.maskProgram)  gl.deleteProgram(this.maskProgram);
    if (this.blurProgram)  gl.deleteProgram(this.blurProgram);
    if (this.compProgram)  gl.deleteProgram(this.compProgram);
    if (this.quadVBO)      gl.deleteBuffer(this.quadVBO);
    destroyFBO(gl, this.fboA);
    destroyFBO(gl, this.fboB);
    for (const g of this.geomCache.values()) destroyGeometry(gl, g);
    this.geomCache.clear();
    this.maskProgram = null;
    this.map = null;
  }

  // ── Listeners ─────────────────────────────────────────────────────────────

  _attachListeners() {
    this._onResize = () => this._ensureFBOs();
    this.map.on('resize', this._onResize);
    this._onContextLost = (e) => { e.preventDefault(); };
    this._onContextRestored = () => {};
    const canvas = this.map.getCanvas();
    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
  }

  _detachListeners() {
    if (this._onResize && this.map) this.map.off('resize', this._onResize);
    const canvas = this.map?.getCanvas();
    if (canvas) {
      if (this._onContextLost)
        canvas.removeEventListener('webglcontextlost', this._onContextLost);
      if (this._onContextRestored)
        canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    }
  }

  // ── FBOs ──────────────────────────────────────────────────────────────────

  _ensureFBOs() {
    const gl = this.gl;
    if (!gl) return;
    // Half-resolution (or whatever FBO_DOWNSCALE dictates). Bilinear filtering
    // during the composite upscale is free and the result is indistinguishable
    // from a full-res blur because the blur itself softens any aliasing.
    const w = Math.max(1, (gl.drawingBufferWidth  / FBO_DOWNSCALE) | 0);
    const h = Math.max(1, (gl.drawingBufferHeight / FBO_DOWNSCALE) | 0);
    if (w === this.fboWidth && h === this.fboHeight && this.fboA && this.fboB) return;
    destroyFBO(gl, this.fboA);
    destroyFBO(gl, this.fboB);
    this.fboA = makeFBO(gl, w, h);
    this.fboB = makeFBO(gl, w, h);
    this.fboWidth = w;
    this.fboHeight = h;
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  setFeature(level, feature) {
    if (!feature) {
      // No-op if already idle — avoids tearing down the pre-warmed layer
      // every time setLayer fires `setShadowFeature(level, null)` to clear
      // any prior selection during a level switch.
      if (this.opacity === 0 && this.targetOpacity === 0) return;
      this.targetOpacity = 0;
      this._startAnimationPump();
      return;
    }

    const id = String(feature.id ?? feature.properties?.GEOID ?? '');
    if (!id) return;
    const key = `${level}:${id}`;

    let g = this.geomCache.get(key);
    if (!g) {
      if (!this.gl) {
        // Layer not yet added to map — defer to prerender.
        this.currentLevel = level;
        this.currentId = id;
        this._pendingFeature = feature;
        this.targetOpacity = 1;
        return;
      }
      g = buildGeometry(this.gl, feature);
      if (!g) return;
      if (this.geomCache.size >= GEOM_CACHE_MAX) {
        const oldKey = this.geomCache.keys().next().value;
        destroyGeometry(this.gl, this.geomCache.get(oldKey));
        this.geomCache.delete(oldKey);
      }
      this.geomCache.set(key, g);
    } else {
      // LRU touch.
      this.geomCache.delete(key);
      this.geomCache.set(key, g);
    }

    this.currentLevel = level;
    this.currentId = id;
    this.currentGeom = g;
    this.targetOpacity = 1;
    if (FADE_IN_MS <= 0) {
      // Instant: snap to full opacity right now and force the very next
      // frame to paint the shadow. Skips the ~2-rAF gap incurred by the
      // animation pump (rAF → tick → triggerRepaint → render).
      this.opacity = 1;
      this.lastTs = null;
      if (this.map) this.map.triggerRepaint();
    } else {
      this._startAnimationPump();
    }
  }

  // ── Animation pump ────────────────────────────────────────────────────────
  // External rAF loop — avoids coalescing that happens when triggerRepaint()
  // is called from inside MapLibre's render() callback.

  _startAnimationPump() {
    if (this._rafId || !this.map) return;
    const tick = () => {
      this._rafId = null;
      // Settled — just stop the pump. The layer stays in the map stack
      // (pre-warmed at registration time) so shader/FBO state survives
      // across selections without per-click add cost. prerender bails
      // when opacity === targetOpacity === 0, so leaving the layer
      // attached is free.
      if (this.opacity === this.targetOpacity) return;
      this.map.triggerRepaint();
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stepAnimation() {
    if (this.opacity === this.targetOpacity) { this.lastTs = null; return this.opacity; }
    const now = performance.now();
    const dt = this.lastTs ? Math.min(now - this.lastTs, 50) : 16;
    this.lastTs = now;
    const dir = Math.sign(this.targetOpacity - this.opacity);
    const fadeMs = dir > 0 ? FADE_IN_MS : FADE_OUT_MS;
    if (fadeMs <= 0) {
      this.opacity = this.targetOpacity;
    } else {
      this.opacity = Math.max(0, Math.min(1, this.opacity + dir * dt / fadeMs));
    }
    // Note: do NOT triggerRepaint() from here. Repaints fired inside render()
    // are coalesced/dropped by MapLibre; _startAnimationPump's external rAF
    // loop drives the fade reliably.
    if (this.opacity === this.targetOpacity) this.lastTs = null;
    return 1 - Math.pow(1 - this.opacity, 3); // ease-out cubic
  }

  // ── GL render hooks ───────────────────────────────────────────────────────

  prerender(gl, _matrix) {
    if (this._pendingFeature) {
      const pf = this._pendingFeature;
      this._pendingFeature = null;
      this.setFeature(this.currentLevel, pf);
    }
    if (this.targetOpacity === 0 && this.opacity === 0) return;
    if (!this.currentGeom || !this.fboA || !this.fboB) return;

    // Note: previously we bailed when `map.isMoving()` returned true to dodge
    // pan/zoom stutter. That bail also fired during the post-click fitBounds
    // animation, making the shadow invisible for ~600ms — exactly when the
    // user wants to see their selection confirmed. With smoothWheelZoom in
    // place and the layer pre-warmed, the 3-pass pipeline (~5-8ms typical)
    // fits in frame budget. If a specific motion path turns out to stutter,
    // narrow the bail there rather than globally.

    // Bind our own VAO so our vertex attrib mutations stay isolated from
    // MapLibre's VAOs. MapLibre always rebinds before its own draws, so
    // restoring to null is sufficient (avoids the GPU-sync getParameter call).
    if (this.vao) gl.bindVertexArray(this.vao);

    try {
      this._ensureFBOs();
      const w = this.fboWidth, h = this.fboHeight;

      // Pass 1: polygon silhouette → FBO A
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA.fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);

      gl.useProgram(this.maskProgram);
      gl.uniformMatrix4fv(this.maskUniMatrix, false, this._getProjMatrix());
      gl.bindBuffer(gl.ARRAY_BUFFER, this.currentGeom.vbo);
      gl.enableVertexAttribArray(this.maskAttribPos);
      gl.vertexAttribPointer(this.maskAttribPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.currentGeom.ibo);
      gl.drawElements(gl.TRIANGLES, this.currentGeom.indexCount, this.currentGeom.indexType, 0);
      gl.disableVertexAttribArray(this.maskAttribPos);

      // u_direction is expressed in canvas-pixel UV units so the blur reach in
      // screen pixels stays constant regardless of FBO_DOWNSCALE. (One UV unit
      // spans drawingBufferWidth screen pixels for the eventual composite.)
      const blurStepX = (BLUR_RADIUS_PX / 8) / gl.drawingBufferWidth;
      const blurStepY = (BLUR_RADIUS_PX / 8) / gl.drawingBufferHeight;

      // Pass 2: horizontal blur — A → B. No clear: the fullscreen quad
      // overwrites every pixel of FBO B.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.blurProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fboA.tex);
      gl.uniform1i(this.blurUniTex, 0);
      gl.uniform2f(this.blurUniDir, blurStepX, 0);
      this._drawQuad(this.blurAttribQuad);

      // Pass 3: vertical blur — B → A. Same: no clear needed, quad overwrites.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA.fbo);
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, this.fboB.tex);
      gl.uniform1i(this.blurUniTex, 0);
      gl.uniform2f(this.blurUniDir, 0, blurStepY);
      this._drawQuad(this.blurAttribQuad);

      // Restore GL state for MapLibre's subsequent layer pipeline.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(null);
    } finally {
      // Restore to null — MapLibre always rebinds its own VAO before drawing,
      // so null is safe and avoids the GPU-stalling getParameter roundtrip.
      if (this.vao) gl.bindVertexArray(null);
    }
  }

  render(gl, _matrix) {
    const eased = this._stepAnimation();
    if (this.opacity === 0 && this.targetOpacity === 0) return;
    if (!this.currentGeom || !this.fboA) return;

    // No isMoving bail here — see matching comment in prerender(). The shadow
    // now follows the camera throughout pan/zoom/fitBounds animations.

    const finalOpacity = eased * SHADOW_MAX_ALPHA;
    if (finalOpacity <= 0.001) return;

    if (this.vao) gl.bindVertexArray(this.vao);

    try {
      gl.useProgram(this.compProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fboA.tex);
      gl.uniform1i(this.compUniTex, 0);
      // Offset is in canvas-pixel UV units so the shadow displacement in screen
      // pixels stays constant regardless of FBO_DOWNSCALE.
      gl.uniform2f(this.compUniOffset,
        OFFSET_PX[0] / gl.drawingBufferWidth,
        -OFFSET_PX[1] / gl.drawingBufferHeight);
      gl.uniform3f(this.compUniColor, SHADOW_RGB[0], SHADOW_RGB[1], SHADOW_RGB[2]);
      gl.uniform1f(this.compUniOpacity, finalOpacity);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this._drawQuad(this.compAttribQuad);
    } finally {
      if (this.vao) gl.bindVertexArray(null);
    }
  }

  _drawQuad(attribLoc) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(attribLoc);
    gl.vertexAttribPointer(attribLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(attribLoc);
  }

  _getProjMatrix() {
    const t = this.map.transform;
    return t.projMatrix || t.mercatorMatrix || t.matrix;
  }
}

// ─── Module-level singleton + public API ───────────────────────────────────

let _instance = null;
let _map = null;

// The custom WebGL drop-shadow is enabled by default. It can be force-
// disabled with `?noshadow=1` for A/B testing or as an escape hatch.
//
// Earlier in development the layer was thought to cause pan/zoom jank,
// but the actual culprit turned out to be MapLibre's built-in wheel-zoom
// handler (see web/src/map/smoothWheelZoom.js). With the wheel handler
// replaced and the prerender's isMoving() bail in place, the shadow no
// longer introduces measurable stutter.
const SHADOW_DISABLED =
  typeof window !== 'undefined' && /[?&]noshadow=1\b/.test(window.location.search);

// Store the map reference and create the layer instance. Does NOT immediately
// add the layer to the map stack — that happens lazily in setShadowFeature.
export function registerShadowLayer(map) {
  if (!map || SHADOW_DISABLED) return;
  _map = map;
  if (!_instance) _instance = new ShadowLayer();
  return _instance;
}

// Pre-warm the GL resources by adding the (idle, opacity=0) layer to the map
// stack now, so shader compile + FBO creation happens during level setup
// rather than the first click — eliminating the visible appearance delay.
// The prerender hook is a no-op while no feature is selected, so adding
// early costs nothing per frame.
export function prewarmShadowLayer(beforeLayerId) {
  if (SHADOW_DISABLED || !_map || !_instance) return;
  if (_map.getLayer(SHADOW_LAYER_ID)) return; // already added
  if (beforeLayerId && _map.getLayer(beforeLayerId)) {
    _map.addLayer(_instance, beforeLayerId);
  } else {
    _map.addLayer(_instance);
  }
}

export function setShadowFeature(level, feature) {
  if (!_instance || !_map) return;

  if (feature && (feature.id != null || feature.properties)) {
    const id = feature.id ?? feature.properties?.GEOID;
    const canonical = id != null ? getFeatureById(level, id) : null;
    const resolvedFeature = canonical || feature;

    // Add to map stack lazily on first selection.
    if (!_map.getLayer(SHADOW_LAYER_ID)) {
      if (_map.isStyleLoaded() && _map.getLayer(`${level}-fill`)) {
        _map.addLayer(_instance, `${level}-fill`);
      }
    } else if (_map.getLayer(`${level}-fill`)) {
      // Keep shadow strictly below the active fill (e.g. after layer switch).
      _map.moveLayer(SHADOW_LAYER_ID, `${level}-fill`);
    }

    _instance.setFeature(level, resolvedFeature);
  } else {
    // Fade out, then remove from map stack once opacity reaches 0.
    _instance.setFeature(level, null);
  }
}
