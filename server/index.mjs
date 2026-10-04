// The organizer's server: the tournament API, the lobby and the in-site game client (web/), one process.
//   node --env-file=.env server/index.mjs
// It needs nothing but Node 22.13+: a SQLite file, a Solana RPC and the Smash&Clash API.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection } from '@solana/web3.js';
import { SmashAndClash } from '@smashandclash/sdk';
import { createAuth } from './auth.mjs';
import { createChain, loadKeypair } from './chain.mjs';
import { explorerTx, loadConfig, toUnits } from './config.mjs';
import { openDb } from './db.mjs';
import { createTournament } from './tournament.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB = join(ROOT, 'web');
const VENDOR = {
  '/vendor/smashandclash-sdk.js': join(ROOT, 'node_modules/@smashandclash/sdk/dist/index.js'),
  '/vendor/nacl.js': join(ROOT, 'node_modules/tweetnacl/nacl-fast.min.js'), // the devnet test wallet signs with it
};
const TICK_MS = 4000;

const cfg = loadConfig();
if (!cfg.mint) throw new Error('SMASH_MINT is not set. On devnet, run `npm run setup:devnet` first (it creates a test mint and writes .env).');
if (!existsSync(resolve(ROOT, cfg.poolKeypairPath))) throw new Error(`No pool keypair at ${cfg.poolKeypairPath}. Run \`npm run setup:devnet\`, or point POOL_KEYPAIR at your pool wallet.`);
if (cfg.cluster === 'mainnet-beta') console.warn('[tournament] MAINNET: real $SMASH. Read docs/going-to-mainnet.md first.');

const db = openDb(resolve(ROOT, cfg.dataDir));
// fail fast on a rate limit (429) instead of web3.js's built-in backoff, which can hold a request for minutes;
// every caller retries on its own schedule (the confirm poll, the next tick)
const connection = new Connection(cfg.rpc, { commitment: cfg.commitment, disableRetryOnRateLimit: true });
const chain = createChain({ connection, cfg, poolKeypair: loadKeypair(resolve(ROOT, cfg.poolKeypairPath)) });
const sc = new SmashAndClash({ baseUrl: cfg.smashApi });
const tournament = createTournament({ db, cfg, chain, sc });
const auth = createAuth(db, cfg);

/* --------------------------------- helpers --------------------------------- */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

const rpcOrigins = [...new Set([cfg.publicRpc, cfg.rpc].map((u) => new URL(u).origin))];
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' data: ${new URL(cfg.smashApi).origin}`,
  `connect-src 'self' ${new URL(cfg.smashApi).origin} ${rpcOrigins.join(' ')} ${rpcOrigins.map((o) => o.replace(/^http/, 'ws')).join(' ')}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, {
    'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(json ? JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : body);
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('send JSON'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16_384) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('that is not JSON'), { status: 400 });
  }
}

/** Requests that change something must come from this site (a JSON body plus a same-origin Origin header). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === new URL(cfg.publicUrl).origin || origin === `http://${req.headers.host}`;
}

const buckets = new Map();
/** A small per-IP limiter: `n` requests per minute per route group. */
function limited(req, group, n) {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '?').trim();
  const key = `${group}|${ip}`;
  const t = Date.now();
  const b = buckets.get(key) ?? { n: 0, reset: t + 60_000 };
  if (t > b.reset) Object.assign(b, { n: 0, reset: t + 60_000 });
  b.n++;
  buckets.set(key, b);
  return b.n > n;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k);
}, 60_000).unref();

const blocked = (req) => {
  const country = String(req.headers[cfg.countryHeader] ?? '').toUpperCase();
  return !!country && cfg.blockedRegions.includes(country);
};

function serveFile(res, file) {
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) return send(res, 404, 'not found');
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-cache',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  createReadStream(file).pipe(res);
}

/* ---------------------------------- peers ----------------------------------- */

// Other tournaments (other deployments of this example) shown beside this one: their public summary,
// fetched server-side and cached, so a slow peer never slows this page.
const peerCache = new Map();
async function peerSummaries() {
  return (
    await Promise.all(
      cfg.peers.map(async (url) => {
        const hit = peerCache.get(url);
        if (hit && Date.now() - hit.at < 60_000) return hit.summary;
        try {
          const r = await fetch(`${url}/api/tournament`, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } });
          const t = await r.json();
          const summary = { url, name: String(t.name).slice(0, 60), phase: t.phase, startsAt: t.startsAt, endsAt: t.endsAt, prize: t.pool?.prize, token: t.token, fee: t.fee, players: t.players, cluster: t.cluster, winTarget: t.rules?.winTarget ?? 0 };
          peerCache.set(url, { at: Date.now(), summary });
          return summary;
        } catch {
          return hit?.summary ?? null;
        }
      })
    )
  ).filter(Boolean);
}

