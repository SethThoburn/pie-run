// Turns the USGS NAIP aerial photo of Deary (tools/imagery/deary-naip.png, aligned to
// the world grid) into pixel-art game data, written to src/satdata.js:
//   - ground: a half-resolution palette-index map (smoothed, quantized real colours),
//     each palette colour tagged with a terrain class (canopy, lawn, dry grass, bare...)
//   - houses: rooftops detected in the photo as oriented rectangles with real colours
// Imagery: USGS The National Map, NAIP Plus (public domain).
//
// Usage: node tools/build-sat.mjs [previewDir]

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const preview = process.argv[2] || null;
globalThis.window = {};
new Function(readFileSync(join(here, '..', 'src', 'mapdata.js'), 'utf8'))();
const MAP = globalThis.window.MAPDATA;
const W = MAP.w, H = MAP.h;

const raw = execFileSync('magick', [join(here, 'imagery', 'deary-naip.png'), '-alpha', 'off', '-depth', '8', 'rgb:-'], { maxBuffer: 1 << 30 });
if (raw.length !== W * H * 3) throw new Error(`imagery is not ${W}x${H}`);

function savePreview(name, w, h, rgbBuf) {
  if (!preview) return;
  execFileSync('magick', ['-size', `${w}x${h}`, '-depth', '8', 'rgb:-', join(preview, name)], { input: rgbBuf });
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(83823);

// ---- Half-resolution smoothed ground colour -------------------------------------------
const GW = Math.ceil(W / 2), GH = Math.ceil(H / 2);
const half = new Float32Array(GW * GH * 3);
for (let gy = 0; gy < GH; gy++) {
  for (let gx = 0; gx < GW; gx++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = gx * 2 + dx, y = gy * 2 + dy;
      if (x >= W || y >= H) continue;
      const i = (y * W + x) * 3;
      r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++;
    }
    const k = (gy * GW + gx) * 3;
    half[k] = r / n; half[k + 1] = g / n; half[k + 2] = b / n;
  }
}
// 3x3 box blur to drop cars, fence posts and photo noise.
const smooth = new Float32Array(half.length);
for (let y = 0; y < GH; y++) {
  for (let x = 0; x < GW; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue;
      const k = (yy * GW + xx) * 3;
      r += half[k]; g += half[k + 1]; b += half[k + 2]; n++;
    }
    const k = (y * GW + x) * 3;
    smooth[k] = r / n; smooth[k + 1] = g / n; smooth[k + 2] = b / n;
  }
}

// ---- K-means palette ------------------------------------------------------------------------------
const K = 24;
const samples = [];
for (let i = 0; i < 60000; i++) {
  const k = Math.floor(rng() * GW * GH) * 3;
  samples.push([smooth[k], smooth[k + 1], smooth[k + 2]]);
}
let centers = [];
for (let i = 0; i < K; i++) centers.push(samples[Math.floor(rng() * samples.length)].slice());
for (let it = 0; it < 20; it++) {
  const acc = centers.map(() => [0, 0, 0, 0]);
  for (const s of samples) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < K; c++) {
      const d = (s[0] - centers[c][0]) ** 2 + (s[1] - centers[c][1]) ** 2 + (s[2] - centers[c][2]) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    const a = acc[best]; a[0] += s[0]; a[1] += s[1]; a[2] += s[2]; a[3]++;
  }
  centers = centers.map((c, i) => acc[i][3] ? [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] : samples[Math.floor(rng() * samples.length)].slice());
}
centers.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
const gidx = new Uint8Array(GW * GH);
for (let p = 0; p < GW * GH; p++) {
  const k = p * 3;
  let best = 0, bd = Infinity;
  for (let c = 0; c < K; c++) {
    const d = (smooth[k] - centers[c][0]) ** 2 + (smooth[k + 1] - centers[c][1]) ** 2 + (smooth[k + 2] - centers[c][2]) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  gidx[p] = best;
}
// 3x3 majority filter: cleaner pixel-art regions, fewer isolated specks.
{
  const src = gidx.slice();
  const hist = new Uint16Array(K);
  for (let y = 1; y < GH - 1; y++) for (let x = 1; x < GW - 1; x++) {
    hist.fill(0);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) hist[src[(y + dy) * GW + x + dx]]++;
    let best = src[y * GW + x];
    for (let c = 0; c < K; c++) if (hist[c] > hist[best]) best = c;
    gidx[y * GW + x] = best;
  }
}
const counts = new Array(K).fill(0);
for (const v of gidx) counts[v]++;
console.log('palette:');
centers.forEach((c, i) => console.log(i, c.map(Math.round).join(','), (100 * counts[i] / gidx.length).toFixed(1) + '%'));

