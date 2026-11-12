import { MeshViewer, syncViewers, loadGeometry, loadLayer, rgbColors, classColors, errorColors, turbo } from "./mesh-viewer.js?v=20261028b";
import { PipelineLab } from "./pipeline.js?v=20261028b";
import { FusionSim } from "./fusion.js?v=20261028b";
import { renderSweep, renderSweepTable, renderFunnel, renderScatter, renderMemory } from "./charts.js?v=20261028b";

const MESH = "assets/meshes";

// Representative-voxel numbers from the paper (Tables 2-4; Mesh→GT from the accuracy-vs-voxel figure's
// results.csv, mean over vertices within 2 voxels of the GT).
const DATASETS = {
  flat: {
    name: "Flat", voxel: 10, clip: 1.45, err: true, cap: 3.5,
    view: { dir: [0.38, -0.62, 1.15], dist: 0.62 },
    note: "Synthetic RGB-D, 399 frames, 10 cm voxels. The ceiling is cut at 1.45 m by default. Error colour cap 3.5 cm, as in the paper's heatmap.",
    vf: { tsdf: 15.32, mesh: 1.75, chamfer: 3.71, cov: 88.0, esdf: 118.8 },
    ours: { tsdf: 4.67, mesh: 1.94, chamfer: 3.82, cov: 87.7, esdf: 109.7 },
  },
  cow: {
    name: "Cow & Lady", voxel: 10, clip: 2.4, err: true, cap: 15,
    view: { dir: [-0.55, -0.7, 1.1], dist: 0.62 },
    note: "Real RGB-D, 2701 frames, 10 cm voxels. Planar structure is scarce here, so the gain is the smallest of the four. Error colour cap 15 cm (about 2× the mean). The GT scan does not cover the whole room, so about 30% of the mesh lies more than 2 voxels from it; those vertices are grey and, as in the paper, excluded from the mean.",
    vf: { tsdf: 13.53, mesh: 7.82, chamfer: 7.54, cov: 81.7, esdf: 148.5 },
    ours: { tsdf: 8.85, mesh: 7.95, chamfer: 7.44, cov: 82.1, esdf: 118.8 },
  },
  tum: {
    name: "TUM fr1/room", voxel: 10, clip: 2.3, err: true, cap: 6.5,
    view: { dir: [0.5, -0.6, 1.2], dist: 0.5 },
    note: "Real handheld RGB-D with Kinect noise, 84 frames, 10 cm voxels. Error colour cap 6.5 cm (about 2× the mean).",
    vf: { tsdf: 11.69, mesh: 3.34, chamfer: 4.71, cov: 99.7, esdf: 148.8 },
    ours: { tsdf: 5.99, mesh: 3.46, chamfer: 4.74, cov: 99.7, esdf: 119.1 },
  },
  nc: {
    name: "Newer College", voxel: 25, clip: null, err: true, cap: 9,
    view: { dir: [0.35, -0.45, 1.0], dist: 0.55 },
    note: "Real outdoor LiDAR (quad), 1986 scans, 25 cm voxels. Error colour cap 9 cm, as in the paper's heatmap.",
    vf: { tsdf: 58.31, mesh: 6.43, chamfer: 10.39, cov: 94.6, esdf: 2551.5 },
    ours: { tsdf: 31.14, mesh: 6.43, chamfer: 10.37, cov: 94.7, esdf: 1844.3 },
  },
};

// ------------------------------------------------------------ chrome
function initChrome(onTheme) {
  const btn = document.getElementById("theme-btn");
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("shift-theme", next); } catch (e) { /* storage unavailable */ }
    onTheme();
  });

  const links = [...document.querySelectorAll(".nav-links a")];
  const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((a) => a.classList.remove("active"));
      const a = map.get(e.target.id);
      if (a) a.classList.add("active");
    }), { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("section[id]").forEach((s) => io.observe(s));
  }

  const copy = document.getElementById("bib-copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById("bib-text").textContent);
      copy.textContent = "Copied";
    } catch (e) {
      copy.textContent = "Select & copy";
    }
    setTimeout(() => { copy.textContent = "Copy"; }, 1600);
  });
}

function segmented(id, attr, onPick) {
  const host = document.getElementById(id);
  host.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    host.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onPick(b.dataset[attr]);
  });
  return host;
}

// ------------------------------------------------------------ mesh helpers
// Returns { geometry, colors } for one panel; colors null means clay shading.
const colorCache = new Map();
async function meshFor(ds, method, mode, cap, progress) {
  const surface = mode === "cls" && method === "ours";
  const name = surface ? "surface" : method;
  const geometry = await loadGeometry(`${MESH}/${ds}/${name}.geo.gz`, progress);
  if (mode === "shaded" || (mode === "cls" && !surface)) return { geometry, colors: null };
  const key = `${ds}/${name}/${mode}`;
  if (mode === "rgb") {
    if (!colorCache.has(key)) colorCache.set(key, rgbColors(await loadLayer(`${MESH}/${ds}/${name}.rgb.gz`)));
    return { geometry, colors: colorCache.get(key) };
  }
  if (mode === "cls") {
    if (!colorCache.has(key)) colorCache.set(key, classColors(await loadLayer(`${MESH}/${ds}/surface.cls.gz`)));
    return { geometry, colors: colorCache.get(key) };
  }
  const err = await loadLayer(`${MESH}/${ds}/${name}.err.gz`, "err");
  const buf = colorCache.get(key) || new Float32Array(err.length * 3);
  colorCache.set(key, buf);
  return { geometry, colors: errorColors(err, cap, buf, 2 * DATASETS[ds].voxel) };
}

