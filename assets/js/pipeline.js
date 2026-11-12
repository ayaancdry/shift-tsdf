// Port of SHIFT's RGB-D classifier and coplanar bundling (NormalClassifier::
// classify + the bundling step of NpTsdfServer) running on a ray-cast depth
// frame of a room. Parameters are the values used for the paper's RGB-D runs.

const W = 320, H = 240, FX = 262, FY = 262, CX = W / 2 - 0.5, CY = H / 2 - 0.5;

const CFG = {
  depth_noise_factor: 0.002,        // sigma(z) = max(min_depth_sigma_m, k z^2)
  min_depth_sigma_m: 0.004,
  plane_fit_sigma_factor: 1.6,      // cell:   mse <= (1.6 sigma)^2
  region_fit_sigma_factor: 1.3,     // region: mse <= (1.3 sigma)^2
  merge_dist_sigma_factor: 3.0,     // coplanar: |n.(mu_j - mu_R)| <= 3 sigma
  flat_angle_thresh_rad: 0.30,
  crease_angle_thresh_rad: 0.45,
  min_flat_patch_count: 6,
  min_valid_cell_fraction: 0.5,
  max_edge_cell_fraction: 0.0,
  edge_depth_jump_m: 0.04,          // |dz| > max(0.04, 0.006 z^2)
  edge_relative_factor: 0.006,
  edge_min_neighbor_votes: 2,
  edge_dilate_px: 1,
  planarity_residual_sigma_m: 0.01,
};

export const CLASS = { UNKNOWN: 0, FLAT: 1, CURVED: 2, EDGE: 3 };
export const CLASS_RGB = [[74, 77, 85], [63, 155, 58], [51, 96, 212], [212, 72, 63]];
const OCC_RGB = [245, 190, 60];   // occlusion mask (not a surface class)

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clampUnit = (x) => Math.min(1, Math.max(-1, x));
const depthSigma = (z) => Math.max(CFG.min_depth_sigma_m, CFG.depth_noise_factor * z * z);

// ---------------------------------------------------------------- scene
// World frame: x right, y down, z forward; the camera sits at the origin and
// is pitched down by PITCH. Object ids let the demo check its own labels.
export const SCENE = {
  pitch: 0.22,
  room: { floor: 1.05, ceil: -1.45, left: -1.9, right: 1.9, back: 4.3 },
  box: { min: [0.6, 0.5, 1.5], max: [1.7, 1.05, 2.4] },
  sphere: { c: [-0.7, 0.83, 1.75], r: 0.22 },
};
export const OBJ = { FLOOR: 0, CEIL: 1, LEFT: 2, RIGHT: 3, BACK: 4, SPHERE: 6, BOX: 10 };  // box faces 10-15