if (preview) {
  const pv = Buffer.alloc(GW * GH * 3);
  for (let p = 0; p < GW * GH; p++) { const c = centers[gidx[p]]; pv[p * 3] = c[0]; pv[p * 3 + 1] = c[1]; pv[p * 3 + 2] = c[2]; }
  savePreview('ground_quant.png', GW, GH, pv);
  // palette swatch strip
  const sw = Buffer.alloc(K * 40 * 40 * 3);
  for (let y = 0; y < 40; y++) for (let x = 0; x < K * 40; x++) { const c = centers[Math.floor(x / 40)]; const k = (y * K * 40 + x) * 3; sw[k] = c[0]; sw[k + 1] = c[1]; sw[k + 2] = c[2]; }
  savePreview('palette.png', K * 40, 40, sw);
}

// ---- Roads mask (OSM) so photo roads/cars are never mistaken for roofs -----------------------
const roadMask = new Uint8Array(W * H);
const ROAD_R = { hwy: 16, main: 16, res: 12, svc: 6, track: 4, path: 2 };
for (const rd of MAP.roads) {
  const r = ROAD_R[rd.c], r2 = r * r, p = rd.p;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay, l2 = dx * dx + dy * dy;
    for (let y = Math.max(0, Math.floor(Math.min(ay, ay + dy) - r)); y <= Math.min(H - 1, Math.ceil(Math.max(ay, ay + dy) + r)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, ax + dx) - r)); x <= Math.min(W - 1, Math.ceil(Math.max(ax, ax + dx) + r)); x++) {
        let t = l2 ? ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = x + 0.5 - ax - t * dx, ey = y + 0.5 - ay - t * dy;
        if (ex * ex + ey * ey <= r2) roadMask[y * W + x] = 1;
      }
    }
  }
}
function pointInPoly(x, y, p) {
  let inside = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const osmBldMask = new Uint8Array(W * H);
for (const b of MAP.buildings) {
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < b.p.length; i += 2) { x0 = Math.min(x0, b.p[i]); x1 = Math.max(x1, b.p[i]); y0 = Math.min(y0, b.p[i + 1]); y1 = Math.max(y1, b.p[i + 1]); }
  for (let y = Math.max(0, Math.floor(y0) - 4); y <= Math.min(H - 1, Math.ceil(y1) + 4); y++)
    for (let x = Math.max(0, Math.floor(x0) - 4); x <= Math.min(W - 1, Math.ceil(x1) + 4); x++)
      if (pointInPoly(x + 0.5, y + 0.5, b.p)) osmBldMask[y * W + x] = 1;
}

// ---- Rooftop detection ----------------------------------------------------------------------------
// 3x3-smoothed full-res colour and luminance.
const sm = new Float32Array(W * H * 3);
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  let r = 0, g = 0, b = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = ((y + dy) * W + x + dx) * 3; r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  const k = (y * W + x) * 3; sm[k] = r / 9; sm[k + 1] = g / 9; sm[k + 2] = b / 9;
}
const lumAt = (p) => (sm[p * 3] + sm[p * 3 + 1] + sm[p * 3 + 2]) / 3;
const isVeg = (p) => sm[p * 3 + 1] > sm[p * 3] + 4 && sm[p * 3 + 1] > sm[p * 3 + 2];

function morph(src, erode) {
  const out = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    const n = src[p - 1] + src[p + 1] + src[p - W] + src[p + W] + src[p];
    out[p] = erode ? (n === 5 ? 1 : 0) : (n > 0 ? 1 : 0);
  }
  return out;
}

const houses = [];
const taken = new Uint8Array(W * H); // pixels covered by an accepted house (+margin)
const label = new Int32Array(W * H);
let nextLabel = 1;

