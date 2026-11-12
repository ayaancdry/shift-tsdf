// Small hand-rolled SVG charts. Numbers are copied from the paper's tables.

export const SWEEP = {
  // [voxel cm, Vf TSDF, Ours TSDF, Vf backend, Ours backend, Vf e2e, Ours e2e]  (ms / frame, Table 3)
  flat: { name: "Flat", rows: [
    [5, 26.70, 9.99, 29.95, 13.87, 41.56, 25.25],
    [10, 15.32, 4.67, 15.71, 5.11, 27.38, 16.55],
    [15, 13.38, 3.62, 13.53, 3.79, 25.28, 15.13],
    [20, 12.67, 3.22, 12.74, 3.30, 24.49, 14.61],
    [25, 12.36, 3.04, 12.40, 3.09, 24.07, 14.51]] },
  cow: { name: "Cow & Lady", rows: [
    [5, 22.24, 15.65, 24.64, 18.03, 36.45, 29.86],
    [10, 13.53, 8.85, 13.79, 9.11, 25.74, 21.10],
    [15, 11.80, 7.41, 11.88, 7.48, 23.86, 19.90],
    [20, 11.14, 6.87, 11.18, 6.90, 23.18, 19.13],
    [25, 10.83, 6.58, 10.85, 6.60, 22.81, 19.37]] },
  tum: { name: "TUM", rows: [
    [5, 15.21, 8.54, 23.26, 15.70, 35.93, 29.08],
    [10, 11.69, 5.99, 12.86, 7.06, 25.68, 20.37],
    [15, 11.13, 5.51, 11.57, 5.90, 24.38, 19.40],
    [20, 10.96, 5.37, 11.20, 5.57, 23.56, 19.18],
    [25, 10.83, 5.20, 11.01, 5.33, 23.83, 19.52]] },
  nc: { name: "Newer College", rows: [
    [25, 58.31, 31.14, 66.29, 38.43, 73.14, 52.56],
    [30, 42.13, 23.15, 46.97, 27.52, 53.83, 41.63],
    [35, 31.75, 17.81, 34.52, 20.84, 41.42, 34.96],
    [40, 24.97, 14.18, 27.06, 16.20, 33.97, 30.21]] },
};
const STAGE_COL = { tsdf: 1, backend: 3, e2e: 5 };
const STAGE_NAME = { tsdf: "TSDF", backend: "Backend", e2e: "End-to-end" };

const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
// Axis top and tick step so that 3-5 ticks land on round numbers.
function niceAxis(v) {
  const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
  return { max: Math.ceil(v / step) * step, step };
}

function tooltip(host) {
  const t = document.createElement("div");
  t.className = "tip";
  host.appendChild(t);
  return {
    show(html, x, y) {
      t.innerHTML = html;
      t.classList.add("on");
      const hw = host.clientWidth, tw = t.offsetWidth;
      t.style.left = `${Math.min(Math.max(4, x - tw / 2), hw - tw - 4)}px`;
      t.style.top = `${Math.max(4, y - t.offsetHeight - 12)}px`;
    },
    hide() { t.classList.remove("on"); },
  };
}

