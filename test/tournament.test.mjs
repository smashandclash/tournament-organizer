// The whole tournament, end to end, against a fake chain and a fake Smash&Clash API (no network).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../server/db.mjs';
import { createTournament } from '../server/tournament.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-05T12:00:00Z');
const quiet = { info() {}, warn() {}, error() {} };

function fakeChain() {
  let n = 0;
  const wallets = new Map(); // wallet -> balance (bigint)
  const fees = new Map(); // signature -> { payer, amount, reference }
  const byReference = new Map();
  const pool = {
    address: 'POOL',
    tokenAccount: 'POOL_ATA',
    units: 0n,
    landed: new Set(),
    failSubmit: 0,
    expire: new Set(),
    prepared: 0,
    async balance() {
      return pool.units;
    },
    async prepare(wallet, units, memo) {
      pool.prepared++;
      const signature = `out${++n}`;
      return { signature, raw: JSON.stringify({ signature, wallet, units: String(units), memo }), lastValidBlockHeight: 100 };
    },
    async submit(raw) {
      if (pool.failSubmit > 0) {
        pool.failSubmit--;
        throw new Error('network down');
      }
      const r = JSON.parse(raw);
      if (pool.landed.has(r.signature) || pool.expire.has(r.signature)) return;
      pool.landed.add(r.signature);
      pool.units -= BigInt(r.units);
      wallets.set(r.wallet, (wallets.get(r.wallet) ?? 0n) + BigInt(r.units));
    },
    async check(signature) {
      if (pool.landed.has(signature)) return 'landed';
      if (pool.expire.has(signature)) return 'expired';
      return 'pending';
    },
  };
  return {
    pool,
    wallets,
    newReference: () => `ref${++n}`,
    balanceOf: async (w) => wallets.get(w) ?? 0n,
    buildFee: async ({ payer, amount, reference, memo }) => ({ transaction: JSON.stringify({ payer, amount: String(amount), reference, memo }), message: 'm' }),
    async verifyFee({ signature, payer, amount, reference }) {
      const f = fees.get(signature);
      if (!f) return { ok: false, retry: true, reason: 'not confirmed yet' };
      if (f.reference !== reference) return { ok: false, reason: 'wrong reference' };
      if (f.payer !== payer) return { ok: false, reason: 'wrong payer' };
      if (f.amount !== amount) return { ok: false, reason: 'wrong amount' };
      return { ok: true };
    },
    findPayments: async (reference) => byReference.get(reference) ?? [],
    /** The player's wallet signs and sends the fee transaction. */
    pay(payer, amount, reference) {
      const signature = `fee${++n}`.replaceAll('0', 'z').padEnd(64, 'x'); // base58 has no 0
      wallets.set(payer, (wallets.get(payer) ?? 0n) - amount);
      pool.units += amount;
      fees.set(signature, { payer, amount, reference });
      byReference.set(reference, [...(byReference.get(reference) ?? []), signature]);
      return signature;
    },
  };
}

function fakeSmash() {
  let n = 0;
  const games = new Map();
  return {
    games: {
      async createMatch({ players }) {
        const id = `g_${++n}`;
        const g = { id, status: 'waiting', openSeats: ['A', 'B'], players: { A: players[0], B: players[1] }, playerKinds: { A: 'person', B: 'person' }, moveCount: 0, turn: null, score: { A: 0, B: 0 }, winner: null, watchUrl: `https://x/api/v1/games/${id}` };
        games.set(id, g);
        return { id, state: g, invites: { A: `https://x/?game=${id}&invite=inv_A`, B: `https://x/?game=${id}&invite=inv_B` } };
      },
      async watch(id) {
        return structuredClone(games.get(id));
      },
    },
    /** Both seats claimed, A to move. */
    start(id) {
      Object.assign(games.get(id), { status: 'active', openSeats: undefined, turn: 'A' });
    },
    claim(id, seat) {
      const g = games.get(id);
      g.openSeats = g.openSeats.filter((s) => s !== seat);
    },
    move(id) {
      const g = games.get(id);
      g.moveCount++;
      g.turn = g.turn === 'A' ? 'B' : 'A';
    },
    end(id, winner) {
      Object.assign(games.get(id), { status: 'finished', winner, score: winner === 'A' ? { A: 6, B: 4 } : { A: 4, B: 6 }, turn: null, replayUrl: `https://x/replay#${id}` });
    },
    get: (id) => games.get(id),
  };
}