// ------------------------------------------------------------ teaser
function initTeaser(viewers) {
  const v = new MeshViewer(document.getElementById("teaser-viewer"), { label: "SHIFT · Flat · 10 cm voxels", ours: true, autoRotate: true });
  viewers.push(v);
  const cfg = DATASETS.flat;
  let mode = "cls", framed = false;
  const legend = document.getElementById("teaser-legend");
  const show = async () => {
    v.loading(true, 0);
    const { geometry, colors } = await meshFor("flat", "ours", mode, cfg.cap, (f) => v.loading(true, f));
    v.show(geometry, colors);
    v.setClipZ(cfg.clip);
    if (!framed) {
      v.frame(geometry.boundingBox, { dir: [0.42, -0.7, 1.3], dist: 0.6 });
      framed = true;
    }
    v.loading(false);
  };
  v.onReset = () => { v.frame(v.mesh.geometry.boundingBox, { dir: [0.42, -0.7, 1.3], dist: 0.6 }); };
  segmented("teaser-mode", "mode", (m) => { mode = m; legend.style.visibility = m === "cls" ? "visible" : "hidden"; show(); });
  show().catch((e) => v.setNote(`could not load mesh (${e.message})`));
}

// ------------------------------------------------------------ results
function initResults(viewers) {
  const vf = new MeshViewer(document.getElementById("res-vf"), { label: "Voxfield" });
  const ours = new MeshViewer(document.getElementById("res-ours"), { label: "SHIFT (ours)", ours: true });
  viewers.push(vf, ours);
  syncViewers([vf, ours]);

  const state = { ds: "flat", mode: "rgb", clipT: 1, cap: 3.5 };
  const clip = document.getElementById("res-clip"), clipOut = document.getElementById("res-clip-out");
  const capWrap = document.getElementById("res-cap-wrap"), cap = document.getElementById("res-cap"), capOut = document.getElementById("res-cap-out");
  const legendCls = document.getElementById("res-legend-cls"), colorbar = document.getElementById("res-colorbar");
  const errBtn = document.querySelector('#res-mode button[data-mode="err"]');
  let token = 0, bounds = null;

  const ramp = document.getElementById("res-ramp").getContext("2d");
  for (let x = 0; x < 240; x++) {
    const [r, g, b] = turbo(x / 239);
    ramp.fillStyle = `rgb(${r * 255},${g * 255},${b * 255})`;
    ramp.fillRect(x, 0, 1, 10);
  }

  const metrics = () => {
    const d = DATASETS[state.ds];
    const row = (m, isOurs) => `
      <div class="mrow">
        <div title="TSDF integration time per frame"><div class="k">TSDF ms</div><div class="v">${m.tsdf.toFixed(2)}${isOurs ? `<em>${(d.vf.tsdf / d.ours.tsdf).toFixed(2)}×</em>` : ""}</div></div>
        <div title="Mean distance from mesh vertices to the nearest GT point"><div class="k">Mesh→GT cm</div><div class="v">${m.mesh.toFixed(2)}</div></div>
        <div title="Symmetric Chamfer-L1 distance"><div class="k">Chamfer cm</div><div class="v">${m.chamfer.toFixed(2)}</div></div>
        <div title="Reconstruction coverage: GT points within one voxel of the mesh"><div class="k">Coverage %</div><div class="v">${m.cov.toFixed(1)}</div></div>
        <div title="ESDF layer memory"><div class="k">ESDF MB</div><div class="v">${m.esdf.toFixed(1)}</div></div>
      </div>`;
    document.getElementById("res-metrics").innerHTML = row(d.vf, false) + row(d.ours, true);
    document.getElementById("res-note").textContent = d.note;
  };

  const clipZ = () => {
    if (!bounds) return 1e6;
    const lo = bounds.min.z, hi = bounds.max.z;
    return lo + state.clipT * (hi - lo) + (state.clipT >= 0.999 ? 1 : 0);
  };
  const applyClip = () => {
    const z = clipZ();
    vf.setClipZ(z); ours.setClipZ(z);
    clipOut.textContent = state.clipT >= 0.999 ? "off" : `${z.toFixed(2)} m`;
  };

  const show = async (reframe) => {
    const my = ++token, d = DATASETS[state.ds];
    vf.loading(true, 0); ours.loading(true, 0);
    vf.setNote(state.mode === "cls" ? "Voxfield has no surface classes (clay shading)" : "");
    ours.setNote("");
    try {
      const [a, b] = await Promise.all([
        meshFor(state.ds, "voxfield", state.mode, state.cap, (f) => vf.loading(true, f)),
        meshFor(state.ds, "ours", state.mode, state.cap, (f) => ours.loading(true, f)),
      ]);
      if (my !== token) return;
      vf.show(a.geometry, a.colors);
      ours.show(b.geometry, b.colors);
      if (reframe) {
        bounds = b.geometry.boundingBox.clone().union(a.geometry.boundingBox);
        ours.frame(bounds, d.view);
        vf.copyView(ours);
      }
      applyClip();
    } catch (e) {
      vf.setNote(`could not load mesh (${e.message})`);
    }
    vf.loading(false); ours.loading(false);
  };
  const reset = () => { if (bounds) { ours.frame(bounds, DATASETS[state.ds].view); vf.copyView(ours); } };
  vf.onReset = ours.onReset = reset;

  const setMode = (m) => {
    state.mode = m;
    legendCls.hidden = m !== "cls";
    colorbar.hidden = m !== "err";
    capWrap.hidden = m !== "err";
    document.querySelectorAll("#res-mode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  };

  segmented("ds-tabs", "ds", (ds) => {
    state.ds = ds;
    const d = DATASETS[ds];
    errBtn.disabled = !d.err;
    if (state.mode === "err" && !d.err) setMode("rgb");
    if (d.err) {
      state.cap = d.cap;
      cap.value = d.cap;
      capOut.textContent = `${d.cap} cm`;
      document.getElementById("res-ramp-max").textContent = `${d.cap} cm`;
      document.getElementById("res-trunc").textContent = `${2 * d.voxel} cm`;
    }
    bounds = null;
    metrics();
    // default cut: just below the ceiling for indoor scenes
    show(true).then(() => {
      if (!bounds) return;
      state.clipT = d.clip == null ? 1 : (d.clip - bounds.min.z) / (bounds.max.z - bounds.min.z);
      clip.value = state.clipT;
      applyClip();
    });
  });
  segmented("res-mode", "mode", (m) => { setMode(m); show(false); });
  clip.addEventListener("input", () => { state.clipT = +clip.value; applyClip(); });
  cap.addEventListener("input", () => {
    state.cap = +cap.value;
    capOut.textContent = `${state.cap} cm`;
    document.getElementById("res-ramp-max").textContent = `${state.cap} cm`;
    if (state.mode === "err") show(false);
  });

  // first load once the section is near the viewport
  const q = new URLSearchParams(location.search);
  const qds = DATASETS[q.get("ds")] ? q.get("ds") : "flat";
  const start = () => {
    const qm = q.get("mode");
    if (["rgb", "shaded", "cls", "err"].includes(qm) && (qm !== "err" || DATASETS[qds].err)) setMode(qm);
    document.querySelector(`#ds-tabs button[data-ds="${qds}"]`).click();
  };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { start(); io.disconnect(); } }, { rootMargin: "600px" });
    io.observe(document.getElementById("results"));
  } else start();
}