function markTaken(h, margin) {
  const ux = Math.cos(h.a), uy = Math.sin(h.a);
  const R = Math.ceil(Math.hypot(h.w, h.d) / 2 + margin);
  for (let y = Math.max(0, Math.floor(h.y - R)); y <= Math.min(H - 1, Math.ceil(h.y + R)); y++)
    for (let x = Math.max(0, Math.floor(h.x - R)); x <= Math.min(W - 1, Math.ceil(h.x + R)); x++) {
      const dx = x + 0.5 - h.x, dy = y + 0.5 - h.y;
      if (Math.abs(dx * ux + dy * uy) <= h.w / 2 + margin && Math.abs(-dx * uy + dy * ux) <= h.d / 2 + margin) taken[y * W + x] = 1;
    }
}

// Mean luminance just outside the rectangle (to require contrast with the yard).
function ringLum(h, off) {
  const ux = Math.cos(h.a), uy = Math.sin(h.a), nx = -uy, ny = ux;
  let s = 0, n = 0;
  const hw = h.w / 2 + off, hd = h.d / 2 + off;
  for (let t = -1; t <= 1; t += 0.1) {
    for (const [cu, cv] of [[t * hw, -hd], [t * hw, hd], [-hw, t * hd], [hw, t * hd]]) {
      const x = Math.round(h.x + ux * cu + nx * cv), y = Math.round(h.y + uy * cu + ny * cv);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      s += lumAt(y * W + x); n++;
    }
  }
  return n ? s / n : 0;
}

// Fraction of the outline with a sharp step between just-inside and just-outside.
function edgeScore(h) {
  const ux = Math.cos(h.a), uy = Math.sin(h.a), nx = -uy, ny = ux;
  let good = 0, n = 0;
  const at = (cu, cv) => {
    const x = Math.round(h.x + ux * cu + nx * cv), y = Math.round(h.y + uy * cu + ny * cv);
    return x < 1 || y < 1 || x >= W - 1 || y >= H - 1 ? null : lumAt(y * W + x);
  };
  for (let t = -0.85; t <= 0.85; t += 0.1) {
    for (const [iu, iv, ou, ov] of [
      [t * (h.w / 2), -(h.d / 2 - 2), t * (h.w / 2), -(h.d / 2 + 2.5)],
      [t * (h.w / 2), h.d / 2 - 2, t * (h.w / 2), h.d / 2 + 2.5],
      [-(h.w / 2 - 2), t * (h.d / 2), -(h.w / 2 + 2.5), t * (h.d / 2)],
      [h.w / 2 - 2, t * (h.d / 2), h.w / 2 + 2.5, t * (h.d / 2)],
    ]) {
      const a = at(iu, iv), b = at(ou, ov);
      if (a === null || b === null) continue;
      n++;
      if (Math.abs(a - b) > 14) good++;
    }
  }
  return n ? good / n : 0;
}