function setup(over = {}) {
  const clock = { t: T0 };
  const cfg = {
    name: 'Test Cup', startsAt: T0, endsAt: T0 + 60 * MIN, winTarget: 0, ruleset: 'mutators', cluster: 'devnet', mint: 'MINT', decimals: 6,
    matchFee: 10, rakePercent: 0, maxRepeatPairings: 2, minOpponentsToWin: 2, forfeitsCount: true, showUpMinutes: 5, moveTimeoutMinutes: 5,
    settleGraceMinutes: 20, playerKind: 'person', devFaucet: false, ...over,
  };
  const db = openDb(mkdtempSync(joinPath(tmpdir(), 'snc-t-')));
  const chain = fakeChain();
  const sc = fakeSmash();
  const tour = createTournament({ db, cfg, chain, sc, now: () => clock.t, log: quiet });
  for (const w of ['ADA', 'BO', 'CY', 'DEE', 'EVE']) chain.wallets.set(w, 100_000_000n); // 100 tokens each
  /** sign in, enter, pay, confirm */
  const join = async (w) => {
    const { entry } = await tour.enter(w);
    const sig = chain.pay(w, 10_000_000n, entry.reference);
    return tour.confirm(w, entry.id, sig);
  };
  const matchOf = (w) => tour.current(w);
  const play = async (a, b, winnerWallet) => {
    await join(a);
    await join(b);
    await tour.tick();
    const m = matchOf(a);
    assert.ok(m, `${a} should be in a match`);
    sc.start(m.id);
    sc.move(m.id);
    const winSeat = winnerWallet === a ? m.seat : m.seat === 'A' ? 'B' : 'A';
    sc.end(m.id, winSeat);
    await tour.tick();
    return m.id;
  };
  return { clock, cfg, db, chain, sc, tour, join, matchOf, play };
}

test('enter, pay, get paired, play, and the result lands in the standings', async () => {
  const { tour, chain, join, matchOf, sc } = setup();
  const e = await join('ADA');
  assert.equal(e.status, 'queued');
  assert.equal(chain.pool.units, 10_000_000n);
  await tour.tick();
  assert.equal(matchOf('ADA'), null); // nobody to play yet
  await join('BO'); // BO joins and meets ADA, who was waiting
  await tour.tick();
  const m = matchOf('ADA');
  assert.equal(m.opponent, 'BO');
  sc.start(m.id);
  sc.move(m.id);
  sc.end(m.id, m.seat);
  await tour.tick();
  const s = await tour.state('ADA');
  assert.equal(s.players, 2);
  assert.equal(s.pool.pot, '20');
  assert.deepEqual(s.standings.map((r) => [r.name, r.wins, r.losses]), [['ADA', 1, 0], ['BO', 0, 1]]);
  assert.equal(s.matches[0].winner, 'ADA');
  assert.equal(s.matches[0].reason, 'game');
  assert.equal(s.me.standing.wins, 1);
});

test('the oldest entry pairs first; nobody chooses their opponent', async () => {
  const { tour, join, matchOf } = setup();
  await join('ADA');
  await join('BO');
  await join('CY');
  await tour.tick();
  assert.equal(matchOf('ADA').opponent, 'BO');
  assert.equal(matchOf('CY'), null);
});

test("a payment works once: a wrong amount, someone else's signature or a reused one is refused", async () => {
  const { tour, chain, join } = setup();
  const { entry } = await tour.enter('ADA');
  const wrong = chain.pay('ADA', 1n, entry.reference);
  await assert.rejects(tour.confirm('ADA', entry.id, wrong), /wrong amount/);
  const first = await join('BO');
  const { entry: e2 } = await tour.enter('CY');
  await assert.rejects(tour.confirm('CY', e2.id, first.feeSignature), /reference|already used/);
  await assert.rejects(tour.confirm('ADA', entry.id, 'notasig'), /not a transaction signature/);
});

test("can't enter twice at once, or with too little $SMASH", async () => {
  const { tour, chain, join } = setup();
  await join('ADA');
  await assert.rejects(tour.enter('ADA'), /already waiting/);
  chain.wallets.set('POOR', 5n);
  await assert.rejects(tour.enter('POOR'), /costs 10/);
});

