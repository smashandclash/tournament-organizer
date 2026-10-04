// Bots that play a whole tournament against your running server, like real players would:
// each signs in with its own wallet, gets test tokens from the dev faucet, pays its entry fee on chain,
// waits to be paired, claims its seat with the SDK and plays the game out.
//
//   npm run simulate -- --bots 4 --rounds 2 [--names Ada,Kenji,Priya,Leo]
//
// Devnet only. The bots say they are agents (as: 'agent'), so set PLAYER_KIND=any for the run, or the
// tournament's person-only rule forfeits their seats. Their wallets are kept in data/sim-bots.json.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { SmashAndClash, firstLegalMove, greedyMove } from '@smashandclash/sdk';

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BOTS = Number(arg('bots', 4));
const ROUNDS = Number(arg('rounds', 2));
const SERVER = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/+$/, '');
const KEYS = resolve(process.env.DATA_DIR || './data', 'sim-bots.json');
const NAMES = (arg('names', '') || 'Botty,Gizmo,Sprocket,Widget,Cogsworth,Pixel,Ratchet,Doodad').split(',').map((n) => n.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${who.padEnd(10)} ${msg}`);

/* one bot = a wallet + a session cookie */
class Bot {
  constructor(name, secret) {
    this.name = name;
    this.kp = nacl.sign.keyPair.fromSecretKey(secret);
    this.wallet = bs58.encode(this.kp.publicKey);
    this.cookie = '';
  }
  async api(path, body) {
    const res = await fetch(SERVER + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin: SERVER, cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${path}: ${data.error ?? res.status}`), { status: res.status });
    return data;
  }
  async signIn() {
    const { message } = await this.api('/api/auth/nonce', { wallet: this.wallet });
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), this.kp.secretKey));
    await this.api('/api/auth/verify', { wallet: this.wallet, message, signature });
    await this.api('/api/me/name', { name: this.name });
  }
  /** Sign the server-built fee transaction (one signer: us), send it through the RPC and wait for the server
   *  to see it on chain. Never signed twice: a second signature would be a second payment. */
  async pay(rpc) {
    let made;
    try {
      made = await this.api('/api/entries', {});
    } catch (e) {
      if (/already waiting|current match/.test(e.message)) return null;
      throw e;
    }
    const { entry, message } = made;
    const msg = Buffer.from(message, 'base64');
    const tx = Buffer.concat([Buffer.from([1]), Buffer.from(nacl.sign.detached(msg, this.kp.secretKey)), msg]);
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }] }) });
    const body = await res.json();
    if (body.error) throw new Error(`send: ${body.error.message}`);
    for (let i = 0; i < 120; i++) {
      const r = await this.api(`/api/entries/${entry.id}/confirm`, { signature: body.result });
      if (!r.pending) return r;
      await sleep(2000);
    }
    throw new Error('the fee never confirmed (the server also finds it later by its reference)');
  }
}

function loadBots() {
  mkdirSync(resolve(KEYS, '..'), { recursive: true });
  const saved = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : [];
  while (saved.length < BOTS) saved.push(bs58.encode(nacl.sign.keyPair().secretKey));
  writeFileSync(KEYS, JSON.stringify(saved, null, 2));
  return saved.slice(0, BOTS).map((s, i) => new Bot(NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''), bs58.decode(s)));
}

async function main() {
  const t = await fetch(`${SERVER}/api/tournament`).then((r) => r.json());
  if (t.cluster === 'mainnet-beta') throw new Error('simulate is for devnet only');
  if (t.rules.playerKind !== 'any') console.warn('PLAYER_KIND is "person": the bots declare themselves agents and their seats will forfeit. Restart the server with PLAYER_KIND=any for a simulation.');
  if (t.phase !== 'open') throw new Error(`the tournament is ${t.phase}; set TOURNAMENT_STARTS/ENDS so it is open`);
  const sc = new SmashAndClash({ baseUrl: t.smashApi });
  const bots = loadBots();
  for (const b of bots) {
    await b.signIn();
    const me = (await b.api('/api/tournament')).me;
    const bal = await fetch(t.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [b.wallet, { mint: t.mint }, { encoding: 'jsonParsed' }] }) }).then((r) => r.json());
    const tokens = (bal.result?.value ?? []).reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount), 0);
    if (tokens < Number(t.fee) * ROUNDS) {
      for (;;) {
        try {
          const f = await b.api('/api/dev/faucet', {});
          log(b.name, `faucet: ${f.tokens} test tokens + ${f.sol} SOL`);
          break;
        } catch (e) {
          if (e.status !== 429 || /an hour/.test(e.message)) throw e;
          log(b.name, 'faucet busy (3 a minute per address), waiting…');
          await sleep(61_000);
        }
      }
    }
    log(b.name, `signed in as ${me.name} (${b.wallet.slice(0, 4)}…)`);
  }

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n— round ${round} —`);
    await Promise.all(
      bots.map(async (b, i) => {
        // a match already waiting for us (a rerun) is played first; otherwise pay and queue
        let cur = (await b.api('/api/tournament')).me?.current ?? null;
        if (!cur) {
          await b.pay(t.rpc);
          log(b.name, 'paid the entry fee, in the queue');
        }
        for (let k = 0; k < 120 && !cur; k++) {
          cur = (await b.api('/api/tournament')).me?.current;
          if (!cur) await sleep(2000);
        }
        if (!cur) return log(b.name, 'never paired (odd number of players?)');
        // the seat is ours: claim it and play it out with one of the SDK's choosers
        let game;
        for (let k = 0; !game; k++) {
          try {
            game = await sc.games.claim(cur.invite, { as: 'agent', name: b.name });
          } catch (e) {
            if (e.status !== 409 || k >= 4) throw e; // both seats claimed at once: try again
            await sleep(250 + Math.random() * 500);
          }
        }
        const chooser = i % 2 ? firstLegalMove : greedyMove;
        log(b.name, `vs ${cur.opponent} (${cur.id}), playing ${chooser === greedyMove ? 'greedyMove' : 'firstLegalMove'}`);
        const end = await game.playOut((view, seat) => chooser(view, seat));
        log(b.name, `${end.winner === 'draw' ? 'draw' : end.winner === game.state.seat ? 'won' : 'lost'} ${end.score.A}–${end.score.B}`);
      })
    );
    await sleep(6000); // let the server read the results
  }
  const fin = await fetch(`${SERVER}/api/tournament`).then((r) => r.json());
  console.log('\nstandings:');
  for (const [i, r] of fin.standings.entries()) console.log(`  ${i + 1}. ${r.name.padEnd(12)} ${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''}  (${r.opponents} opponents)`);
  console.log(`pool: ${fin.pool.pot} ${fin.token}`);
}

main().catch((e) => {
  console.error(e.message, e.cause?.code ?? e.cause?.message ?? "");
  process.exit(1);
});
