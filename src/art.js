'use strict';
// All sprite pixel art, drawn from character grids or generated pixel by pixel.

const SPRITE_PAL = {
  k: [28, 28, 34],     // tyre
  m: [156, 162, 174],  // chrome
  g: [44, 44, 50],     // grip
  r: [214, 52, 52],    // bike red
  R: [250, 116, 96],   // red highlight
  d: [140, 28, 36],    // dark red
  H: [246, 246, 246],  // helmet
  h: [196, 202, 212],  // helmet shade
  j: [44, 116, 190],   // jacket
  J: [26, 74, 130],    // jacket shade
  s: [30, 30, 36],     // seat
  e: [130, 130, 140],  // exhaust
  w: [34, 24, 16],     // dark outline
  y: [255, 214, 64],   // yellow
  Y: [255, 246, 170],  // light yellow
  o: [86, 50, 26],     // pie outline
  C: [226, 172, 92],   // crust
  c: [186, 48, 66],    // cherry
  T: [176, 178, 190],  // tin
  b: [64, 112, 196],   // house roof blue
  B: [40, 80, 150],    // roof shade
  W: [240, 232, 214],  // wall
  n: [110, 70, 40],    // door
};

const BIKE_ART = [
  '................',
  '.......kk.......',
  '.......kk.......',
  '......dRRd......',
  '...gmmmrrmmmg...',
  '...jj.drrd.jj...',
  '....jjhHHhjj....',
  '.....jHrrHj.....',
  '.....jHrrHj.....',
  '....JjhHHhjJ....',
  '....JjjjjjjJ....',
  '.....JjjjjJ.....',
  '......dssd......',
  '.......kk....e..',
  '.......kk....e..',
  '................',
];

const ARROW_ART = [
  '.....w.....',
  '....wYw....',
  '...wyYyw...',
  '..wyyYyyw..',
  '.wyyyyyyyw.',
  'wwwwyyywwww',
  '...wyyyw...',
  '...wyyyw...',
  '...wyyyw...',
  '...wwwww...',
];

const PIE_ART = [
  '..ooooo..',
  '.oCCCCCo.',
  'oCcCcCcCo',
  'oCCCCCCCo',
  'oTTTTTTTo',
  '.oTTTTTo.',
  '..ooooo..',
];

const HOUSE_ART = [
  '....w....',
  '...wbw...',
  '..wbbBw..',
  '.wbbbBBw.',
  'wwwwwwwww',
  '.wWWWWWw.',
  '.wWWnWWw.',
  '.wWWnWWw.',
  '.wwwwwww.',
];

function artToCanvas(rows, pal = SPRITE_PAL) {
  const h = rows.length, w = rows[0].length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const col = pal[rows[y][x]];
      if (!col) continue;
      const i = (y * w + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Nearest-neighbour rotation keeps hard pixel edges. Angle 0 = sprite as drawn
// (pointing up); positive = clockwise. Returns a square canvas centred on the
// sprite centre. If `shadow` is set, returns a flat silhouette of that colour.
function rotateSprite(src, angle, shadow) {
  const sw = src.width, sh = src.height;
  const size = Math.ceil(Math.hypot(sw, sh)) | 1;
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const half = size / 2, scx = sw / 2, scy = sh / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - half, dy = y + 0.5 - half;
      // inverse rotation into source space
      const sx = Math.floor(dx * cos + dy * sin + scx);
      const sy = Math.floor(-dx * sin + dy * cos + scy);
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
      const si = (sy * sw + sx) * 4;
      if (sd[si + 3] === 0) continue;
      const di = (y * size + x) * 4;
      if (shadow) {
        img.data[di] = shadow[0]; img.data[di + 1] = shadow[1]; img.data[di + 2] = shadow[2]; img.data[di + 3] = shadow[3];
      } else {
        img.data[di] = sd[si]; img.data[di + 1] = sd[si + 1]; img.data[di + 2] = sd[si + 2]; img.data[di + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

const ROT_FRAMES = 32;
function makeRotations(src, shadow) {
  const frames = [];
  for (let i = 0; i < ROT_FRAMES; i++) frames.push(rotateSprite(src, (i / ROT_FRAMES) * Math.PI * 2, shadow));
  return frames;
}
function rotFrame(frames, angle) {
  const n = frames.length;
  let i = Math.round((angle / (Math.PI * 2)) * n) % n;
  if (i < 0) i += n;
  return frames[i];
}

// ---- Trees ------------------------------------------------------------------
// Deterministic small hash used for per-pixel variation.
function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function makeTree(kind, r, seed) {
  const size = r * 2 + 1;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const base = kind === 'pine' ? (seed & 1 ? [36, 86, 54] : [44, 94, 50]) : (seed & 1 ? [74, 136, 58] : [88, 140, 52]);
  const mask = new Uint8Array(size * size);
  const phase = (seed % 7) * 0.7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - r, dy = y - r;
      const d = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const lim = kind === 'pine'
        ? r * (0.74 + 0.26 * Math.abs(Math.cos(a * 4 + phase)))
        : r * (0.86 + 0.1 * Math.sin(a * 5 + phase) + 0.06 * Math.sin(a * 9));
      if (d <= lim + 0.25) mask[y * size + x] = 1;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!mask[y * size + x]) continue;
      const dx = x - r, dy = y - r;
      const d = Math.hypot(dx, dy) / r;
      const edge = !mask[y * size + x - 1] || !mask[y * size + x + 1] ||
        !mask[(y - 1) * size + x] || !mask[(y + 1) * size + x] || x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const light = (-dx - dy) / (r * 1.41); // sun from the top-left
      let f = 1 + 0.32 * light - 0.12 * d;
      const hh = hash2(x * 7 + seed, y * 13 + seed);
      if (kind === 'pine') {
        if (Math.round(d * r) % 3 === 0) f *= 0.86; // tiers of branches
        if (d < 0.2) f *= 1.15;
      } else if ((hh & 7) === 0) f *= 1.15;
      else if ((hh & 7) === 1) f *= 0.85;
      if (edge) f *= 0.6;
      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, base[0] * f);
      img.data[i + 1] = Math.min(255, base[1] * f);
      img.data[i + 2] = Math.min(255, base[2] * f);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // matching shadow silhouette
  const s = document.createElement('canvas');
  s.width = s.height = size;
  const sg = s.getContext('2d');
  const simg = sg.createImageData(size, size);
  for (let i = 0; i < mask.length; i++) if (mask[i]) simg.data[i * 4 + 3] = 255;
  sg.putImageData(simg, 0, 0);
  return { img: c, shadow: s, r };
}

const ART = {};
function initArt() {
  const bike = artToCanvas(BIKE_ART);
  ART.bike = makeRotations(bike);
  ART.bikeShadow = makeRotations(bike, [0, 0, 0, 90]);
  ART.arrow = makeRotations(artToCanvas(ARROW_ART));
  ART.pie = artToCanvas(PIE_ART);
  ART.house = artToCanvas(HOUSE_ART);
  ART.trees = { pine: [], round: [] };
  let seed = 1;
  for (const r of [5, 6, 7, 8]) for (let v = 0; v < 2; v++) ART.trees.pine.push(makeTree('pine', r, seed++));
  for (const r of [5, 6, 7]) for (let v = 0; v < 2; v++) ART.trees.round.push(makeTree('round', r, seed++));
}
