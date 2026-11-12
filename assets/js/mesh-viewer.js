// Interactive mesh viewers (three.js). Meshes are stored as gzip'd binary
// blobs written by the converter: a quantized geometry file plus per-vertex
// layers (rgb, surface class, Mesh->GT error).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Same hues as the CSS tokens --flat / --curved / --edge / --unknown.
// Codes follow TsdfVoxel::SurfaceType (0 unknown, 1 flat, 2 curved, 3 edge).
export const CLASS_HEX = ["#4a4d55", "#3f9b3a", "#3360d4", "#d4483f"];
const CLAY = 0xd9d5cc;

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// Polynomial fit of Google's Turbo colormap (sRGB, x in [0,1]).
export function turbo(x) {
  x = Math.min(1, Math.max(0, x));
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b))];
}
const TURBO_LIN = Array.from({ length: 256 }, (_, i) => turbo(i / 255).map(toLin));

// ---------------------------------------------------------------- loading
const cache = new Map();

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +res.headers.get("content-length") || 0;
  let buf;
  if (res.body && total && onProgress) {
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onProgress(got / total);
    }
    buf = await new Blob(parts).arrayBuffer();
  } else {
    buf = await res.arrayBuffer();
  }
  const head = new Uint8Array(buf, 0, 2);
  // Some servers already decode .gz transparently; only inflate real gzip.
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    buf = await new Response(stream).arrayBuffer();
  }
  return buf;
}

