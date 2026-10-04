import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanName, pair, pickWinner, split, standings, targetReached } from '../server/rules.mjs';

const cfg = { forfeitsCount: true, minOpponentsToWin: 2, winTarget: 0, maxRepeatPairings: 2, rakePercent: 0 };
const m = (a, b, winner, t, status = 'finished') => ({ wallet_a: a, wallet_b: b, winner, status, finished_at: t });
const names = new Map([['A', 'Ada'], ['B', 'Bo'], ['C', 'Cy']]);

test('standings: wins, then fewest losses, then whoever got there first', () => {
  const t = standings([m('A', 'B', 'A', 1), m('B', 'C', 'B', 2), m('C', 'A', 'C', 3), m('A', 'C', 'A', 4)], names, cfg);
  assert.deepEqual(t.map((r) => [r.wallet, r.wins, r.losses]), [['A', 2, 1], ['B', 1, 1], ['C', 1, 2]]);
  assert.equal(t[0].opponents, 2);
});

test('ties on wins and losses go to whoever reached the total first', () => {
  const t = standings([m('A', 'C', 'A', 10), m('B', 'C', 'B', 5)], names, cfg);
  assert.equal(t[0].wallet, 'B');
});

test('draws count as played; void matches and waiting matches count for nothing', () => {
  const t = standings([m('A', 'B', 'draw', 1), m('A', 'C', 'A', 2, 'void'), m('A', 'C', null, 0, 'active')], names, cfg);
  assert.deepEqual(t.map((r) => [r.wallet, r.played, r.draws, r.wins]), [['A', 1, 1, 0], ['B', 1, 1, 0]]);
});

test('forfeits count only when the config says so', () => {
  const ms = [m('A', 'B', 'A', 1, 'forfeit')];
  assert.equal(standings(ms, names, cfg)[0].wins, 1);
  assert.equal(standings(ms, names, { ...cfg, forfeitsCount: false }).length, 0);
});

test('the winner needs a win and enough different opponents', () => {
  const t = standings([m('A', 'B', 'A', 1), m('A', 'B', 'A', 2), m('C', 'B', 'C', 3), m('C', 'A', 'C', 4)], names, cfg);
  assert.equal(pickWinner(t, cfg).wallet, 'C'); // A has 2 wins but only one opponent; C beat two people
  assert.equal(pickWinner(standings([m('A', 'B', 'draw', 1)], names, cfg), cfg), null);
});

test('first to N: reached only with enough opponents', () => {
  const t = standings([m('A', 'B', 'A', 1), m('A', 'C', 'A', 2)], names, cfg);
  assert.equal(targetReached(t, { ...cfg, winTarget: 2 }), true);
  assert.equal(targetReached(t, { ...cfg, winTarget: 3 }), false);
  assert.equal(targetReached(t, cfg), false);
});

test('pairing: oldest first, never yourself, and no pair past the repeat cap', () => {
  const q = [
    { id: '1', wallet: 'A', queued_at: 1 },
    { id: '2', wallet: 'A', queued_at: 2 },
    { id: '3', wallet: 'B', queued_at: 3 },
    { id: '4', wallet: 'C', queued_at: 4 },
  ];
  const met = new Map([['A|B', 2]]);
  const timesMet = (x, y) => met.get([x, y].sort().join('|')) ?? 0;
  const pairs = pair(q, timesMet, cfg).map(([a, b]) => `${a.id}-${b.id}`);
  assert.deepEqual(pairs, ['1-4']); // A can't meet B again, A can't meet A; B waits for someone new
});

test('the pool split: rake rounds down, the winner gets the rest', () => {
  assert.deepEqual(split(1000n, cfg), { prize: 1000n, rake: 0n });
  assert.deepEqual(split(1001n, { ...cfg, rakePercent: 5 }), { prize: 951n, rake: 50n });
});

test('names: cleaned, or the short wallet', () => {
  assert.equal(cleanName('  Ada <script>', 'W'), 'Ada script');
  assert.equal(cleanName('x', '4VkfpAfHWFkBsVoSrAp4bos4yzWmJYj3z1LPNm1Dxory'), '4Vkf…xory');
});
