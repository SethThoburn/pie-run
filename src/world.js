'use strict';
// Builds the playable town of Deary, Idaho into a per-pixel terrain map and
// renders it lazily in cached chunks.
//   - Streets, the Pie Safe and other mapped buildings: OpenStreetMap (MAPDATA)
//   - Ground colours, tree cover and rooftops: USGS NAIP aerial photo (SATDATA),
//     pre-processed into a pixel-art palette by tools/build-sat.mjs
//
// Everything random uses a fixed seed so every player gets exactly the same town
// (required for fair high-score comparisons).

const T = {
  GRASS: 0, LAWN: 1, FIELD: 2, SCRUB: 3, FOREST: 4, GRAVEL: 5, DIRT: 6, ASPHALT: 7,
  LINE_Y: 8, LINE_W: 9, SIDEWALK: 10, WATER: 11, RAIL: 15,
  ROOF_FLAT: 16, ROOF_PIE: 17, ROOF: 20, // gabled roofs: ROOF + variant*3 + (0 lit | 1 shade | 2 ridge)
};
const F_SOLID = 1, F_SHADOW = 2, F_OCC = 4, F_SAT = 8;
const CHUNK = 128;

// Base colours, per-pixel noise amount, and speed factor per terrain type.
// Roof variants come from the photo's roof colours, so the table is built per world.
function makeTypeInfo(roofColors) {
  const info = [];
  const set = (t, rgb, amp, speed) => { info[t] = { rgb, amp, speed }; };
  set(T.GRASS, [84, 136, 60], 0.10, 0.58);
  set(T.LAWN, [102, 160, 70], 0.08, 0.62);
  set(T.FIELD, [214, 180, 98], 0.07, 0.52);
  set(T.SCRUB, [116, 134, 70], 0.12, 0.50);
  set(T.FOREST, [56, 94, 50], 0.12, 0.45);
  set(T.GRAVEL, [160, 150, 130], 0.12, 0.86);
  set(T.DIRT, [148, 114, 76], 0.10, 0.80);
  set(T.ASPHALT, [74, 76, 84], 0.05, 1.00);
  set(T.LINE_Y, [234, 196, 60], 0.04, 1.00);
  set(T.LINE_W, [232, 232, 226], 0.03, 1.00);
  set(T.SIDEWALK, [186, 182, 172], 0.04, 0.95);
  set(T.WATER, [62, 122, 190], 0.04, 0.30);
  set(T.RAIL, [118, 102, 86], 0.14, 0.78);
  set(T.ROOF_FLAT, [146, 150, 156], 0.05, 0);
  set(T.ROOF_PIE, [238, 222, 182], 0.03, 0);
  roofColors.forEach((lit, v) => {
    set(T.ROOF + v * 3, lit, 0.05, 0);
    set(T.ROOF + v * 3 + 1, lit.map((c) => Math.round(c * 0.76)), 0.05, 0);
    set(T.ROOF + v * 3 + 2, lit.map((c) => Math.min(255, Math.round(c * 1.16 + 8))), 0.03, 0);
  });
  return info;
}
// Fixed roof variants for OSM buildings without a photo colour.
const OSM_ROOFS = [[190, 72, 60], [112, 122, 140], [150, 108, 76], [84, 132, 96], [168, 92, 52], [198, 172, 128]];

const isRoof = (t) => t >= T.ROOF_FLAT;
const isRoad = (t) => t === T.ASPHALT || t === T.LINE_Y || t === T.LINE_W;
const isNatural = (t) => t === T.GRASS || t === T.LAWN || t === T.SCRUB || t === T.FOREST || t === T.FIELD;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function streetLabel(name) {
  return name.toUpperCase()
    .replace(/^STATE HIGHWAY /, 'HWY ')
    .replace(/^HIGHWAY /, 'HWY ')
    .replace(/^SOUTH /, 'S ')
    .replace(/^WEST /, 'W ')
    .replace(/ AVENUE$/, ' AVE')
    .replace(/ STREET$/, ' ST')
    .replace(/ ROAD$/, ' RD');
}