function once(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

export function loadGeometry(url, onProgress) {
  return once(url, async () => {
    const buf = await fetchBytes(url, onProgress);
    const dv = new DataView(buf);
    const nV = dv.getUint32(0, true), nF = dv.getUint32(4, true);
    const lo = [0, 1, 2].map((i) => dv.getFloat32(8 + 4 * i, true));
    const st = [0, 1, 2].map((i) => dv.getFloat32(20 + 4 * i, true));
    const q = new Uint16Array(buf, 32, nV * 3);
    const pos = new Float32Array(nV * 3);
    for (let i = 0; i < nV * 3; i += 3) {
      pos[i] = lo[0] + q[i] * st[0];
      pos[i + 1] = lo[1] + q[i + 1] * st[1];
      pos[i + 2] = lo[2] + q[i + 2] * st[2];
    }
    let off = 32 + nV * 6;
    off += (4 - (off % 4)) % 4;
    const idx = new Uint32Array(buf.slice(off, off + nF * 12));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });
}

export function loadLayer(url, kind) {
  return once(url, async () => {
    const buf = await fetchBytes(url);
    return kind === "err" ? new Uint16Array(buf) : new Uint8Array(buf);
  });
}

// ---------------------------------------------------------------- colours
export function rgbColors(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = S2L[bytes[i]];
  return out;
}

export function classColors(codes) {
  const lut = CLASS_HEX.map((h) => new THREE.Color(h)); // linear after parse
  const out = new Float32Array(codes.length * 3);
  for (let i = 0; i < codes.length; i++) {
    const c = lut[codes[i]] || lut[0];
    out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b;
  }
  return out;
}

// err is in 0.1 mm units; capCm sets the top of the ramp.
// Vertices farther than truncCm from the GT are excluded from the paper's mean
// (paper_metrics.cc, ignore_truncated_points) and drawn grey, as with
// render_mesh_error_heatmap.py --gray-truncated.
const TRUNC_LIN = [0.62, 0.62, 0.62].map(toLin);
export function errorColors(err, capCm, out, truncCm = Infinity) {
  out = out || new Float32Array(err.length * 3);
  const k = 255 / (capCm * 100), t = truncCm * 100;
  for (let i = 0; i < err.length; i++) {
    const c = err[i] > t ? TRUNC_LIN : TURBO_LIN[Math.min(255, (err[i] * k) | 0)];
    out[3 * i] = c[0]; out[3 * i + 1] = c[1]; out[3 * i + 2] = c[2];
  }
  return out;
}

// ---------------------------------------------------------------- viewer
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class MeshViewer {
  constructor(el, { label = "", ours = false, autoRotate = false } = {}) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 500);
    this.camera.up.set(0, 0, 1);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(0.6, 0.9, 1.4);
    this.camera.add(key);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotate = autoRotate;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.addEventListener("start", () => {
      this.controls.autoRotate = false;
      this.onStart && this.onStart(this);
    });
    this.controls.addEventListener("change", () => {
      this.dirty = true;
      this.onChange && this.onChange(this);
    });

    this.clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);
    this.matColor = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, clippingPlanes: [this.clip] });
    this.matClay = new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, clippingPlanes: [this.clip] });
    this.mesh = null;

    this.overlay(label, ours);
    this.applyTheme();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();

    this.visible = false;
    new IntersectionObserver((es) => {
      this.visible = es[0].isIntersecting;
      if (this.visible) this.loop();
    }, { rootMargin: "100px" }).observe(el);
  }

  overlay(label, ours) {
    const add = (cls, html) => {
      const d = document.createElement("div");
      d.className = cls;
      d.innerHTML = html;
      this.el.appendChild(d);
      return d;
    };
    this.labelEl = add("v-label" + (ours ? " ours" : ""), label);
    if (!label) this.labelEl.hidden = true;
    this.noteEl = add("v-note", "");
    add("v-hint", "drag · scroll · right-drag");
    this.loadEl = add("v-load", '<div><div>loading mesh…</div><div class="bar"><i></i></div></div>');
    const reset = document.createElement("button");
    reset.className = "v-reset";
    reset.title = "Reset view";
    reset.setAttribute("aria-label", "Reset view");
    reset.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
    reset.addEventListener("click", () => this.onReset && this.onReset(this));
    this.el.appendChild(reset);
  }

  setLabel(html) { this.labelEl.innerHTML = html; this.labelEl.hidden = !html; }
  setNote(text) { this.noteEl.textContent = text || ""; }

  loading(on, frac) {
    this.loadEl.classList.toggle("done", !on);
    if (frac != null) this.loadEl.querySelector("i").style.width = `${Math.round(frac * 100)}%`;
  }

  applyTheme() {
    this.renderer.setClearColor(new THREE.Color(cssVar("--surface") || "#ffffff"), 1);
    this.dirty = true;
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // colors: Float32Array (linear RGB) or null for clay shading.
  show(geometry, colors) {
    if (colors) {
      const attr = geometry.getAttribute("color");
      if (attr && attr.array === colors) attr.needsUpdate = true;
      else geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    }
    const mat = colors ? this.matColor : this.matClay;
    if (!this.mesh) {
      this.mesh = new THREE.Mesh(geometry, mat);
      this.scene.add(this.mesh);
    } else {
      this.mesh.geometry = geometry;
      this.mesh.material = mat;
    }
    this.dirty = true;
  }

  clear() {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh = null; this.dirty = true; }
  }

  setClipZ(z) { this.clip.constant = z; this.dirty = true; }

  // dir: viewing direction from target to eye (world, z-up); dist in units of the bounding radius
  frame(box, { dir = [0.5, -0.8, 1.0], dist = 0.8, target = null } = {}) {
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const t = target ? new THREE.Vector3(...target) : c;
    // portrait viewports have a narrower horizontal field, so back off
    const narrow = Math.min(1.8, Math.max(1, 1 / this.camera.aspect));
    const d = new THREE.Vector3(...dir).normalize().multiplyScalar((r * dist * narrow) / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.camera.position.copy(t).add(d);
    this.controls.target.copy(t);
    this.camera.near = Math.max(0.02, r / 400);
    this.camera.far = r * 30;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
  }

  copyView(from) {
    this.camera.position.copy(from.camera.position);
    this.camera.quaternion.copy(from.camera.quaternion);
    this.camera.near = from.camera.near;
    this.camera.far = from.camera.far;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(from.controls.target);
    this.dirty = true;
  }

  loop() {
    if (this._raf) return;
    const tick = () => {
      this._raf = null;
      if (!this.visible) return;
      const moved = this.controls.update();
      if (moved || this.dirty) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
}

// Keep the cameras of several viewers in lockstep; whichever one the user
// last grabbed drives the others (including its damping tail).
export function syncViewers(viewers) {
  let driver = null;
  for (const v of viewers) {
    v.onStart = (src) => { driver = src; for (const o of viewers) o.controls.autoRotate = false; };
    v.onChange = (src) => {
      if (src !== driver) return;
      for (const o of viewers) if (o !== src) o.copyView(src);
    };
  }
}
