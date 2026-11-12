# SHIFT project page

Project website for **SHIFT: Surface-aware High-speed Integration For TSDFs**
(Ayaan Choudhury, Lokender Tiwari), accepted to the IEEE/CVF Winter Conference
on Applications of Computer Vision (WACV) 2027.

- Paper: https://arxiv.org/abs/2609.06547
- Code: https://github.com/ayaancdry/shift-tsdf

## Structure

```
index.html               page
assets/css/style.css     styles (light + dark)
assets/js/main.js        wiring for viewers, demos and charts
assets/js/mesh-viewer.js three.js mesh viewers (orbit, sync, cut plane, colour modes)
assets/js/pipeline.js    in-browser toy classifier / super-ray demo
assets/js/fusion.js      freeze / skip illustration
assets/js/charts.js      runtime, ray and memory charts (numbers from the paper tables)
assets/meshes/<ds>/      reconstruction meshes (gzip'd binary, see below)
assets/figures/          paper figures
```

Each mesh is stored as `<name>.geo.gz` (quantized vertices + triangle indices)
plus per-vertex layers: `.rgb.gz` (mesh colour), `.cls.gz` (surface class:
0 unknown, 1 flat, 2 curved, 3 edge) and `.err.gz` (Mesh→GT distance in 0.1 mm).
`ours` / `voxfield` are the representative-voxel meshes of the paper runs;
`surface` is SHIFT's mesh coloured by surface class.

## Local preview

The page loads files with `fetch`, so it needs a web server rather than `file://`:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Deep links: `?ds=flat|cow|tum|nc&mode=rgb|shaded|cls|err` selects the dataset
and colouring of the results viewer.

## Deploy on GitHub Pages

Push this folder to a repository, then Settings → Pages → Deploy from branch →
`main` / root.

Page design adapted from the [PointDiT](https://haofeixu.github.io/pointdit/) project page.