// Decodes SATDATA's ground PNG into palette indices. Resolves to {gidx, gw, gh}.
function loadSatGround(SAT) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.width !== SAT.gw || img.height !== SAT.gh) return reject(new Error('ground image size mismatch'));
      const c = document.createElement('canvas');
      c.width = SAT.gw; c.height = SAT.gh;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, SAT.gw, SAT.gh).data;
      const gidx = new Uint8Array(SAT.gw * SAT.gh);
      const n = SAT.groundPal.length;
      for (let i = 0; i < gidx.length; i++) gidx[i] = Math.min(n - 1, Math.round(d[i * 4] / 10));
      resolve({ gidx, gw: SAT.gw, gh: SAT.gh });
    };
    img.onerror = () => reject(new Error('ground image failed to decode'));
    img.src = SAT.ground;
  });
}

function buildWorld(MAP, SAT, ground) {
  const W = MAP.w, H = MAP.h;
  const GW = ground.gw, gidx = ground.gidx;
  const type = new Uint8Array(W * H);
  const flags = new Uint8Array(W * H);
  const rng = mulberry32(704);
  const OSM_V0 = SAT.roofPal.length; // OSM roof variants come after the photo ones
  const TYPE_INFO = makeTypeInfo(SAT.roofPal.concat(OSM_ROOFS));
  const put = (i, t) => { type[i] = t; flags[i] &= ~F_SAT; };

  // ---- Raster primitives ----------------------------------------------------
  // Even-odd scanline fill; calls cb(index, x, y) for each pixel centre inside.
  function fillPoly(p, cb) {
    const n = p.length / 2;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { y0 = Math.min(y0, p[i * 2 + 1]); y1 = Math.max(y1, p[i * 2 + 1]); }
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H - 1, Math.ceil(y1));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = p[j * 2], ay = p[j * 2 + 1], bx = p[i * 2], by = p[i * 2 + 1];
        if ((ay > sy) !== (by > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        const xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) cb(y * W + x, x, y);
      }
    }
  }

  // Thick polyline; cb(index, x, y, s) where s is arc length along the line.
  function thickLine(p, r, cb) {
    let s0 = 0;
    const r2 = r * r;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const len = Math.sqrt(len2);
      const xa = Math.max(0, Math.floor(Math.min(ax, bx) - r)), xb = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r));
      const ya = Math.max(0, Math.floor(Math.min(ay, by) - r)), yb = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r));
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const px = x + 0.5 - ax, py = y + 0.5 - ay;
          let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - t * dx, ey = py - t * dy;
          if (ex * ex + ey * ey <= r2) cb(y * W + x, x, y, s0 + t * len);
        }
      }
      s0 += len;
    }
  }
  const setType = (t) => (i) => put(i, t);

  // ---- Ground from the aerial photo --------------------------------------------
  const CLASS_TYPE = { forest: T.FOREST, lawn: T.LAWN, field: T.FIELD, dirt: T.DIRT, gravel: T.GRAVEL };
  const gclsType = SAT.groundCls.map((c) => CLASS_TYPE[c]);
  for (let y = 0; y < H; y++) {
    const row = (y >> 1) * GW;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      type[i] = gclsType[gidx[row + (x >> 1)]];
      flags[i] = F_SAT;
    }
  }
  // Mapped water and parking lots.
  for (const a of MAP.areas) {
    if (a.k === 'water') fillPoly(a.p, setType(T.WATER));
    else if (a.k === 'parking') fillPoly(a.p, (i, x) => put(i, x % 8 === 0 ? T.LINE_W : T.ASPHALT));
  }

  // ---- Rail grade and roads ---------------------------------------------------
  for (const p of MAP.rails) thickLine(p, 3.5, setType(T.RAIL));

  // half-widths in px (0.5 m/px): [outer edge type, outer r, paved r]
  const ROAD_STYLE = {
    path: [T.DIRT, 1.6, 0],
    track: [T.DIRT, 3.2, 0],
    svc: [T.GRAVEL, 4.6, 0],
    res: [T.GRAVEL, 11, 9],
    main: [T.SIDEWALK, 15, 11],
    hwy: [T.GRAVEL, 15, 13],
  };
  for (const rd of MAP.roads) {
    const [edge, r] = ROAD_STYLE[rd.c];
    const minor = rd.c === 'path' || rd.c === 'track' || rd.c === 'svc';
    thickLine(rd.p, r, (i) => {
      if (isRoad(type[i]) || type[i] === T.SIDEWALK) return;
      if (minor && type[i] === T.GRAVEL && !(flags[i] & F_SAT)) return;
      put(i, edge);
    });
  }
  for (const rd of MAP.roads) {
    const r = ROAD_STYLE[rd.c][2];
    if (r > 0) thickLine(rd.p, r, setType(T.ASPHALT));
  }
  for (const rd of MAP.roads) {
    if (rd.c !== 'hwy') continue;
    let total = 0;
    for (let i = 0; i + 3 < rd.p.length; i += 2) total += Math.hypot(rd.p[i + 2] - rd.p[i], rd.p[i + 3] - rd.p[i + 1]);
    thickLine(rd.p, 0.9, (i, x, y, s) => {
      if (s > 24 && s < total - 24 && s % 16 < 8 && type[i] === T.ASPHALT) put(i, T.LINE_Y);
    });
  }

  // ---- Buildings ----------------------------------------------------------------
  // Gabled roof split along the ridge (long axis), or a flat roof type.
  function paintRoof(p, variant, flat, ridgeAngle) {
    let cx = 0, cy = 0;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) { cx += p[i * 2]; cy += p[i * 2 + 1]; }
    cx /= n; cy /= n;
    let ang = ridgeAngle;
    if (ang === undefined) {
      let sxx = 0, syy = 0, sxy = 0;
      for (let i = 0; i < n; i++) {
        const dx = p[i * 2] - cx, dy = p[i * 2 + 1] - cy;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      }
      ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    }
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    const sunSide = Math.sign(-nx - ny) || 1;
    fillPoly(p, (i, x, y) => {
      flags[i] |= F_SOLID | F_OCC;
      if (flat !== false) { put(i, flat); return; }
      const a = (x + 0.5 - cx) * nx + (y + 0.5 - cy) * ny;
      const base = T.ROOF + variant * 3;
      put(i, Math.abs(a) < 0.75 ? base + 2 : Math.sign(a) === sunSide ? base : base + 1);
    });
  }

  const decals = [];
  let pieBuilding = null;
  MAP.buildings.forEach((b, idx) => {
    let area = 0;
    for (let i = 0, n = b.p.length / 2; i < n; i++) {
      const j = (i + 1) % n;
      area += b.p[i * 2] * b.p[j * 2 + 1] - b.p[j * 2] * b.p[i * 2 + 1];
    }
    area = Math.abs(area / 2);
    if (b.pie) {
      paintRoof(b.p, 0, T.ROOF_PIE);
      pieBuilding = b;
      return;
    }
    const big = area > 900 || ['commercial', 'retail', 'school', 'government_office', 'industrial'].includes(b.k);
    paintRoof(b.p, OSM_V0 + (idx % OSM_ROOFS.length), big ? T.ROOF_FLAT : false);
    if (b.n && big) {
      const label = b.n.toUpperCase().replace(/^DEARY /, '').replace(/ COMMUNITY SERVICES.*/, '');
      const bb = polyBBox(b.p);
      if (measureText(label) + 4 < bb[2] - bb[0] && bb[3] - bb[1] > 11) {
        decals.push(textDecal(label, (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, '#3a3d44', null));
      }
    }
  });
  if (!pieBuilding) throw new Error('No Pie Safe building in map data');

  // Rooftops detected in the aerial photo: [x, y, w, d, angle, variant, isHome].
  let homeHouse = null;
  for (const [x, y, w, d, a, v, isHome] of SAT.houses) {
    const ux = Math.cos(a), uy = Math.sin(a);
    const ridge = w >= d ? a : a + Math.PI / 2;
    paintRoof(rectPoly(x, y, w, d, ux, uy), v, false, ridge);
    if (isHome) homeHouse = { x, y, w, d, a };
  }
  if (!homeHouse) throw new Error('No home house in satellite data');

  // ---- Key places ---------------------------------------------------------------
  const pb = polyBBox(pieBuilding.p);
  decals.push(textDecal('PIE', (pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2 - 5, '#c0303c', null));
  decals.push(textDecal('SAFE', (pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2 + 5, '#c0303c', null));
  // The Pie Safe fronts Main Street, just east of the building.
  const pieZone = { x: pb[2] + 10, y: (pb[1] + pb[3]) / 2, r: 16 };

  // 704 5th Ave: the real house, with a driveway north to 5th Avenue.
  const streetY = MAP.home.y;              // 5th Ave centreline in front of the house
  const houseTop = homeHouse.y - homeHouse.d / 2;
  const driveX = Math.round(homeHouse.x);
  thickLine([driveX, houseTop, driveX, streetY + 8], 4, (i) => {
    if (!isRoad(type[i]) && !isRoof(type[i])) { put(i, T.GRAVEL); flags[i] |= F_OCC; }
  });
  const mailbox = textDecal('704', driveX - 17, streetY + 18, '#ffffff', '#1d4f8a');
  decals.push(mailbox);
  reserve(mailbox.x - 2, mailbox.y - 2, mailbox.w + 4, mailbox.h + 4);
  decals.push(homeDecal(driveX, houseTop - 1));
  const homeZone = { x: driveX, y: streetY + 22, r: 15 };
  const start = { x: driveX, y: houseTop - 9, a: 0 };

  // ---- Street name signs ------------------------------------------------------------
  const placedLabels = [];
  const signOk = (t, f) => (isNatural(t) || t === T.DIRT || ((f & F_SAT) && t === T.GRAVEL)) && !(f & F_OCC);
  for (const rd of MAP.roads) {
    if (!rd.n || rd.c === 'svc' || rd.c === 'path' || rd.c === 'track') continue;
    const text = streetLabel(rd.n);
    const half = ROAD_STYLE[rd.c][1];
    for (let i = 0; i + 3 < rd.p.length; i += 2) {
      const ax = rd.p[i], ay = rd.p[i + 1], bx = rd.p[i + 2], by = rd.p[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 90) continue;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (mx < 20 || my < 20 || mx > W - 20 || my > H - 20) continue;
      if (placedLabels.some((l) => l.text === text && Math.hypot(l.x - mx, l.y - my) < 450)) continue;
      const nx = -(by - ay) / len, ny = (bx - ax) / len;
      const tw = measureText(text) + 4, th = 11;
      for (const side of [1, -1]) {
        const off = half + 3 + (Math.abs(nx) * tw + Math.abs(ny) * th) / 2;
        const sx = mx + nx * off * side, sy = my + ny * off * side;
        const x0 = Math.round(sx - tw / 2), y0 = Math.round(sy - th / 2);
        if (!areaIs(x0 - 1, y0 - 1, tw + 2, th + 2, signOk)) continue;
        decals.push(textDecal(text, sx, sy, '#ffffff', '#1f6b3a'));
        reserve(x0 - 1, y0 - 1, tw + 2, th + 2);
        placedLabels.push({ text, x: mx, y: my });
        break;
      }
    }
  }

  // ---- Trees, wherever the photo shows tree canopy ------------------------------------
  const trees = [];
  function clearFor(x, y, r) {
    if (x - r < 0 || y - r < 0 || x + r >= W || y + r >= H) return false;
    for (let yy = y - r; yy <= y + r; yy++) {
      for (let xx = x - r; xx <= x + r; xx++) {
        const i = yy * W + xx;
        const t = type[i];
        if (flags[i] & F_OCC) return false;
        if (!isNatural(t) && !((flags[i] & F_SAT) && (t === T.DIRT || t === T.GRAVEL))) return false;
      }
    }
    return true;
  }
  function plant(x, y, kind) {
    const list = ART.trees[kind];
    const t = list[Math.floor(rng() * list.length)];
    trees.push({ x, y, t });
    for (let yy = y - 6; yy <= y + 6; yy++) {
      for (let xx = x - 6; xx <= x + 6; xx++) {
        const dd = (xx - x) * (xx - x) + (yy - y) * (yy - y);
        const i = yy * W + xx;
        if (dd <= 30) flags[i] |= F_OCC;
        if (dd <= 6) flags[i] |= F_SOLID; // trunk
      }
    }
  }
  for (let y = 6; y < H - 6; y += 8) {
    for (let x = 6; x < W - 6; x += 8) {
      const tx = Math.round(x + (rng() - 0.5) * 6), ty = Math.round(y + (rng() - 0.5) * 6);
      const kindRoll = rng();
      if (tx < 8 || ty < 8 || tx >= W - 8 || ty >= H - 8) continue;
      if (type[ty * W + tx] !== T.FOREST) continue;
      if (clearFor(tx, ty, 4)) plant(tx, ty, kindRoll < 0.78 ? 'pine' : 'round');
    }
  }

  // ---- Shadows (sun from the top-left) -------------------------------------------------
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      if (!isRoof(type[y * W + x])) continue;
      for (let k = 1; k <= 3; k++) {
        const sx = x + k, sy = y + k;
        if (sx >= W || sy >= H) break;
        const j = sy * W + sx;
        if (!isRoof(type[j])) flags[j] |= F_SHADOW;
      }
    }
  }

  // ---- Spatial buckets for chunk rendering ---------------------------------------------------
  const CW = Math.ceil(W / CHUNK), CHH = Math.ceil(H / CHUNK);
  const treeBuckets = Array.from({ length: CW * CHH }, () => []);
  const decalBuckets = Array.from({ length: CW * CHH }, () => []);
  const bucketAdd = (buckets, item, x0, y0, x1, y1) => {
    for (let cy = Math.max(0, Math.floor(y0 / CHUNK)); cy <= Math.min(CHH - 1, Math.floor(y1 / CHUNK)); cy++) {
      for (let cx = Math.max(0, Math.floor(x0 / CHUNK)); cx <= Math.min(CW - 1, Math.floor(x1 / CHUNK)); cx++) {
        buckets[cy * CW + cx].push(item);
      }
    }
  };
  trees.sort((a, b) => a.y - b.y);
  for (const t of trees) bucketAdd(treeBuckets, t, t.x - t.t.r, t.y - t.t.r, t.x + t.t.r + 3, t.y + t.t.r + 3);
  for (const d of decals) bucketAdd(decalBuckets, d, d.x, d.y, d.x + d.w, d.y + d.h);

  // ---- Helpers that need the maps --------------------------------------------------------
  function reserve(x, y, w, h) {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) flags[yy * W + xx] |= F_OCC;
    }
  }
  function areaIs(x, y, w, h, pred) {
    if (x < 0 || y < 0 || x + w > W || y + h > H) return false;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = yy * W + xx;
        if (!pred(type[i], flags[i])) return false;
      }
    }
    return true;
  }

  // ---- Chunk renderer ---------------------------------------------------------------------
  const cache = new Map();
  const MAX_CACHE = 96;
  const SAT_AMP = { [T.FOREST]: 0.12, [T.LAWN]: 0.08, [T.FIELD]: 0.07, [T.DIRT]: 0.09, [T.GRAVEL]: 0.09 };

  function pixelColor(x, y, out) {
    const i = y * W + x;
    const t = type[i];
    const h = hash2(x, y);
    const h2 = (h >>> 8) & 63;
    let rgb, f;
    if (flags[i] & F_SAT) {
      rgb = SAT.groundPal[gidx[(y >> 1) * GW + (x >> 1)]];
      f = 1 + ((h & 255) / 255 - 0.5) * 2 * (SAT_AMP[t] || 0.08);
      if (t === T.LAWN || t === T.FIELD) { if (h2 === 0) f *= 1.14; else if (h2 === 1) f *= 0.86; }
      else if (t === T.FOREST && (h2 & 15) === 0) f *= 0.8;
      else if ((t === T.GRAVEL || t === T.DIRT) && (h2 & 7) === 0) f *= 0.86;
    } else {
      const inf = TYPE_INFO[t];
      rgb = inf.rgb;
      f = 1 + ((h & 255) / 255 - 0.5) * 2 * inf.amp;
      switch (t) {
        case T.WATER:
          if (h2 < 2 || ((x * 3 + y * 5) % 23 === 0 && (h2 & 3) === 0)) rgb = [150, 196, 232];
          break;
        case T.GRAVEL:
          if ((h2 & 7) === 0) f *= 0.84;
          break;
        case T.SIDEWALK:
          if ((x & 7) === 0 || (y & 7) === 0) f *= 0.9;
          break;
        case T.ASPHALT:
          if ((h2 & 15) === 0) f *= 1.18;
          break;
      }
      if (isRoad(t)) {
        if ((x > 0 && !isRoad(type[i - 1])) || (x < W - 1 && !isRoad(type[i + 1])) ||
            (y > 0 && !isRoad(type[i - W])) || (y < H - 1 && !isRoad(type[i + W]))) f *= 0.78;
      } else if (isRoof(t)) {
        const edge = (x > 0 && !isRoof(type[i - 1])) || (x < W - 1 && !isRoof(type[i + 1])) ||
          (y > 0 && !isRoof(type[i - W])) || (y < H - 1 && !isRoof(type[i + W]));
        if (edge) {
          if (t === T.ROOF_PIE) { rgb = [176, 44, 52]; f = 1; } else f *= 0.55;
        } else if (t === T.ROOF_FLAT && (h2 & 31) === 0) f *= 0.88;
      }
    }
    if (flags[i] & F_SHADOW) f *= 0.66;
    out[0] = Math.min(255, rgb[0] * f);
    out[1] = Math.min(255, rgb[1] * f);
    out[2] = Math.min(255, rgb[2] * f);
  }

  function renderChunk(cx, cy) {
    const c = document.createElement('canvas');
    c.width = c.height = CHUNK;
    const g = c.getContext('2d');
    const img = g.createImageData(CHUNK, CHUNK);
    const d = img.data;
    const col = [0, 0, 0];
    const ox = cx * CHUNK, oy = cy * CHUNK;
    for (let y = 0; y < CHUNK; y++) {
      for (let x = 0; x < CHUNK; x++) {
        const wx = ox + x, wy = oy + y;
        const k = (y * CHUNK + x) * 4;
        if (wx >= W || wy >= H) { d[k] = 40; d[k + 1] = 70; d[k + 2] = 44; d[k + 3] = 255; continue; }
        pixelColor(wx, wy, col);
        d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const b = cy * CW + cx;
    for (const dcl of decalBuckets[b]) dcl.draw(g, Math.round(dcl.x) - ox, Math.round(dcl.y) - oy);
    const tb = treeBuckets[b];
    g.globalAlpha = 0.32;
    for (const t of tb) g.drawImage(t.t.shadow, t.x - t.t.r - ox + 3, t.y - t.t.r - oy + 3);
    g.globalAlpha = 1;
    for (const t of tb) g.drawImage(t.t.img, t.x - t.t.r - ox, t.y - t.t.r - oy);
    return c;
  }

  function getChunk(cx, cy) {
    const key = cy * CW + cx;
    let c = cache.get(key);
    if (c) {
      cache.delete(key);
      cache.set(key, c);
      return c;
    }
    c = renderChunk(cx, cy);
    cache.set(key, c);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return c;
  }

  // ---- Minimap: averaged real colours, roads on top ------------------------------------------
  const MS = 40;
  const mini = document.createElement('canvas');
  mini.width = Math.ceil(W / MS); mini.height = Math.ceil(H / MS);
  {
    const g = mini.getContext('2d');
    const img = g.createImageData(mini.width, mini.height);
    const col = [0, 0, 0];
    for (let my = 0; my < mini.height; my++) {
      for (let mx = 0; mx < mini.width; mx++) {
        let road = 0, n = 0, r = 0, gg = 0, b = 0;
        for (let y = my * MS; y < Math.min(H, (my + 1) * MS); y += 2) {
          for (let x = mx * MS; x < Math.min(W, (mx + 1) * MS); x += 2) {
            n++;
            if (isRoad(type[y * W + x])) { road++; continue; }
            pixelColor(x, y, col);
            r += col[0]; gg += col[1]; b += col[2];
          }
        }
        const k = (my * mini.width + mx) * 4;
        if (road > n * 0.04) { img.data[k] = 240; img.data[k + 1] = 236; img.data[k + 2] = 222; }
        else {
          const m = Math.max(1, n - road);
          img.data[k] = r / m * 0.85; img.data[k + 1] = gg / m * 0.85; img.data[k + 2] = b / m * 0.85;
        }
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  // ---- Queries --------------------------------------------------------------------------------
  function solidAt(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return true;
    return (flags[iy * W + ix] & F_SOLID) !== 0;
  }
  function speedAt(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return 0.4;
    return TYPE_INFO[type[iy * W + ix]].speed || 0.4;
  }
  function typeAt(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return T.GRASS;
    return type[iy * W + ix];
  }

  return {
    w: W, h: H, chunk: CHUNK, cols: CW, rows: CHH,
    getChunk, solidAt, speedAt, typeAt,
    pieZone, homeZone, start, mini, miniScale: MS,
    treeCount: trees.length, decalCount: decals.length, houseCount: SAT.houses.length,
  };
}

// ---- Shared geometry helpers ----------------------------------------------------------------------
function polyBBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
  }
  return [x0, y0, x1, y1];
}
// Rectangle centred at (cx, cy): `w` along unit axis (ux, uy), `d` across it.
function rectPoly(cx, cy, w, d, ux, uy) {
  const nx = -uy, ny = ux, hw = w / 2, hd = d / 2;
  return [
    cx - ux * hw - nx * hd, cy - uy * hw - ny * hd,
    cx + ux * hw - nx * hd, cy + uy * hw - ny * hd,
    cx + ux * hw + nx * hd, cy + uy * hw + ny * hd,
    cx - ux * hw + nx * hd, cy - uy * hw + ny * hd,
  ];
}
// Text label centred at (cx, cy); with `bg` it is drawn as a sign plate.
function textDecal(text, cx, cy, color, bg) {
  const tw = measureText(text), w = tw + (bg ? 4 : 0), h = bg ? 11 : 7;
  return {
    x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h,
    draw(g, ox, oy) {
      if (bg) {
        g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(ox + 1, oy + 1, w, h);
        g.fillStyle = bg; g.fillRect(ox, oy, w, h);
        g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(ox, oy, w, 1);
        drawText(g, text, ox + 2, oy + 2, { color });
      } else {
        drawText(g, text, ox, oy, { color });
      }
    },
  };
}
// Welcome mat at the front door of 704 (top edge at y).
function homeDecal(cx, y) {
  return {
    x: Math.round(cx - 5), y: Math.round(y - 4), w: 10, h: 4,
    draw(g, ox, oy) {
      g.fillStyle = '#5a3a22'; g.fillRect(ox, oy, 10, 4);
      g.fillStyle = '#c8a060'; g.fillRect(ox + 1, oy + 1, 8, 2);
    },
  };
}