// ------------------------------------------------------------ sweep panels
export function renderSweep(host, stage) {
  host.innerHTML = "";
  const col = STAGE_COL[stage];
  for (const key of ["flat", "cow", "tum", "nc"]) {
    const d = SWEEP[key];
    const card = document.createElement("div");
    card.className = "chart";
    card.innerHTML = `<h5>${d.name}</h5><div class="u">${STAGE_NAME[stage]} ms / frame vs. voxel size (cm)</div>`;
    host.appendChild(card);

    const Wd = 260, Hd = 178, ml = 30, mr = 40, mt = 12, mb = 22;
    const svg = el("svg", { viewBox: `0 0 ${Wd} ${Hd}`, role: "img", "aria-label": `${d.name} ${STAGE_NAME[stage]} runtime` }, card);
    const xs = d.rows.map((r) => r[0]);
    const { max: ymax, step } = niceAxis(Math.max(...d.rows.map((r) => r[col])) * 1.05);
    const X = (v) => ml + ((v - xs[0]) / (xs[xs.length - 1] - xs[0])) * (Wd - ml - mr);
    const Y = (v) => mt + (1 - v / ymax) * (Hd - mt - mb);

    const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
    for (let v = 0; v <= ymax + 1e-9; v += step) {
      const y = Y(v);
      el("line", { x1: ml, x2: Wd - mr, y1: y, y2: y }, g);
      el("text", { x: ml - 5, y: y + 3, "text-anchor": "end" }, ax).textContent = +v.toFixed(1);
    }
    for (const v of xs) el("text", { x: X(v), y: Hd - 6, "text-anchor": "middle" }, ax).textContent = v;

    const series = [
      { c: col, color: "var(--vf)", label: "Voxfield" },
      { c: col + 1, color: "var(--ours)", label: "SHIFT" },
    ];
    for (const s of series) {
      el("path", { d: d.rows.map((r, i) => `${i ? "L" : "M"}${X(r[0])},${Y(r[s.c])}`).join(""),
        fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      for (const r of d.rows) el("circle", { cx: X(r[0]), cy: Y(r[s.c]), r: 3.4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2 }, svg);
      const last = d.rows[d.rows.length - 1];
      el("text", { x: X(last[0]) + 7, y: Y(last[s.c]) + 4, class: "lbl", fill: "var(--ink-soft)" }, svg).textContent = s.label === "SHIFT" ? "SHIFT" : "Vf.";
    }

    // hover: crosshair snapped to nearest voxel size
    const cross = el("line", { y1: mt, y2: Hd - mb, stroke: "var(--ink-faint)", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0 }, svg);
    const hit = el("rect", { x: ml, y: mt, width: Wd - ml - mr, height: Hd - mt - mb, fill: "transparent" }, svg);
    const tip = tooltip(card);
    const move = (ev) => {
      const box = svg.getBoundingClientRect(), sx = ((ev.clientX - box.left) / box.width) * Wd;
      let best = d.rows[0];
      for (const r of d.rows) if (Math.abs(X(r[0]) - sx) < Math.abs(X(best[0]) - sx)) best = r;
      cross.setAttribute("x1", X(best[0]));
      cross.setAttribute("x2", X(best[0]));
      cross.setAttribute("opacity", 1);
      const cb = card.getBoundingClientRect();
      const px = box.left - cb.left + (X(best[0]) / Wd) * box.width;
      const py = box.top - cb.top + (Y(best[col]) / Hd) * box.height;
      tip.show(`<div class="t">${best[0]} cm voxels · ${STAGE_NAME[stage]}</div>Voxfield <b>${best[col].toFixed(2)}</b> ms<br>SHIFT <b>${best[col + 1].toFixed(2)}</b> ms · <b>${(best[col] / best[col + 1]).toFixed(2)}×</b>`, px, py);
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", 0); tip.hide(); });
  }
}

export function renderSweepTable(host) {
  let h = '<table class="data"><thead><tr><th>Dataset</th><th>Voxel (cm)</th><th>TSDF Vf.</th><th>TSDF Ours</th><th>Backend Vf.</th><th>Backend Ours</th><th>E2E Vf.</th><th>E2E Ours</th></tr></thead><tbody>';
  for (const key of ["flat", "cow", "tum", "nc"]) for (const r of SWEEP[key].rows) {
    h += `<tr><td>${SWEEP[key].name}</td><td>${r[0]}</td>`;
    for (let c = 1; c < 7; c += 2) h += `<td>${r[c].toFixed(2)}</td><td class="ours">${r[c + 1].toFixed(2)} (${(r[c] / r[c + 1]).toFixed(2)}×)</td>`;
    h += "</tr>";
  }
  host.innerHTML = h + "</tbody></table>";
}

// ------------------------------------------------------------ ray funnel
export function renderFunnel(host) {
  const rows = [
    { name: "Flat (RGB-D frame)", px: 307000, rays: 62800, ratio: "4.9×" },
    { name: "Newer College (LiDAR scan)", px: 52900, rays: 15900, ratio: "3.3×" },
  ];
  const fmt = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)} k` : v);
  host.innerHTML = rows.map((r) => `
    <div class="row">
      <div class="k"><span>${r.name}</span><b>${fmt(r.px)} → ${fmt(r.rays)} · ${r.ratio} fewer</b></div>
      <div class="track"><i data-w="${100}" style="background:var(--vf);width:0"></i></div>
      <div class="track" style="margin-top:3px"><i data-w="${(100 * r.rays) / r.px}" style="background:var(--ours);width:0"></i></div>
    </div>`).join("") +
    '<div class="legend" style="justify-content:flex-start;margin-top:2px"><span><i style="background:var(--vf)"></i>input pixels / returns</span><span><i style="background:var(--ours)"></i>rays after bundling</span></div>';
  const grow = () => host.querySelectorAll("i[data-w]").forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { grow(); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(host);
  } else grow();
}

// ------------------------------------------------------------ flat fraction vs speedup
export function renderScatter(host) {
  const pts = [
    { name: "Flat", flat: 78.9, sp: 3.28 },
    { name: "TUM", flat: 47.3, sp: 1.95 },
    { name: "Cow & Lady", flat: 42.1, sp: 1.53 },
    { name: "Newer College", flat: 70.6, sp: 1.87, lidar: true },
  ];
  const Wd = 420, Hd = 230, ml = 34, mr = 16, mt = 14, mb = 30;
  const X = (v) => ml + ((v - 35) / (85 - 35)) * (Wd - ml - mr);
  const Y = (v) => mt + (1 - (v - 1) / (3.5 - 1)) * (Hd - mt - mb);
  host.classList.add("chart");
  host.style.border = "none"; host.style.padding = "0"; host.style.background = "transparent";
  const svg = el("svg", { viewBox: `0 0 ${Wd} ${Hd}`, role: "img", "aria-label": "Flat fraction against TSDF speedup" }, host);
  const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
  for (const v of [1, 1.5, 2, 2.5, 3, 3.5]) {
    el("line", { x1: ml, x2: Wd - mr, y1: Y(v), y2: Y(v) }, g);
    el("text", { x: ml - 5, y: Y(v) + 3, "text-anchor": "end" }, ax).textContent = `${v}×`;
  }
  for (const v of [40, 50, 60, 70, 80]) el("text", { x: X(v), y: Hd - 12, "text-anchor": "middle" }, ax).textContent = `${v}%`;
  el("text", { x: (ml + Wd - mr) / 2, y: Hd - 0, "text-anchor": "middle" }, ax).textContent = "pixels labelled flat";
  const tip = tooltip(host);
  for (const p of pts) {
    const c = el("circle", { cx: X(p.flat), cy: Y(p.sp), r: 6, fill: p.lidar ? "var(--surface)" : "var(--ours)", stroke: "var(--ours)", "stroke-width": 2 }, svg);
    const right = p.flat < 75;
    el("text", { x: X(p.flat) + (right ? 10 : -10), y: Y(p.sp) + 4, "text-anchor": right ? "start" : "end", class: "lbl", fill: "var(--ink-soft)" }, svg).textContent = p.name;
    const hit = el("circle", { cx: X(p.flat), cy: Y(p.sp), r: 16, fill: "transparent" }, svg);
    hit.addEventListener("pointerenter", () => {
      const sb = svg.getBoundingClientRect(), hb = host.getBoundingClientRect();
      tip.show(`<div class="t">${p.name}${p.lidar ? " · LiDAR" : " · RGB-D"}</div>flat <b>${p.flat}%</b> · TSDF <b>${p.sp}×</b>`,
        sb.left - hb.left + (X(p.flat) / Wd) * sb.width, sb.top - hb.top + (Y(p.sp) / Hd) * sb.height);
      c.setAttribute("r", 7.5);
    });
    hit.addEventListener("pointerleave", () => { tip.hide(); c.setAttribute("r", 6); });
  }
  const lg = el("g", {}, svg);
  el("circle", { cx: ml + 10, cy: mt + 6, r: 5, fill: "var(--ours)" }, lg);
  el("text", { x: ml + 20, y: mt + 10, class: "lbl", fill: "var(--ink-soft)" }, lg).textContent = "RGB-D";
  el("circle", { cx: ml + 76, cy: mt + 6, r: 5, fill: "var(--surface)", stroke: "var(--ours)", "stroke-width": 2 }, lg);
  el("text", { x: ml + 86, y: mt + 10, class: "lbl", fill: "var(--ink-soft)" }, lg).textContent = "LiDAR";
}

// ------------------------------------------------------------ ESDF memory (indexed to Voxfield)
export function renderMemory(host) {
  const rows = [
    { name: "Flat", ours: 109.7, vf: 118.8 },
    { name: "Cow & Lady", ours: 118.8, vf: 148.5 },
    { name: "TUM", ours: 119.1, vf: 148.8 },
    { name: "Newer College", ours: 1844.3, vf: 2551.5 },
  ];
  host.innerHTML = '<div class="funnel">' + rows.map((r) => {
    const ratio = r.ours / r.vf;
    return `<div class="row">
      <div class="k"><span>${r.name}</span><b>${r.vf.toFixed(1)} → ${r.ours.toFixed(1)} MB · ratio ${ratio.toFixed(2)} (−${Math.round(100 * (1 - ratio))}%)</b></div>
      <div class="track"><i data-w="100" style="background:var(--vf);width:0"></i></div>
      <div class="track" style="margin-top:3px"><i data-w="${100 * ratio}" style="background:var(--ours);width:0"></i></div>
    </div>`;
  }).join("") + '</div><div class="legend" style="justify-content:flex-start"><span><i style="background:var(--vf)"></i>Voxfield (= 100%)</span><span><i style="background:var(--ours)"></i>SHIFT</span></div>';
  const grow = () => host.querySelectorAll("i[data-w]").forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { grow(); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(host);
  } else grow();
}
