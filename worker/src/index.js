// Pie Run public scoreboard API (Cloudflare Worker + D1).
//
//   GET  /api/scores            -> { top: [{ rank, name, ms }] }   each name's best, fastest first
//   POST /api/scores {name, ms} -> { rank, best, top }               rank of this name's best
//
// Names are limited to characters the game's pixel font can draw.

const TOP_N = 20;
const NAME_RE = /^[A-Z0-9 .!?'&-]{1,12}$/;
// A clean run along the streets takes well over this; anything faster is not a real run.
const MIN_MS = 20000;
const MAX_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 6; // posts per client per minute

// Small blocklist so the public board stays friendly. Matched against the name with
// spaces/punctuation removed and common digit swaps undone.
const BLOCKED = ['FUCK', 'SHIT', 'CUNT', 'BITCH', 'NIGG', 'FAG', 'PUSSY', 'WHORE', 'SLUT', 'NAZI', 'KKK', 'ASSHOLE', 'RETARD'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!NAME_RE.test(name)) return null;
  const squashed = name.replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/3/g, 'E').replace(/4/g, 'A').replace(/5/g, 'S').replace(/7/g, 'T');
  if (BLOCKED.some((w) => squashed.includes(w))) return null;
  return name;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function topScores(db) {
  const { results } = await db.prepare(
    'SELECT name, MIN(ms) AS ms FROM scores GROUP BY name ORDER BY ms ASC, MIN(created) ASC LIMIT ?',
  ).bind(TOP_N).all();
  return results.map((r, i) => ({ rank: i + 1, name: r.name, ms: r.ms }));
}

async function handlePost(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const name = cleanName(body && body.name);
  if (!name) return json({ error: 'Name must be 1-12 letters/numbers and family friendly' }, 400);
  const ms = body && body.ms;
  if (!Number.isInteger(ms) || ms < MIN_MS || ms > MAX_MS) return json({ error: 'Invalid time' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const client = await sha256((env.IP_SALT || 'pie-run') + ip);
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE client = ? AND created > ?')
    .bind(client, now - RATE_WINDOW_MS).first();
  if (recent.n >= RATE_MAX) return json({ error: 'Too many posts, try again in a minute' }, 429);

  await env.DB.prepare('INSERT INTO scores (name, ms, created, client) VALUES (?, ?, ?, ?)')
    .bind(name, ms, now, client).run();
  const best = await env.DB.prepare('SELECT MIN(ms) AS ms FROM scores WHERE name = ?').bind(name).first();
  const ahead = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM (SELECT name, MIN(ms) AS ms FROM scores GROUP BY name) WHERE ms < ?',
  ).bind(best.ms).first();
  return json({ name, rank: ahead.n + 1, best: best.ms, top: await topScores(env.DB) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname !== '/api/scores') return json({ error: 'Not found' }, 404);
    try {
      if (request.method === 'GET') return json({ top: await topScores(env.DB) });
      if (request.method === 'POST') return await handlePost(request, env);
      return json({ error: 'Method not allowed' }, 405);
    } catch (err) {
      console.error(err);
      return json({ error: 'Server error' }, 500);
    }
  },
};