// ------------------------------------------------------------ method demos
function initLab() {
  const lab = new PipelineLab(document.getElementById("lab-canvas"), document.getElementById("lab-readout"), document.getElementById("lab-legend"));
  lab.draw();
  segmented("lab-steps", "step", (s) => lab.set({ step: +s }));
  const p = document.getElementById("lab-p"), pOut = document.getElementById("lab-p-out");
  const n = document.getElementById("lab-noise"), nOut = document.getElementById("lab-noise-out");
  p.addEventListener("input", () => { pOut.textContent = p.value; lab.set({ P: +p.value }); });
  n.addEventListener("input", () => { const k = +n.value / 4; nOut.textContent = `${k}σ`; lab.set({ noise: k }); });
}

function initFusion() {
  const sim = new FusionSim(document.getElementById("fuse-canvas"), document.getElementById("fuse-readout"));
  const play = document.getElementById("fuse-play");
  sim.onPlay = (on) => { play.textContent = on ? "❚❚ Pause" : "▶ Play"; };
  play.addEventListener("click", () => sim.play());
  document.getElementById("fuse-reset").addEventListener("click", () => sim.reset());
  segmented("fuse-mode", "mode", (m) => sim.setMode(m));
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { sim.play(); io.disconnect(); } }, { threshold: 0.5 });
    io.observe(document.getElementById("fuse-canvas"));
  }
  return sim;
}

// ------------------------------------------------------------ boot
const viewers = [];
let sim = null;
initChrome(() => {
  viewers.forEach((v) => v.applyTheme());
  if (sim) sim.draw();
  renderSweep(document.getElementById("sweep-charts"), currentStage);
});

let currentStage = "tsdf";
renderSweep(document.getElementById("sweep-charts"), currentStage);
renderSweepTable(document.getElementById("sweep-table"));
segmented("stage-tabs", "stage", (s) => { currentStage = s; renderSweep(document.getElementById("sweep-charts"), s); });
renderFunnel(document.getElementById("funnel"));
renderScatter(document.getElementById("scatter"));
renderMemory(document.getElementById("memory"));

initLab();
sim = initFusion();
initTeaser(viewers);
initResults(viewers);