test('a fee paid in a tab that closed is found by its reference and still counts', async () => {
  const { tour, chain, clock } = setup();
  const { entry } = await tour.enter('ADA');
  chain.pay('ADA', 10_000_000n, entry.reference); // never confirmed by the browser
  clock.t += 30_000;
  await tour.tick();
  assert.equal((await tour.state('ADA')).me.entries[0].status, 'queued');
});

test('cancel while waiting: the fee comes back', async () => {
  const { tour, chain, join } = setup();
  const e = await join('ADA');
  tour.cancel('ADA', e.id);
  await tour.tick(); // signs and sends the refund
  await tour.tick(); // sees it landed
  assert.equal((await tour.state('ADA')).me.entries[0].status, 'refunded');
  assert.equal(chain.wallets.get('ADA'), 100_000_000n);
  assert.equal(chain.pool.units, 0n);
});

test('no-show: whoever took their seat wins by forfeit after the show-up window', async () => {
  const { tour, join, matchOf, sc, clock, db } = setup();
  await join('ADA');
  await join('BO');
  await tour.tick();
  const m = matchOf('ADA');
  sc.claim(m.id, m.seat); // only ADA shows up
  clock.t += 6 * MIN;
  await tour.tick();
  const row = db.get('select * from matches where id = ?', m.id);
  assert.deepEqual([row.status, row.winner, row.reason], ['forfeit', 'ADA', 'no-show']);
});

test("no-show when forfeits don't count: the player who came goes back in the queue", async () => {
  const { tour, join, matchOf, sc, clock } = setup({ forfeitsCount: false });
  await join('ADA');
  await join('BO');
  await tour.tick();
  const m = matchOf('ADA');
  sc.claim(m.id, m.seat);
  clock.t += 6 * MIN;
  await tour.tick();
  const s = await tour.state('ADA');
  assert.equal(s.me.entries[0].status, 'queued');
  assert.equal(s.standings.length, 0);
});

test('stalling on your turn forfeits the match', async () => {
  const { tour, join, matchOf, sc, clock, db } = setup();
  await join('ADA');
  await join('BO');
  await tour.tick();
  const m = matchOf('ADA');
  sc.start(m.id);
  await tour.tick();
  clock.t += 4 * MIN;
  sc.move(m.id); // A moved; now B to move
  await tour.tick();
  clock.t += 6 * MIN;
  await tour.tick();
  const row = db.get('select * from matches where id = ?', m.id);
  const staller = row.wallet_b; // B was on turn
  assert.equal(row.reason, 'stalled');
  assert.notEqual(row.winner, staller);
});

test('a person-only tournament forfeits a seat that says an agent plays it', async () => {
  const { tour, join, matchOf, sc, db } = setup();
  await join('ADA');
  await join('BO');
  await tour.tick();
  const m = matchOf('ADA');
  sc.start(m.id);
  sc.get(m.id).playerKinds[m.seat] = 'agent';
  await tour.tick();
  assert.equal(db.get('select reason from matches where id = ?', m.id).reason, 'agent-seat');
});

test('the deadline: the queue is refunded, then the winner takes the whole pot', async () => {
  const { tour, chain, clock, play, join } = setup();
  await play('ADA', 'BO', 'ADA');
  await play('ADA', 'CY', 'ADA');
  await play('BO', 'CY', 'BO');
  await join('DEE'); // still waiting at the deadline
  clock.t = T0 + 61 * MIN;
  for (let i = 0; i < 4; i++) await tour.tick();
  const s = await tour.state();
  assert.equal(s.phase, 'settled');
  assert.equal(s.result.winner, 'ADA');
  assert.equal(s.result.prize, '60'); // 6 entries x 10, DEE refunded
  assert.equal(chain.wallets.get('DEE'), 100_000_000n);
  assert.equal(chain.wallets.get('ADA'), 100_000_000n - 20_000_000n + 60_000_000n);
  assert.equal(chain.pool.units, 0n);
});

test('a rake stays in the pool; the winner gets the rest', async () => {
  const { tour, chain, clock, play } = setup({ rakePercent: 10 });
  await play('ADA', 'BO', 'ADA');
  await play('ADA', 'CY', 'ADA');
  clock.t = T0 + 61 * MIN;
  for (let i = 0; i < 3; i++) await tour.tick();
  assert.equal((await tour.state()).result.prize, '36');
  assert.equal(chain.pool.units, 4_000_000n);
});