function castScene(d) {
  const { room, box, sphere } = SCENE;
  let best = Infinity, id = -1;
  const tryT = (t, k) => { if (t > 1e-6 && t < best) { best = t; id = k; } };
  if (d[1] > 0) tryT(room.floor / d[1], OBJ.FLOOR);
  if (d[1] < 0) tryT(room.ceil / d[1], OBJ.CEIL);
  if (d[0] < 0) tryT(room.left / d[0], OBJ.LEFT);
  if (d[0] > 0) tryT(room.right / d[0], OBJ.RIGHT);
  if (d[2] > 0) tryT(room.back / d[2], OBJ.BACK);
  let t0 = -Infinity, t1 = Infinity, face = 0;
  for (let i = 0; i < 3; i++) {
    const a = box.min[i] / d[i], b = box.max[i] / d[i];
    if (Math.min(a, b) > t0) { t0 = Math.min(a, b); face = 2 * i + (a < b ? 0 : 1); }
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (t1 >= t0) tryT(t0, OBJ.BOX + face);
  const c = sphere.c, A = dot(d, d), B = dot(d, c), disc = B * B - A * (dot(c, c) - sphere.r * sphere.r);
  if (disc > 0) tryT((B - Math.sqrt(disc)) / A, OBJ.SPHERE);
  return [best, id];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// noiseScale multiplies the sensor noise model; 1 = the noise the classifier assumes.
function render(noiseScale) {
  const rand = rng(7);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const cp = Math.cos(SCENE.pitch), sp = Math.sin(SCENE.pitch);
  const P = new Float64Array(W * H * 3), Z = new Float64Array(W * H), obj = new Int8Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const dx = (u - CX) / FX, dy = (v - CY) / FY;
    // camera ray (dx, dy, 1) rotated down about x into the world
    const [t, id] = castScene([dx, dy * cp + sp, -dy * sp + cp]);
    let z = t;                                   // camera-frame depth (ray has z = 1)
    if (noiseScale > 0) z += noiseScale * CFG.depth_noise_factor * z * z * gauss();
    const i = v * W + u;
    Z[i] = z; obj[i] = id;
    P[3 * i] = dx * z; P[3 * i + 1] = dy * z; P[3 * i + 2] = z;
  }
  return { P, Z, obj };
}

// ---------------------------------------------------------------- plane fit
function smallestEig(a, b, c, d, e, f) {
  const p1 = b * b + c * c + e * e, q = (a + d + f) / 3;
  const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  if (p < 1e-18) return { l: q, n: [0, 0, 1] };
  const B0 = (a - q) / p, B1 = b / p, B2 = c / p, B3 = (d - q) / p, B4 = e / p, B5 = (f - q) / p;
  const det = B0 * (B3 * B5 - B4 * B4) - B1 * (B1 * B5 - B4 * B2) + B2 * (B1 * B4 - B3 * B2);
  const phi = Math.acos(Math.min(1, Math.max(-1, det / 2))) / 3;
  const l = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const r0 = [a - l, b, c], r1 = [b, d - l, e], r2 = [c, e, f - l];
  const cr = (x, y) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  let best = null, bn = -1;
  for (const v of [cr(r0, r1), cr(r0, r2), cr(r1, r2)]) {
    const n = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (n > bn) { bn = n; best = v; }
  }
  const s = Math.sqrt(bn) || 1;
  return { l: Math.max(0, l), n: [best[0] / s, best[1] / s, best[2] / s] };
}

class Moments {
  constructor() { this.n = 0; this.S = [0, 0, 0]; this.Q = [0, 0, 0, 0, 0, 0]; }
  add(x, y, z) {
    this.n++; this.S[0] += x; this.S[1] += y; this.S[2] += z;
    const Q = this.Q; Q[0] += x * x; Q[1] += x * y; Q[2] += x * z; Q[3] += y * y; Q[4] += y * z; Q[5] += z * z;
  }
  merged(o) {
    const m = new Moments();
    m.n = this.n + o.n;
    for (let i = 0; i < 3; i++) m.S[i] = this.S[i] + o.S[i];
    for (let i = 0; i < 6; i++) m.Q[i] = this.Q[i] + o.Q[i];
    return m;
  }
  // centroid, unit normal oriented away from the sensor (n . mu > 0), mse = lambda_0
  fit() {
    const n = this.n, mu = this.S.map((s) => s / n), Q = this.Q;
    const e = smallestEig(Q[0] / n - mu[0] * mu[0], Q[1] / n - mu[0] * mu[1], Q[2] / n - mu[0] * mu[2],
      Q[3] / n - mu[1] * mu[1], Q[4] / n - mu[1] * mu[2], Q[5] / n - mu[2] * mu[2]);
    let nv = e.n;
    if (nv[0] * mu[0] + nv[1] * mu[1] + nv[2] * mu[2] < 0) nv = nv.map((x) => -x);
    return { mu, n: nv, mse: e.l };
  }
}

// ---------------------------------------------------------------- classifier
export function classify(ps, noiseScale) {
  const { P, Z, obj } = render(noiseScale);
  const N = W * H;

  // per-pixel normals (finite-difference cross product), display only
  const nrm = new Float32Array(N * 3);
  for (let v = 1; v < H - 1; v++) for (let u = 1; u < W - 1; u++) {
    const i = v * W + u, a = 3 * (i + 1), b = 3 * (i - 1), c = 3 * (i + W), d = 3 * (i - W);
    const du = [P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]];
    const dv = [P[c] - P[d], P[c + 1] - P[d + 1], P[c + 2] - P[d + 2]];
    let n = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
    const s = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((x) => x / s);
    if (n[0] * P[3 * i] + n[1] * P[3 * i + 1] + n[2] * P[3 * i + 2] < 0) n = n.map((x) => -x);
    nrm[3 * i] = n[0]; nrm[3 * i + 1] = n[1]; nrm[3 * i + 2] = n[2];
  }

  // ---- 1. occlusion mask: >= 2 discontinuous 4-neighbours, despeckle, dilate
  let occ = new Uint8Array(N);
  for (let v = 1; v < H - 1; v++) for (let u = 1; u < W - 1; u++) {
    const i = v * W + u, z = Z[i];
    const thr = Math.max(CFG.edge_depth_jump_m, CFG.edge_relative_factor * z * z);
    let votes = 0;
    for (const j of [i - 1, i + 1, i - W, i + W]) if (Math.abs(z - Z[j]) > thr) votes++;
    if (votes >= CFG.edge_min_neighbor_votes) occ[i] = 1;
  }
  const clean = occ.slice();
  for (let v = 1; v < H - 1; v++) for (let u = 1; u < W - 1; u++) {
    const i = v * W + u;
    if (!occ[i]) continue;
    let nb = false;
    for (let dy = -1; dy <= 1 && !nb; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && occ[i + dy * W + dx]) { nb = true; break; }
    }
    if (!nb) clean[i] = 0;
  }
  occ = clean;
  for (let it = 0; it < CFG.edge_dilate_px; it++) {
    const dil = occ.slice();
    for (let v = 1; v < H - 1; v++) for (let u = 1; u < W - 1; u++) {
      const i = v * W + u;
      if (occ[i]) { dil[i - 1] = dil[i + 1] = dil[i - W] = dil[i + W] = 1; }
    }
    occ = dil;
  }

  // ---- 2. per-cell moments of valid, non-occlusion pixels
  const CW = Math.ceil(W / ps), CH = Math.ceil(H / ps), NC = CW * CH;
  const cells = Array.from({ length: NC }, () => ({
    m: new Moments(), valid: 0, edge: 0, fit: null, cand: false, assigned: false, seg: -1, reject: "",
  }));
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const i = v * W + u, c = cells[((v / ps) | 0) * CW + ((u / ps) | 0)];
    c.valid++;
    if (occ[i]) { c.edge++; continue; }
    c.m.add(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
  }

  // ---- 3. flat candidates: enough points, no occlusion pixel, mse <= (1.6 sigma)^2
  const minPts = Math.max(6, Math.floor(CFG.min_valid_cell_fraction * ps * ps));
  for (const c of cells) {
    if (c.m.n < minPts) { c.reject = "points"; continue; }
    if ((c.valid ? c.edge / c.valid : 1) > CFG.max_edge_cell_fraction) { c.reject = "occlusion"; continue; }
    c.fit = c.m.fit();
    const sb = CFG.plane_fit_sigma_factor * depthSigma(c.fit.mu[2]);
    if (c.fit.mse > sb * sb) { c.reject = "mse"; continue; }
    c.cand = true;
  }

  // ---- 4. region growing with exact refit
  const cosMerge = Math.cos(CFG.flat_angle_thresh_rad);
  const segments = [], order = [];
  let regionId = 0;
  for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
    const seed = cells[cy * CW + cx];
    if (!seed.cand || seed.assigned) continue;
    seed.assigned = true;
    let M = seed.m, F = seed.fit;
    const members = [], q = [[cx, cy]];
    const rid = regionId++;
    while (q.length) {
      const [x, y] = q.shift();
      members.push(y * CW + x);
      order.push([y * CW + x, rid]);
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || nx >= CW || ny < 0 || ny >= CH) continue;
        const nb = cells[ny * CW + nx];
        if (!nb.cand || nb.assigned) continue;
        if (clampUnit(dot(F.n, nb.fit.n)) < cosMerge) continue;                        // normal
        const off = Math.abs(dot(F.n, [nb.fit.mu[0] - F.mu[0], nb.fit.mu[1] - F.mu[1], nb.fit.mu[2] - F.mu[2]]));
        if (off > CFG.merge_dist_sigma_factor * depthSigma(nb.fit.mu[2])) continue;   // coplanar
        const M2 = M.merged(nb.m), F2 = M2.fit();
        const rb = CFG.region_fit_sigma_factor * depthSigma(F2.mu[2]);
        if (F2.mse > rb * rb) continue;                                                // refit
        nb.assigned = true;
        M = M2; F = F2;
        q.push([nx, ny]);
      }
    }
    if (members.length < CFG.min_flat_patch_count) continue;
    const sid = segments.length;
    for (const c of members) cells[c].seg = sid;
    segments.push({ n: F.n, mu: F.mu, mse: F.mse, rid });
  }
  const keptRegion = new Set(segments.map((s) => s.rid));

  // ---- 5. crease edges between plane segments
  const crease = new Uint8Array(N);
  const cosCrease = Math.cos(CFG.crease_angle_thresh_rad);
  const cosHalf = Math.cos(0.5 * CFG.crease_angle_thresh_rad);
  const segCrease = (a, b) => a >= 0 && b >= 0 && a !== b && clampUnit(dot(segments[a].n, segments[b].n)) < cosCrease;
  const strip = (cx, cy, vertical) => {
    const x0 = cx * ps, y0 = cy * ps;
    if (vertical) {
      const xa = Math.min(W - 1, x0 + ps - 1), xb = Math.min(W - 1, x0 + ps);
      for (let y = y0; y < Math.min(H, y0 + ps); y++) { crease[y * W + xa] = 1; crease[y * W + xb] = 1; }
    } else {
      const ya = Math.min(H - 1, y0 + ps - 1), yb = Math.min(H - 1, y0 + ps);
      for (let x = x0; x < Math.min(W, x0 + ps); x++) { crease[ya * W + x] = 1; crease[yb * W + x] = 1; }
    }
  };
  const wholeCell = (cx, cy) => {
    for (let y = cy * ps; y < Math.min(H, cy * ps + ps); y++)
      for (let x = cx * ps; x < Math.min(W, cx * ps + ps); x++) crease[y * W + x] = 1;
  };
  const offPlane = (c) => c.fit && c.seg >= 0 && clampUnit(dot(c.fit.n, segments[c.seg].n)) < cosHalf;
  const markIfContaminated = (cx, cy) => { if (offPlane(cells[cy * CW + cx])) wholeCell(cx, cy); };
  for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
    const sid = cells[cy * CW + cx].seg;
    if (sid < 0) continue;
    if (cx + 1 < CW && segCrease(sid, cells[cy * CW + cx + 1].seg)) {
      strip(cx, cy, true); markIfContaminated(cx, cy); markIfContaminated(cx + 1, cy);
    }
    if (cy + 1 < CH && segCrease(sid, cells[(cy + 1) * CW + cx].seg)) {
      strip(cx, cy, false); markIfContaminated(cx, cy); markIfContaminated(cx, cy + 1);
    }
    if (cx + 2 < CW && segCrease(sid, cells[cy * CW + cx + 2].seg)) {
      const mid = cells[cy * CW + cx + 1];
      if (mid.seg < 0 || offPlane(mid)) wholeCell(cx + 1, cy);
    }
    if (cy + 2 < CH && segCrease(sid, cells[(cy + 2) * CW + cx].seg)) {
      const mid = cells[(cy + 1) * CW + cx];
      if (mid.seg < 0 || offPlane(mid)) wholeCell(cx, cy + 1);
    }
  }

  // ---- 6. per-pixel labels: crease -> EDGE, occlusion -> CURVED, segment -> FLAT, else CURVED
  const label = new Uint8Array(N), segOf = new Int32Array(N).fill(-1);
  const count = [0, 0, 0, 0];
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const i = v * W + u, seg = cells[((v / ps) | 0) * CW + ((u / ps) | 0)].seg;
    if (crease[i]) label[i] = CLASS.EDGE;
    else if (occ[i]) label[i] = CLASS.CURVED;
    else if (seg >= 0) { label[i] = CLASS.FLAT; segOf[i] = seg; }
    else label[i] = CLASS.CURVED;
    count[label[i]]++;
  }

  // ---- bundling: one super-ray per (tile, segment) group of FLAT pixels
  // (tile size = patch size). Residual weight w_i = (s_p / max(s_p, r_i))^2.
  const sp = CFG.planarity_residual_sigma_m;
  const groups = new Map();
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const i = v * W + u;
    if (label[i] !== CLASS.FLAT) continue;
    const seg = segments[segOf[i]];
    const t = ((v / ps) | 0) * CW + ((u / ps) | 0), key = t * 4096 + segOf[i];
    const r = Math.abs(dot(seg.n, [P[3 * i] - seg.mu[0], P[3 * i + 1] - seg.mu[1], P[3 * i + 2] - seg.mu[2]]));
    const w = (sp / Math.max(sp, r)) ** 2;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { w: 0, x: 0, y: 0, z: 0, n: 0, seg }));
    g.w += w; g.n++; g.x += w * P[3 * i]; g.y += w * P[3 * i + 1]; g.z += w * P[3 * i + 2];
  }
  const rays = [];
  for (const g of groups.values()) {
    const p = [g.x / g.w, g.y / g.w, g.z / g.w], n = g.seg.n;
    const k = dot(n, [p[0] - g.seg.mu[0], p[1] - g.seg.mu[1], p[2] - g.seg.mu[2]]);
    const s = [p[0] - k * n[0], p[1] - k * n[1], p[2] - k * n[2]];          // snapped onto the plane
    rays.push({ u: FX * s[0] / s[2] + CX, v: FY * s[1] / s[2] + CY, w: g.w });
  }

  return { W, H, P, Z, obj, nrm, occ, cells, CW, CH, ps, segments, order, keptRegion, crease, label, segOf,
    count, rays, nrays: rays.length + count[CLASS.EDGE] + count[CLASS.CURVED] };
}

