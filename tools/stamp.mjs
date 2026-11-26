// Cache-busting: rewrites each <script src="src/*.js"> in index.html to include a
// hash of the file's contents (src/game.js?v=1a2b3c4d), so CDN/browser caches
// (Cloudflare caches .js for hours) never serve stale code after a deploy.
// Run before committing: node tools/stamp.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = join(root, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
let n = 0;
html = html.replace(/src="(src\/[\w.-]+\.js)(\?v=[0-9a-f]+)?"/g, (m, file) => {
  const hash = createHash('sha256').update(readFileSync(join(root, file))).digest('hex').slice(0, 10);
  n++;
  return `src="${file}?v=${hash}"`;
});
writeFileSync(htmlPath, html);
console.log(`stamped ${n} scripts`);