/* ---------------------------------- routes ---------------------------------- */

async function api(req, res, path) {
  const wallet = auth.walletOf(req);
  const need = () => {
    if (!wallet) throw Object.assign(new Error('sign in with your wallet first'), { status: 401 });
    return wallet;
  };
  const post = req.method === 'POST';
  if (post && !sameOrigin(req)) return send(res, 403, { error: 'cross-site request refused' });

  if (req.method === 'GET' && path === '/api/tournament') {
    const s = await tournament.state(wallet);
    return send(res, 200, { ...s, rpc: cfg.publicRpc, blocked: blocked(req), smashApi: cfg.smashApi, organizer: cfg.organizer, theme: cfg.theme, brand: cfg.brand, peers: await peerSummaries() });
  }
  if (post && path === '/api/auth/nonce') {
    if (limited(req, 'auth', 20)) return send(res, 429, { error: 'slow down' });
    const { wallet: w } = await readJson(req);
    return send(res, 200, auth.challenge(w));
  }
  if (post && path === '/api/auth/verify') {
    if (limited(req, 'auth', 20)) return send(res, 429, { error: 'slow down' });
    const body = await readJson(req);
    const token = auth.verify(body);
    tournament.ensurePlayer(body.wallet);
    return send(res, 200, { wallet: body.wallet }, { 'set-cookie': auth.cookie(token) });
  }
  if (post && path === '/api/auth/signout') {
    auth.signOut(req);
    return send(res, 200, { ok: true }, { 'set-cookie': auth.cookie('', 0) });
  }
  if (post && path === '/api/me/name') {
    const { name } = await readJson(req);
    return send(res, 200, { name: tournament.rename(need(), name) });
  }
  if (post && path === '/api/entries') {
    if (blocked(req)) return send(res, 451, { error: 'Entering is not available in your region.' });
    if (limited(req, 'entries', 30)) return send(res, 429, { error: 'slow down' });
    return send(res, 201, await tournament.enter(need()));
  }
  let m;
  if (post && (m = /^\/api\/entries\/(ent_[0-9a-f]{16})\/confirm$/.exec(path))) {
    const { signature } = await readJson(req);
    try {
      return send(res, 200, await tournament.confirm(need(), m[1], signature));
    } catch (e) {
      if (e.status === 425) return send(res, 202, { pending: true, reason: e.message }); // not on chain yet: ask again
      throw e;
    }
  }
  if (post && (m = /^\/api\/entries\/(ent_[0-9a-f]{16})\/cancel$/.exec(path))) {
    return send(res, 200, tournament.cancel(need(), m[1]));
  }
  if (post && path === '/api/dev/faucet') {
    if (!cfg.devFaucet) return send(res, 404, { error: 'no faucet here' });
    if (limited(req, 'faucet', 3)) return send(res, 429, { error: 'slow down' });
    const w = need();
    const last = Number(db.meta(`faucet:${w}`) ?? 0);
    if (Date.now() - last < 3600_000) return send(res, 429, { error: 'one top-up an hour per wallet' });
    db.meta(`faucet:${w}`, Date.now());
    try {
      const signature = await chain.faucet(w, toUnits(cfg.matchFee * 10, cfg.decimals), 0.01);
      return send(res, 200, { signature, explorer: explorerTx(cfg, signature), tokens: cfg.matchFee * 10, sol: 0.01 });
    } catch (e) {
      db.meta(`faucet:${w}`, last);
      throw Object.assign(new Error(`the faucet failed: ${e.message}. Is the pool wallet funded with devnet SOL?`), { status: 502 });
    }
  }
  return send(res, 404, { error: 'no such route' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (path.startsWith('/api/')) return await api(req, res, path);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (VENDOR[path]) return serveFile(res, VENDOR[path]);
    const file = normalize(join(WEB, path === '/' ? 'index.html' : path));
    if (!file.startsWith(WEB)) return send(res, 400, 'bad path');
    if (existsSync(file) || extname(path)) return serveFile(res, file);
    return serveFile(res, join(WEB, 'index.html')); // client-side routes
  } catch (e) {
    const status = e.status ?? 500;
    if (status >= 500) console.error('[tournament]', e);
    return send(res, status, { error: status >= 500 && !e.status ? 'something went wrong' : e.message });
  }
});

server.listen(cfg.port, () => {
  console.log(`[tournament] ${cfg.name} on ${cfg.publicUrl} (${cfg.cluster}, mint ${cfg.mint}, pool ${chain.pool.address})`);
});

// the tournament's clock: pair the queue, read results, pay out
const loop = setInterval(() => tournament.tick().catch((e) => console.error('[tournament] tick', e)), TICK_MS);
tournament.tick().catch((e) => console.error('[tournament] tick', e));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(loop);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