// ---------------------------------------------------------------- drawing
function segRGB(i) {
  // distinct pastel hues for segments (only used before labelling)
  const h = ((i * 137.508 + 200) % 360) / 360, s = 0.45, l = 0.62;
  const f = (n) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

export const STEP_LEGENDS = [
  [["depth: near", "#eef0f4"], ["far", "#3a3e48"]],
  [["normal (RGB = xyz)", "linear-gradient(90deg,#d77,#7d7,#77d)"], ["occlusion mask", "#f5be3c"]],
  [["flat-candidate cell", "#7fbf7a"], ["rejected cell", "#5a5d66"], ["occlusion mask", "#f5be3c"]],
  [["plane segment (one colour each)", "linear-gradient(90deg,#9ad,#d9a,#ad9)"], ["region < 6 cells, dropped", "#5a5d66"]],
  [["plane segment", "#9aa4b8"], ["crease → Edge", "#d4483f"]],
  [["Flat", "#3f9b3a"], ["Edge", "#d4483f"], ["Curved", "#3360d4"], ["super-ray (size ∝ weight)", "#075e5a"]],
];

export class PipelineLab {
  constructor(canvas, readout, legend) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.readout = readout;
    this.legend = legend;
    this.step = 0;
    this.P = 12;
    this.noise = 0.5;
    this.anim = null;
    this.img = document.createElement("canvas");
    this.img.width = W; this.img.height = H;
    this.recompute();
  }

  set(opts) {
    Object.assign(this, opts);
    if ("P" in opts || "noise" in opts) this.recompute();
    this.draw(true);
  }

  recompute() {
    this.r = classify(this.P, this.noise);
    const r = this.r, fmt = (x) => x.toLocaleString("en-US"), pct = (x) => `${(100 * x / (W * H)).toFixed(1)}%`;
    const set = (k, v) => { const el = this.readout.querySelector(`[data-k="${k}"]`); if (el) el.textContent = v; };
    set("px", fmt(W * H));
    set("seg", fmt(r.segments.length));
    set("flat", pct(r.count[CLASS.FLAT]));
    set("edge", pct(r.count[CLASS.EDGE]));
    set("curved", pct(r.count[CLASS.CURVED]));
    set("rays", `${fmt(r.nrays)} (÷${(W * H / r.nrays).toFixed(1)})`);
  }

  pixels(fn) {
    const g = this.img.getContext("2d"), id = g.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const c = fn(i);
      id.data[4 * i] = c[0]; id.data[4 * i + 1] = c[1]; id.data[4 * i + 2] = c[2]; id.data[4 * i + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.img, 0, 0, this.cv.width, this.cv.height);
  }

  depthShade(i) {
    const t = Math.min(1, Math.max(0, (this.r.Z[i] - 0.8) / 3.8));
    const g = 238 - 180 * Math.pow(t, 0.85);
    return [g, g + 2, g + 8];
  }

  grid(alpha) {
    const { ctx, cv } = this, s = cv.width / W, ps = this.P;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let u = ps; u < W; u += ps) { ctx.moveTo(Math.round(u * s) + 0.5, 0); ctx.lineTo(Math.round(u * s) + 0.5, cv.height); }
    for (let v = ps; v < H; v += ps) { ctx.moveTo(0, Math.round(v * s) + 0.5); ctx.lineTo(cv.width, Math.round(v * s) + 0.5); }
    ctx.stroke();
  }

  drawLegend() {
    if (!this.legend) return;
    this.legend.innerHTML = STEP_LEGENDS[this.step]
      .map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join("");
  }

  cellPixels(fnCell, base) {
    const r = this.r, ps = this.P;
    this.pixels((i) => {
      const u = i % W, v = (i / W) | 0, ci = ((v / ps) | 0) * r.CW + ((u / ps) | 0);
      return fnCell(r.cells[ci], i, ci) || base(i);
    });
  }

  draw(animate = false) {
    if (this.anim) { cancelAnimationFrame(this.anim); this.anim = null; }
    this.drawLegend();
    const r = this.r, s = this.cv.width / W, ctx = this.ctx;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mix = (a, b, t) => [0, 1, 2].map((k) => a[k] * (1 - t) + b[k] * t);

    if (this.step === 0) { this.pixels((i) => this.depthShade(i)); return; }

    if (this.step === 1) {
      this.pixels((i) => (r.occ[i] ? OCC_RGB : [0, 1, 2].map((k) => 128 + 110 * r.nrm[3 * i + k])));
      return;
    }

    if (this.step === 2) {
      this.cellPixels((c, i) => {
        if (r.occ[i]) return OCC_RGB;
        return mix(this.depthShade(i), c.cand ? [63, 155, 58] : [40, 42, 48], c.cand ? 0.5 : 0.55);
      }, (i) => this.depthShade(i));
      this.grid(0.5);
      return;
    }

    if (this.step === 3) {
      const total = r.order.length, dur = reduce || !animate ? 0 : 1300, t0 = performance.now();
      const rank = new Int32Array(r.cells.length).fill(-1), rid = new Int32Array(r.cells.length).fill(-1);
      r.order.forEach(([c, id], k) => { rank[c] = k; rid[c] = id; });
      const frame = () => {
        const k = dur ? Math.min(total, Math.floor(total * (performance.now() - t0) / dur)) : total;
        const done = k === total;
        this.cellPixels((c, i, ci) => {
          if (r.occ[i]) return mix(this.depthShade(i), OCC_RGB, 0.6);
          if (rank[ci] < 0 || rank[ci] >= k) return null;
          if (done && !r.keptRegion.has(rid[ci])) return mix(this.depthShade(i), [40, 42, 48], 0.55);
          return mix(this.depthShade(i), segRGB(rid[ci]), 0.75);
        }, (i) => mix(this.depthShade(i), [0, 0, 0], 0.15));
        this.grid(0.3);
        if (!done) this.anim = requestAnimationFrame(frame);
      };
      frame();
      return;
    }

    if (this.step === 4) {
      this.cellPixels((c, i) => {
        if (r.crease[i]) return CLASS_RGB[CLASS.EDGE];
        if (c.seg >= 0) return mix(this.depthShade(i), segRGB(r.segments[c.seg].rid), 0.55);
        return null;
      }, (i) => mix(this.depthShade(i), [0, 0, 0], 0.2));
      this.grid(0.25);
      return;
    }

    // step 5: final labels + super-rays
    this.pixels((i) => {
      const c = CLASS_RGB[r.label[i]];
      return r.label[i] === CLASS.FLAT ? mix(this.depthShade(i), c, 0.6) : c;
    });
    this.grid(0.22);
    const wmax = Math.max(1, ...r.rays.map((q) => q.w));
    for (const q of r.rays) {
      ctx.beginPath();
      ctx.arc((q.u + 0.5) * s, (q.v + 0.5) * s, 1.8 + 4.2 * Math.sqrt(q.w / wmax), 0, Math.PI * 2);
      ctx.fillStyle = "#075e5a";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
  }
}
