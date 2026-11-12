// Illustration of the integrator's per-frame work on a flat wall, following
// NpTsdfIntegrator: Voxfield's fast integrator casts only the first ray that
// ends in each half-voxel cell; SHIFT casts one super-ray per image tile and
// applies the freeze / skip rules (paper Sec. 3.3). One row of surface voxels
// is drawn; a real cast also updates the voxels along its ray inside 2*tau.

const NV = 20;              // wall voxels (voxel size = 1)
const PIX = 48;             // pixels across the image
const PW = 0.2;             // pixel footprint on the wall, in voxels
const TILE = 12;            // P: pixels per tile (footprint 2.4 voxels)
const W_F = 5;              // flat_convergence_weight_thresh
const DELTA = 0.01;         // flat_fusion_skip_thresh_m
const SIGMA = 0.006;        // per-pixel depth noise (m)
const SPEED = 0.29;         // sensor motion per frame, in voxels
const FRAMES = 72;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class FusionSim {
  constructor(canvas, readout) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.readout = readout;
    this.mode = "shift";
    this.timer = null;
    this.reset();
  }

  reset() {
    this.stop();
    this.rand = rng(11);
    this.k = 0;
    this.vox = Array.from({ length: NV }, () => ({ W: 0, D: 0, g: false, frozen: false, act: "" }));
    this.cnt = { cast: 0, grad: 0, upd: 0, skip: 0 };
    this.rays = [];
    this.tiles = [];
    this.sensor = this.sensorX(0);
    this.draw();
    this.report();
  }

  setMode(m) { this.mode = m; this.reset(); }

  // sensor sweeps back and forth so its field of view stays on the wall
  sensorX(k) {
    const lo = (PIX * PW) / 2, hi = NV - lo, span = hi - lo;
    const p = (k * SPEED) % (2 * span);
    return lo + (p < span ? p : 2 * span - p);
  }

  gauss() {
    return Math.sqrt(-2 * Math.log(this.rand() + 1e-12)) * Math.cos(2 * Math.PI * this.rand());
  }

  step() {
    this.k++;
    const s = (this.sensor = this.sensorX(this.k));
    const x0 = s - (PIX * PW) / 2;
    for (const v of this.vox) v.act = "";
    this.rays = [];
    this.tiles = [];

    // candidate rays in image order: [end x on the wall, weight, depth noise sigma, flat?]
    const cand = [];
    if (this.mode === "shift") {
      for (let t = 0; t < PIX / TILE; t++) {
        const a = x0 + t * TILE * PW, b = a + TILE * PW;
        this.tiles.push([a, b]);
        // super-ray: weighted mean of the tile's pixels, snapped onto the plane
        cand.push([(a + b) / 2, TILE, SIGMA / Math.sqrt(TILE), true]);
      }
    } else {
      for (let j = 0; j < PIX; j++) cand.push([x0 + (j + 0.5) * PW, 1, SIGMA, false]);
    }

    const usedCells = new Set();               // start_voxel_subsampling_factor = 2
    for (const [x, w, sig, flat] of cand) {
      const cell = Math.floor(x * 2);
      if (usedCells.has(cell)) continue;       // a ray ending in a used cell is skipped
      usedCells.add(cell);
      this.cnt.cast++;
      const i = Math.floor(x);
      if (i < 0 || i >= NV) continue;
      this.rays.push({ x, w });
      const v = this.vox[i];
      const d = sig * this.gauss();            // true distance to the surface is 0
      if (v.frozen) {
        if (Math.abs(d - v.D) < DELTA) { v.act = "skip"; this.cnt.skip++; continue; }
      } else {
        v.g = true;                            // gradient re-estimated (not on the frozen path)
        this.cnt.grad++;
      }
      v.D = (v.D * v.W + d * w) / (v.W + w);
      v.W = Math.min(v.W + w, 1e4);
      this.cnt.upd++;
      v.act = "upd";
      if (flat && !v.frozen && v.W >= W_F && v.g) v.frozen = true;   // freeze rule
    }
    this.draw();
    this.report();
  }

  report() {
    const set = (k, val) => { const el = this.readout.querySelector(`[data-k="${k}"]`); if (el) el.textContent = val; };
    const f = (x) => x.toLocaleString("en-US");
    set("frame", `${this.k} / ${FRAMES}`);
    set("cast", f(this.cnt.cast));
    set("grad", f(this.cnt.grad));
    set("upd", f(this.cnt.upd));
    set("skip", this.mode === "vf" ? "–" : f(this.cnt.skip));
  }

  play() {
    if (this.timer) { this.stop(); return; }
    if (this.k >= FRAMES) this.reset();
    this.timer = setInterval(() => {
      if (this.k >= FRAMES) { this.stop(); return; }
      this.step();
    }, 140);
    this.onPlay && this.onPlay(true);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onPlay && this.onPlay(false);
  }

  draw() {
    const { ctx, cv } = this, Wc = cv.width, Hc = cv.height;
    const ink = css("--ink") || "#10222a", faint = css("--ink-faint") || "#5d7078";
    const line = css("--line-strong") || "#c4d1ce", surf = css("--surface") || "#fff";
    const surf2 = css("--surface-2") || "#e9efee", acc = css("--accent") || "#0b7a75", flat = css("--flat") || "#3f9b3a";
    ctx.fillStyle = surf;
    ctx.fillRect(0, 0, Wc, Hc);

    const m = 20, mr = 66, cw = (Wc - m - mr) / NV, vy = 196, vh = cw * 0.9;
    const X = (x) => m + x * cw;
    const sx = X(this.sensor), sy = 30;

    // tile footprints (image space, so they slide with the sensor)
    if (this.mode === "shift") {
      ctx.strokeStyle = faint;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      for (const [a, b] of this.tiles) {
        ctx.beginPath();
        ctx.moveTo(X(a) + 1, vy - 22); ctx.lineTo(X(a) + 1, vy - 28); ctx.lineTo(X(b) - 1, vy - 28); ctx.lineTo(X(b) - 1, vy - 22);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // cast rays
    for (const r of this.rays) {
      ctx.strokeStyle = acc;
      ctx.globalAlpha = r.w > 1 ? 0.95 : 0.5;
      ctx.lineWidth = r.w > 1 ? 3 : 1;
      ctx.beginPath();
      ctx.moveTo(sx, sy + 8);
      ctx.lineTo(X(r.x), vy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = acc;
      ctx.beginPath();
      ctx.arc(X(r.x), vy - 1, r.w > 1 ? 3.5 : 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // sensor
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.roundRect(sx - 15, sy - 9, 30, 18, 4);
    ctx.fill();
    ctx.fillStyle = surf;
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fill();

    // weight bars + voxels
    const barH = 50, by = vy - 36;
    for (let i = 0; i < NV; i++) {
      const v = this.vox[i], x = X(i) + 2, w = cw - 4;
      ctx.fillStyle = surf2;
      ctx.fillRect(x + w * 0.3, by - barH, w * 0.4, barH);
      const h = Math.min(1, v.W / (2 * W_F)) * barH;
      ctx.fillStyle = v.frozen ? flat : acc;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x + w * 0.3, by - h, w * 0.4, h);
      ctx.globalAlpha = 1;

      ctx.fillStyle = v.act === "skip" ? surf2 : v.frozen ? flat : v.act === "upd" ? acc : surf;
      ctx.globalAlpha = v.frozen && v.act !== "skip" ? 0.85 : 1;
      ctx.fillRect(x, vy + 6, w, vh);
      ctx.globalAlpha = 1;
      ctx.lineWidth = v.act === "upd" ? 2 : 1;
      ctx.strokeStyle = v.act === "upd" ? acc : line;
      ctx.strokeRect(x + 0.5, vy + 6.5, w - 1, vh - 1);
      if (v.frozen) {
        const cx = x + w / 2, cy = vy + 6 + vh / 2;
        const col = v.act === "skip" ? flat : "#fff";
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(cx, cy - 2, 3.4, Math.PI, 0);
        ctx.stroke();
        ctx.fillRect(cx - 5, cy - 2, 10, 7);
      }
    }
    const yf = by - (W_F / (2 * W_F)) * barH;
    ctx.strokeStyle = faint;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(m, yf);
    ctx.lineTo(Wc - mr + 4, yf);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = faint;
    ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.fillText("W_f = 5", Wc - mr + 10, yf + 4);
    ctx.fillText("weight", Wc - mr + 10, by - barH + 8);
    if (this.mode === "shift") ctx.fillText("tiles", Wc - mr + 10, vy - 22);
    ctx.fillText("voxels", Wc - mr + 10, vy + 6 + vh / 2 + 4);
  }
}