function detect(cand, opt) {
  const mask = morph(morph(cand, true), false);
  const stack = [];
  let found = 0;
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || label[start]) continue;
    const id = nextLabel++;
    const px = [];
    stack.push(start); label[start] = id;
    while (stack.length) {
      const p = stack.pop();
      px.push(p);
      for (const q of [p - 1, p + 1, p - W, p + W]) if (mask[q] && !label[q]) { label[q] = id; stack.push(q); }
    }
    const n = px.length;
    if (n < opt.minN || n > opt.maxN) continue;
    let mx = 0, my = 0;
    for (const p of px) { mx += p % W; my += Math.floor(p / W); }
    mx /= n; my /= n;
    // Minimum-area rectangle over 5-degree steps; prefer the street grid (0 deg).
    let best = null;
    for (let deg = 0; deg < 90; deg += 5) {
      const a = (deg * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
      const us = new Float32Array(n), vs = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = px[i] % W - mx, y = Math.floor(px[i] / W) - my;
        us[i] = x * ux + y * uy; vs[i] = -x * uy + y * ux;
      }
      us.sort(); vs.sort();
      const q = (arr, f) => arr[Math.round(f * (n - 1))];
      const u0 = q(us, 0.02), u1 = q(us, 0.98), v0 = q(vs, 0.02), v1 = q(vs, 0.98);
      const area = (u1 - u0 + 1) * (v1 - v0 + 1);
      const cand2 = { a, u0, u1, v0, v1, area };
      if (!best || area < best.area) best = cand2;
      if (deg === 0) var grid = cand2;
    }
    if (grid.area <= best.area * 1.12) best = grid;
    const { a, u0, u1, v0, v1 } = best;
    const w = u1 - u0 + 2, d = v1 - v0 + 2;
    const fill = n / ((u1 - u0 + 1) * (v1 - v0 + 1));
    if (Math.min(w, d) < opt.minSide || fill < opt.minFill || Math.max(w, d) / Math.min(w, d) > opt.maxAspect) continue;
    const ux = Math.cos(a), uy = Math.sin(a);
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    let r = 0, g = 0, b = 0;
    for (const p of px) { r += raw[p * 3]; g += raw[p * 3 + 1]; b += raw[p * 3 + 2]; }
    const h = {
      x: +(mx + cu * ux - cv * uy).toFixed(1), y: +(my + cu * uy + cv * ux).toFixed(1),
      w: Math.round(w), d: Math.round(d), a: +a.toFixed(4),
      c: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
    };
    // Reject anything overlapping a road, an OSM building, or an already-found house.
    let clash = false;
    const R = Math.ceil(Math.hypot(h.w, h.d) / 2);
    for (let y = Math.max(0, Math.floor(h.y - R)); y <= Math.min(H - 1, Math.ceil(h.y + R)) && !clash; y++)
      for (let x = Math.max(0, Math.floor(h.x - R)); x <= Math.min(W - 1, Math.ceil(h.x + R)); x++) {
        const dx = x + 0.5 - h.x, dy = y + 0.5 - h.y;
        if (Math.abs(dx * ux + dy * uy) > h.w / 2 || Math.abs(-dx * uy + dy * ux) > h.d / 2) continue;
        const p = y * W + x;
        if (roadMask[p] || osmBldMask[p] || taken[p]) { clash = true; break; }
      }
    if (clash) continue;
    if (opt.minContrast) {
      const inner = (h.c[0] + h.c[1] + h.c[2]) / 3;
      if (Math.abs(inner - ringLum(h, 3)) < opt.minContrast) continue;
      if (edgeScore(h) < opt.minEdge) continue;
    }
    houses.push(h);
    markTaken(h, 2);
    found++;
  }
  return found;
}

// Pass 1: clearly roof-coloured (light metal, red/maroon, blue/teal).
const cand1 = new Uint8Array(W * H);
for (let p = W; p < W * (H - 1); p++) {
  if (roadMask[p] || osmBldMask[p] || isVeg(p)) continue;
  const r = sm[p * 3], g = sm[p * 3 + 1], b = sm[p * 3 + 2], lum = (r + g + b) / 3;
  if (lum > 168 || (r > g + 28 && r > 105) || (b > r + 18 && b > 105) || (b > r + 10 && g > r + 10 && lum > 95 && b > g - 10)) cand1[p] = 1;
}
const n1 = detect(cand1, { minN: 70, maxN: 5000, minSide: 7, minFill: 0.6, maxAspect: 4.5, minContrast: 0 });

// Pass 2: muted tan/brown/grey roofs. Stricter: solid rectangles that stand out from the yard.
const cand2 = new Uint8Array(W * H);
for (let p = W; p < W * (H - 1); p++) {
  if (roadMask[p] || osmBldMask[p] || taken[p] || isVeg(p) || cand1[p]) continue;
  const lum = lumAt(p);
  if (lum >= 92 && lum <= 168) cand2[p] = 1;
}
label.fill(0);
const n2 = detect(cand2, { minN: 140, maxN: 8000, minSide: 9, minFill: 0.76, maxAspect: 3, minContrast: 16, minEdge: 0.6 });
console.log('houses detected:', houses.length, `(pass1 ${n1}, pass2 ${n2})`);

// ---- 704 5th Ave --------------------------------------------------------------------------------
// The long white house south of 5th Ave between Oregon St and Division St (see build-map.mjs).
const HOME_GUESS = { x: 2081, y: 985 };
let home = null;
for (const h of houses) if (!home || Math.hypot(h.x - HOME_GUESS.x, h.y - HOME_GUESS.y) < Math.hypot(home.x - HOME_GUESS.x, home.y - HOME_GUESS.y)) home = h;
if (!home || Math.hypot(home.x - HOME_GUESS.x, home.y - HOME_GUESS.y) > 25) throw new Error('home house not detected');
home.home = 1;
console.log('home house', JSON.stringify(home));

