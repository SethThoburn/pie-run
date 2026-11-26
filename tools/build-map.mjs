// Converts the OpenStreetMap extract of Deary, Idaho (tools/deary-osm.json)
// into compact local pixel-space vector data for the game (src/mapdata.js).
//
// Map data (c) OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright
//
// Usage: node tools/build-map.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const osm = JSON.parse(readFileSync(join(here, 'deary-osm.json'), 'utf8'));

// ---- Projection -----------------------------------------------------------
// Crop window around town (degrees) and world scale (metres per pixel).
const LON_MIN = -116.5675, LON_MAX = -116.5480;
const LAT_MIN = 46.7940, LAT_MAX = 46.8060;
const MPP = 0.5;

const phi = ((LAT_MIN + LAT_MAX) / 2) * Math.PI / 180;
const M_PER_DEG_LAT = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
const M_PER_DEG_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);

const W = Math.round((LON_MAX - LON_MIN) * M_PER_DEG_LON / MPP);
const H = Math.round((LAT_MAX - LAT_MIN) * M_PER_DEG_LAT / MPP);

const px = (lon) => (lon - LON_MIN) * M_PER_DEG_LON / MPP;
const py = (lat) => (LAT_MAX - lat) * M_PER_DEG_LAT / MPP;
const r1 = (v) => Math.round(v * 10) / 10;

// ---- Index ----------------------------------------------------------------
const nodes = new Map();
const ways = [];
for (const e of osm.elements) {
  if (e.type === 'node') nodes.set(e.id, e);
  else if (e.type === 'way') ways.push(e);
}
const wayPts = (w) => {
  const out = [];
  for (const id of w.nodes) {
    const n = nodes.get(id);
    if (n) out.push(r1(px(n.lon)), r1(py(n.lat)));
  }
  return out;
};
const ptsBBox = (p) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
  }
  return [x0, y0, x1, y1];
};
const MARGIN = 400; // keep features that reach a little beyond the crop
const touchesWorld = (p) => {
  const [x0, y0, x1, y1] = ptsBBox(p);
  return x1 > -MARGIN && y1 > -MARGIN && x0 < W + MARGIN && y0 < H + MARGIN;
};
const polyArea = (p) => {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(a / 2);
};
const pointInPoly = (x, y, p) => {
  let inside = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// ---- Roads ----------------------------------------------------------------
const ROAD_CLASS = {
  secondary: 'hwy', tertiary: 'main', residential: 'res', unclassified: 'res',
  service: 'svc', track: 'track', path: 'path', footway: 'path',
};
const roads = [];
for (const w of ways) {
  const t = w.tags || {};
  const cls = ROAD_CLASS[t.highway];
  if (!cls) continue;
  const pts = wayPts(w);
  if (pts.length < 4 || !touchesWorld(pts)) continue;
  roads.push({ c: cls, n: t.name || '', p: pts });
}
const rails = [];
for (const w of ways) {
  const t = w.tags || {};
  if (t.railway === 'abandoned' || t.railway === 'rail' || t.railway === 'disused') {
    const pts = wayPts(w);
    if (pts.length >= 4 && touchesWorld(pts)) rails.push(pts);
  }
}

// ---- Areas ----------------------------------------------------------------
function areaKind(t) {
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'water') return 'water';
  if (t.natural === 'scrub' || t.natural === 'heath' || t.natural === 'grassland') return 'scrub';
  if (t.landuse === 'farmland' || t.landuse === 'meadow') return 'field';
  if (t.landuse === 'residential') return 'town';
  if (t.landuse === 'commercial' || t.landuse === 'retail') return 'commercial';
  if (t.landuse === 'cemetery') return 'cemetery';
  if (t.landuse === 'farmyard') return 'farmyard';
  if (t.leisure === 'pitch') return 'pitch';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'recreation_ground') return 'park';
  if (t.amenity === 'school') return 'school';
  if (t.amenity === 'parking') return 'parking';
  return null;
}
const areas = [];
for (const w of ways) {
  const t = w.tags || {};
  if (t.building || t.highway) continue;
  const k = areaKind(t);
  if (!k) continue;
  const pts = wayPts(w);
  if (pts.length < 6 || !touchesWorld(pts)) continue;
  areas.push({ k, p: pts, big: polyArea(pts) > 1e6 ? 1 : 0 });
}

// ---- Buildings & places ---------------------------------------------------
const named = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node' && t.name) named.push({ name: t.name, x: px(e.lon), y: py(e.lat), t });
}
const buildings = [];
for (const w of ways) {
  const t = w.tags || {};
  if (!t.building) continue;
  const pts = wayPts(w);
  if (pts.length < 6 || !touchesWorld(pts)) continue;
  // Closed ways repeat the first node; drop the duplicate.
  if (pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.splice(-2, 2);
  let name = t.name || '';
  for (const n of named) if (!name && pointInPoly(n.x, n.y, pts)) name = n.name;
  buildings.push({ n: name, k: t.building, p: pts });
}

// ---- Key locations ----------------------------------------------------------
// The Pie Safe Bakery & Kitchen, 307 Main Street (OSM node).
const pieNode = named.find((n) => n.name.startsWith('The Pie Safe Bakery'));
if (!pieNode) throw new Error('Pie Safe node not found');
const pieBuilding = buildings.find((b) => pointInPoly(pieNode.x, pieNode.y, b.p));
if (!pieBuilding) throw new Error('Pie Safe building not found');
pieBuilding.pie = 1;

// 704 5th Avenue: the long white house on the south side of 5th Ave between Oregon St
// and Division St, just west of the basketball court (confirmed from aerial imagery).
// This point is the 5th Ave centreline in front of it.
const home = { x: r1(px(-116.55389)), y: r1(py(46.80185)) };

const out = {
  attribution: 'Map data (c) OpenStreetMap contributors (ODbL)',
  w: W, h: H, mpp: MPP,
  roads, rails, areas, buildings,
  pie: { x: r1(pieNode.x), y: r1(pieNode.y) },
  home,
};
const js = `// GENERATED by tools/build-map.mjs from OpenStreetMap data. Do not edit by hand.\n` +
  `// Map data (c) OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright\n` +
  `window.MAPDATA = ${JSON.stringify(out)};\n`;
writeFileSync(join(here, '..', 'src', 'mapdata.js'), js);
console.log(`world ${W}x${H}px, ${roads.length} roads, ${areas.length} areas, ${buildings.length} buildings, ${rails.length} rails; ${(js.length / 1024).toFixed(0)} KB`);
console.log('pie building:', pieBuilding.n, ptsBBox(pieBuilding.p).map(Math.round), 'pie node', out.pie, 'home', home);
