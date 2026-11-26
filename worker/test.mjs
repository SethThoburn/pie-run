// API tests against a running worker. Usage: node test.mjs [baseUrl]
// Default base is the local dev server (npx wrangler dev --port 8787).
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const api = BASE + '/api/scores';
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const post = async (body, ip) => {
  const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), cors: r.headers.get('access-control-allow-origin') };
};
const uniq = 'T' + Math.floor(Math.random() * 1e6).toString(36).toUpperCase().slice(0, 5);

let r = await fetch(api);
check(r.status === 200, 'GET returns 200');
const g = await r.json();
check(Array.isArray(g.top), 'GET returns top array');
check(r.headers.get('access-control-allow-origin') === '*', 'GET has CORS header');

const pre = await fetch(api, { method: 'OPTIONS' });
check(pre.status === 204 && pre.headers.get('access-control-allow-methods').includes('POST'), 'OPTIONS preflight allows POST');

let p = await post({ name: uniq + 'A', ms: 41230 }, '10.0.0.1');
check(p.status === 200 && p.body.name === uniq + 'A' && p.body.best === 41230 && p.body.rank >= 1, `POST valid score -> rank ${p.body.rank}`);
p = await post({ name: (uniq + 'a').toLowerCase().replace(/^t/, 't') , ms: 39000 }, '10.0.0.1');
check(p.status === 200 && p.body.name === uniq + 'A' && p.body.best === 39000, 'name is case-insensitive; faster time becomes best');
p = await post({ name: uniq + 'A', ms: 50000 }, '10.0.0.1');
check(p.status === 200 && p.body.best === 39000, 'slower time does not replace best');
const top = (await (await fetch(api)).json()).top;
check(top.filter((e) => e.name === uniq + 'A').length === 1, 'board lists each name once');
check(top.every((e, i) => i === 0 || top[i - 1].ms <= e.ms), 'board sorted fastest first');

check((await post({ name: '', ms: 40000 }, '10.0.0.2')).status === 400, 'empty name rejected');
check((await post({ name: 'WAYTOOLONGNAME1', ms: 40000 }, '10.0.0.2')).status === 400, '13+ char name rejected');
check((await post({ name: 'BAD<SCRIPT>', ms: 40000 }, '10.0.0.2')).status === 400, 'unsupported characters rejected');
check((await post({ name: 'SH1T HEAD', ms: 40000 }, '10.0.0.2')).status === 400, 'blocklisted name rejected (digit swap)');
check((await post({ name: 'GRAPE', ms: 40000 }, '10.0.0.2')).status === 200, 'innocent name accepted');
check((await post({ name: 'SPEEDY', ms: 5000 }, '10.0.0.2')).status === 400, 'impossibly fast time rejected');
check((await post({ name: 'SPEEDY', ms: 41.5 }, '10.0.0.2')).status === 400, 'non-integer time rejected');
check((await post({ name: 'SPEEDY', ms: '41000' }, '10.0.0.2')).status === 400, 'string time rejected');
const bad = await fetch(api, { method: 'POST', body: 'not json' });
check(bad.status === 400, 'malformed JSON rejected');

const statuses = [];
for (let i = 0; i < 8; i++) statuses.push((await post({ name: uniq + 'R', ms: 40000 + i }, '10.9.9.9')).status);
check(statuses.slice(0, 6).every((s) => s === 200) && statuses.slice(6).every((s) => s === 429), `rate limit after 6/min (${statuses.join(',')})`);
check((await post({ name: uniq + 'R', ms: 40000 }, '10.9.9.8')).status === 200, 'other clients unaffected by rate limit');

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