// ---- Stylised palettes ------------------------------------------------------------------------------
function stylise([r, g, b], sat, gain) {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  return [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round((l + (c - l) * sat) * gain))));
}
function groundClass([r, g, b]) {
  const lum = (r + g + b) / 3, exg = g - (r + b) / 2;
  if (lum < 72 && g >= r - 2) return 'forest';
  if (exg >= 18) return 'lawn';
  if (exg >= 6) return 'field';
  if (r - b > 22 && lum < 150) return 'dirt';
  return 'gravel';
}
const groundPal = centers.map((c) => stylise(c, 1.45, 1.12));
const groundCls = centers.map(groundClass);

// Roof colours: k-means into 16 shades, then stylise.
const RK = 16;
let rc = [];
for (let i = 0; i < RK; i++) rc.push(houses[Math.floor((i + 0.5) * houses.length / RK)].c.slice());
for (let it = 0; it < 20; it++) {
  const acc = rc.map(() => [0, 0, 0, 0]);
  for (const h of houses) {
    let best = 0, bd = Infinity;
    rc.forEach((c, i) => { const d = (h.c[0] - c[0]) ** 2 + (h.c[1] - c[1]) ** 2 + (h.c[2] - c[2]) ** 2; if (d < bd) { bd = d; best = i; } });
    h.v = best;
    const a = acc[best]; a[0] += h.c[0]; a[1] += h.c[1]; a[2] += h.c[2]; a[3]++;
  }
  rc = rc.map((c, i) => acc[i][3] ? acc[i].slice(0, 3).map((v) => v / acc[i][3]) : c);
}
const roofPal = rc.map((c) => stylise(c, 1.5, 1.05));
// The player's house keeps its exact photo colour so it is recognisable.
roofPal.push(stylise(home.c, 1.5, 1.05));
home.v = roofPal.length - 1;

// ---- Write src/satdata.js ------------------------------------------------------------------------------
const gray = Buffer.alloc(GW * GH);
for (let p = 0; p < GW * GH; p++) gray[p] = gidx[p] * 10; // x10: robust to any decoder rounding
const png = execFileSync('magick', ['-size', `${GW}x${GH}`, '-depth', '8', 'gray:-', '-strip', '-define', 'png:color-type=0', '-define', 'png:compression-level=9', 'png:-'], { input: gray, maxBuffer: 1 << 28 });
const out = {
  attribution: 'Imagery: USGS The National Map, NAIP Plus (public domain)',
  gw: GW, gh: GH, groundPal, groundCls, roofPal,
  houses: houses.map((h) => [h.x, h.y, h.w, h.d, h.a, h.v, h.home ? 1 : 0]),
  ground: 'data:image/png;base64,' + png.toString('base64'),
};
const js = '// GENERATED by tools/build-sat.mjs from USGS NAIP imagery (public domain). Do not edit by hand.\n' +
  'window.SATDATA = ' + JSON.stringify(out) + ';\n';
writeFileSync(join(here, '..', 'src', 'satdata.js'), js);
console.log(`wrote src/satdata.js ${(js.length / 1024).toFixed(0)} KB (ground png ${(png.length / 1024).toFixed(0)} KB)`);
console.log('ground classes:', groundCls.map((c, i) => i + ':' + c).join(' '));

if (preview) {
  let mvg = '';
  for (const h of houses) {
    const ux = Math.cos(h.a), uy = Math.sin(h.a), nx = -uy, ny = ux;
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => `${(h.x + ux * su * h.w / 2 + nx * sv * h.d / 2).toFixed(1)},${(h.y + uy * su * h.w / 2 + ny * sv * h.d / 2).toFixed(1)}`);
    mvg += `polygon ${c.join(' ')}\n`;
  }
  writeFileSync(join(preview, 'houses.mvg'), mvg);
  execFileSync('magick', [join(here, 'imagery', 'deary-naip.png'), '-fill', 'none', '-stroke', '#00ffff', '-strokewidth', '1.5', '-draw', '@' + join(preview, 'houses.mvg'), join(preview, 'houses_overlay.png')]);
}
