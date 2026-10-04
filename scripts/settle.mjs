// The tournament's books, from the command line, without the web server.
//
//   npm run settle            a report: phase, standings, the pot, the winner-to-be, every refund and payout
//   npm run settle -- --pay   settle now: refunds, then the prize, until every payout has landed
//
// The server settles on its own once the deadline passes (or someone reaches the win target). This is
// the fallback when the server was down at the deadline, and the audit trail any time. --pay refuses
// while the server is running (it would be two processes paying from one pool).

import { resolve } from 'node:path';
import { Connection } from '@solana/web3.js';
import { SmashAndClash } from '@smashandclash/sdk';
import { createChain, loadKeypair } from '../server/chain.mjs';
import { explorerTx, fromUnits, loadConfig } from '../server/config.mjs';
import { openDb } from '../server/db.mjs';
import { createTournament } from '../server/tournament.mjs';

const cfg = loadConfig();
const db = openDb(resolve(cfg.dataDir));
const chain = createChain({ connection: new Connection(cfg.rpc, cfg.commitment), cfg, poolKeypair: loadKeypair(resolve(cfg.poolKeypairPath)) });
const tournament = createTournament({ db, cfg, chain, sc: new SmashAndClash({ baseUrl: cfg.smashApi }), log: { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) } });
const units = (u) => `${fromUnits(u, cfg.decimals)} ${cfg.cluster === 'mainnet-beta' ? '$SMASH' : 'test $SMASH'}`;

async function report() {
  const s = await tournament.state();
  console.log(`${s.name}  ·  ${s.phase}${s.closedBy ? ` (closed by ${s.closedBy})` : ''}  ·  ${cfg.cluster}`);
  console.log(`window   ${new Date(s.startsAt).toISOString()} → ${new Date(s.endsAt).toISOString()}`);
  console.log(`pool     ${s.pool.pot} in play, prize ${s.pool.prize}, on chain ${s.pool.onChain ?? '?'}  (${s.pool.explorer})`);
  console.log('\nstandings');
  if (!s.standings.length) console.log('  (no results yet)');
  for (const [i, r] of s.standings.slice(0, 15).entries()) console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(16)} ${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''}  ${r.opponents} opp.${r.opponents < cfg.minOpponentsToWin ? '  (not eligible)' : ''}`);
  const due = db.all("select id, wallet, amount from entries where status in ('refund-due', 'queued')");
  if (due.length) {
    console.log('\nrefunds owed');
    for (const e of due) console.log(`  ${e.wallet}  ${units(e.amount)}  (${e.id})`);
  }
  const live = db.all("select id, status from matches where status in ('waiting', 'active')");
  if (live.length) console.log(`\n${live.length} match(es) still in play: ${live.map((m) => m.id).join(', ')}`);
  const pays = db.all('select * from payouts order by created_at');
  if (pays.length) {
    console.log('\npayouts');
    for (const p of pays) console.log(`  ${p.kind.padEnd(6)} ${units(p.amount).padEnd(22)} → ${p.wallet}  ${p.status}${p.signature ? `  ${explorerTx(cfg, p.signature)}` : ''}`);
  }
  if (s.result) console.log(`\nresult: ${s.result.winner ? `${s.result.name} wins ${s.result.prize}` : s.result.note}`);
  else if (s.phase === 'open' || s.phase === 'upcoming') console.log(`\nThe server settles automatically after ${new Date(cfg.endsAt).toISOString()}.`);
}

async function pay() {
  const beat = Number(db.meta('heartbeat') ?? 0);
  if (Date.now() - beat < 60_000 && !process.argv.includes('--force')) {
    console.error('The server is running (it ticked less than a minute ago): it settles by itself. Stop it first, or pass --force if you are sure it is down.');
    process.exit(2);
  }
  if (tournament.phase() === 'open' || tournament.phase() === 'upcoming') {
    console.error(`The tournament is still ${tournament.phase()} (ends ${new Date(cfg.endsAt).toISOString()}). Nothing to settle yet.`);
    process.exit(2);
  }
  for (let i = 0; i < 60; i++) {
    await tournament.tick(); // the same step the server runs: results, refunds, the prize
    const unsent = db.get("select count(*) as n from payouts where status != 'sent'").n;
    if (tournament.phase() === 'settled' && unsent === 0) {
      console.log('settled.');
      return report();
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.error('Not settled after 4 minutes: run it again (it picks up exactly where it stopped).');
  process.exit(1);
}

(process.argv.includes('--pay') ? pay() : report()).catch((e) => {
  console.error(e);
  process.exit(1);
});