test('nobody qualifies (too few opponents): every fee goes back', async () => {
  const { tour, chain, clock, play } = setup();
  await play('ADA', 'BO', 'ADA'); // ADA has one opponent; two are needed
  clock.t = T0 + 61 * MIN;
  for (let i = 0; i < 4; i++) await tour.tick();
  const s = await tour.state();
  assert.equal(s.phase, 'settled');
  assert.equal(s.result.winner, null);
  assert.equal(chain.wallets.get('ADA'), 100_000_000n);
  assert.equal(chain.wallets.get('BO'), 100_000_000n);
});

test('first to N ends the tournament at once; matches in play are refunded', async () => {
  const { tour, chain, play, join, matchOf, db, clock } = setup({ winTarget: 2 });
  await play('ADA', 'BO', 'ADA');
  await join('CY');
  await join('DEE');
  await tour.tick();
  const live = matchOf('CY'); // CY v DEE, still being played
  await play('ADA', 'EVE', 'ADA'); // ADA's 2nd win, over a 2nd opponent: the target
  assert.equal(tour.phase(), 'closing');
  clock.t += 1000;
  for (let i = 0; i < 3; i++) await tour.tick();
  assert.equal(db.get('select status, reason from matches where id = ?', live.id).reason, 'closed');
  const s = await tour.state();
  assert.equal(s.phase, 'settled');
  assert.equal(s.closedBy, 'target');
  assert.equal(s.result.prize, '40');
  assert.equal(chain.wallets.get('CY'), 100_000_000n);
  assert.equal(chain.wallets.get('DEE'), 100_000_000n);
});

test('two players meet at most MAX_REPEAT_PAIRINGS times', async () => {
  const { tour, play, join, matchOf } = setup({ maxRepeatPairings: 2 });
  await play('ADA', 'BO', 'ADA');
  await play('ADA', 'BO', 'BO');
  await join('ADA');
  await join('BO');
  await tour.tick();
  assert.equal(matchOf('ADA'), null);
  await join('CY');
  await tour.tick();
  assert.equal(matchOf('ADA').opponent, 'CY');
});

test('a payout is signed once and never paid twice, even when sending fails', async () => {
  const { tour, chain, join } = setup();
  const e = await join('ADA');
  tour.cancel('ADA', e.id);
  chain.pool.failSubmit = 1;
  await tour.tick(); // signed, saved, the send fails
  await tour.tick(); // still pending: rebroadcast the same transaction
  await tour.tick(); // landed
  assert.equal(chain.pool.prepared, 1);
  assert.equal(chain.wallets.get('ADA'), 100_000_000n);
  await tour.tick();
  assert.equal(chain.wallets.get('ADA'), 100_000_000n);
});

test('an expired payout (it can never land) is signed again, once', async () => {
  const { tour, chain, join, db } = setup();
  const e = await join('ADA');
  tour.cancel('ADA', e.id);
  chain.pool.failSubmit = 1;
  await tour.tick();
  const p = db.get("select signature from payouts where kind = 'refund'");
  chain.pool.expire.add(p.signature);
  await tour.tick(); // expired: prepares a fresh one and sends it
  await tour.tick();
  assert.equal(chain.pool.prepared, 2);
  assert.equal(chain.wallets.get('ADA'), 100_000_000n);
});

test('a fee that lands after the tournament closed is refunded', async () => {
  const { tour, chain, clock } = setup();
  const { entry } = await tour.enter('ADA');
  clock.t = T0 + 61 * MIN;
  const sig = chain.pay('ADA', 10_000_000n, entry.reference);
  const e = await tour.confirm('ADA', entry.id, sig);
  assert.equal(e.status, 'refund-due');
  for (let i = 0; i < 3; i++) await tour.tick();
  assert.equal(chain.wallets.get('ADA'), 100_000_000n);
});

test('your invite is yours: state shows only your own seat link', async () => {
  const { tour, join } = setup();
  await join('ADA');
  await join('BO');
  await tour.tick();
  const a = await tour.state('ADA');
  const b = await tour.state('BO');
  assert.notEqual(a.me.current.invite, b.me.current.invite);
  const pub = JSON.stringify(await tour.state());
  assert.ok(!pub.includes('invite='));
});
