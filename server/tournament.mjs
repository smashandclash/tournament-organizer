// The tournament: entries and their fees, pairing, results, forfeits, refunds and the payout.
//
// It talks to the outside world through two objects, so tests can swap in fakes:
//   chain - Solana (see chain.mjs createChain): fee transactions, verification, the pool
//   sc    - the Smash&Clash SDK client: createMatch() and watch()
// Results always come from the Smash&Clash API (server-authoritative), never from a player's browser.

import { fromUnits, toUnits, explorerAddress, explorerTx } from './config.mjs';
import { cleanName, pair, pickWinner, shortWallet, split, standings, targetReached } from './rules.mjs';

const MIN = 60_000;
const err = (status, message) => Object.assign(new Error(message), { status });
const id = (p) => `${p}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

export function createTournament({ db, cfg, chain, sc, now = Date.now, log = console }) {
  const fee = toUnits(cfg.matchFee, cfg.decimals);
  const memo = (what) => `smashandclash-tournament:${what}`;
  const name = (wallet) => db.get('select name from players where wallet = ?', wallet)?.name ?? shortWallet(wallet);
  let onChain = { units: null, at: 0 };
  const checks = new Map(); // entry id -> the last fee check, to throttle chain lookups

  /* ---------------------------------- phase ---------------------------------- */

  function phase() {
    if (db.meta('settledAt')) return 'settled';
    const t = now();
    if (t < cfg.startsAt) return 'upcoming';
    if (db.meta('closedAt') || t >= cfg.endsAt) return 'closing';
    return 'open';
  }
  const closedAt = () => Number(db.meta('closedAt') ?? cfg.endsAt);

  function close(by) {
    if (db.meta('closedAt')) return;
    db.meta('closedAt', by === 'deadline' ? cfg.endsAt : now());
    db.meta('closedBy', by);
    log.info?.(`[tournament] closed (${by})`);
  }

  /* --------------------------------- players --------------------------------- */

  function ensurePlayer(wallet) {
    db.run('insert into players (wallet, name, created_at) values (?, ?, ?) on conflict(wallet) do nothing', wallet, shortWallet(wallet), now());
  }

  function rename(wallet, raw) {
    ensurePlayer(wallet);
    const n = cleanName(raw, wallet);
    const taken = db.get('select wallet from players where lower(name) = lower(?) and wallet != ?', n, wallet);
    if (taken) throw err(409, 'someone already plays under that name');
    db.run('update players set name = ? where wallet = ?', n, wallet);
    return n;
  }

  /* --------------------------------- entries --------------------------------- */

  /** Start an entry: returns the fee transaction for the wallet to sign. One open entry per wallet. */
  async function enter(wallet) {
    if (phase() !== 'open') throw err(409, phase() === 'upcoming' ? 'the tournament has not started yet' : 'entries are closed');
    ensurePlayer(wallet);
    if (current(wallet)) throw err(409, 'finish your current match first');
    if (db.get("select 1 from entries where wallet = ? and status = 'queued'", wallet)) throw err(409, 'you are already waiting for an opponent');
    let entry = db.get("select * from entries where wallet = ? and status = 'pending'", wallet);
    const have = await chain.balanceOf(wallet);
    if (have < fee) throw err(402, `entering costs ${cfg.matchFee} $SMASH; this wallet has ${fromUnits(have, cfg.decimals)}`);
    if (!entry) {
      entry = { id: id('ent'), wallet, status: 'pending', amount: fee.toString(), reference: chain.newReference(), created_at: now() };
      db.run('insert into entries (id, wallet, status, amount, reference, created_at) values (?, ?, ?, ?, ?, ?)', entry.id, wallet, 'pending', entry.amount, entry.reference, entry.created_at);
    }
    const tx = await chain.buildFee({ payer: wallet, amount: fee, reference: entry.reference, memo: memo(entry.id) });
    return { entry: publicEntry(entry), ...tx };
  }

  /** The browser reports the fee's signature. Verified on chain; the entry joins the queue. */
  async function confirm(wallet, entryId, signature) {
    const e = db.get('select * from entries where id = ? and wallet = ?', entryId, wallet);
    if (!e) throw err(404, 'no such entry');
    if (e.fee_signature) {
      if (e.fee_signature === signature) return publicEntry(e);
      throw err(409, 'this entry is already paid');
    }
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw err(400, 'that is not a transaction signature');
    // one chain lookup per entry every few seconds, however often the browser asks (RPCs rate-limit)
    const seen = checks.get(e.id);
    if (seen && seen.signature === signature && now() - seen.at < 3000) throw err(425, 'still confirming');
    checks.set(e.id, { signature, at: now() });
    if (checks.size > 500) checks.clear();
    const v = await chain.verifyFee({ signature, payer: wallet, amount: BigInt(e.amount), reference: e.reference });
    if (!v.ok) throw err(v.retry ? 425 : 402, v.reason);
    return publicEntry(markPaid(e, signature));
  }

  function markPaid(e, signature) {
    const late = e.status !== 'pending' || phase() !== 'open';
    try {
      db.run(
        "update entries set fee_signature = ?, status = ?, queued_at = ? where id = ? and fee_signature is null",
        signature, late ? 'refund-due' : 'queued', now(), e.id
      );
    } catch (x) {
      if (String(x.message).includes('UNIQUE')) throw err(409, 'that payment was already used for another entry');
      throw x;
    }
    if (late) log.info?.(`[tournament] ${e.id} paid after it closed: refunding`);
    return db.get('select * from entries where id = ?', e.id);
  }

  /** Cancel: an unpaid entry just expires; a paid one still waiting for an opponent gets its fee back. */
  function cancel(wallet, entryId) {
    const e = db.get('select * from entries where id = ? and wallet = ?', entryId, wallet);
    if (!e) throw err(404, 'no such entry');
    if (e.status === 'pending') db.run("update entries set status = 'expired' where id = ? and status = 'pending'", e.id);
    else if (e.status === 'queued') db.run("update entries set status = 'refund-due' where id = ? and status = 'queued'", e.id);
    else throw err(409, `this entry is ${e.status}`);
    return publicEntry(db.get('select * from entries where id = ?', e.id));
  }

  /** Payments the browser sent but never reported (a closed tab): found by their reference key. */
  async function reconcile() {
    const t = now();
    for (const e of db.all("select * from entries where fee_signature is null and status in ('pending','expired') and created_at between ? and ?", t - 120 * MIN, t - 20_000)) {
      let found = false;
      for (const sig of await chain.findPayments(e.reference).catch(() => [])) {
        const v = await chain.verifyFee({ signature: sig, payer: e.wallet, amount: BigInt(e.amount), reference: e.reference });
        if (v.ok) {
          markPaid(e, sig);
          found = true;
          break;
        }
      }
      if (!found && e.status === 'pending' && t - e.created_at > 15 * MIN) db.run("update entries set status = 'expired' where id = ? and status = 'pending'", e.id);
    }
  }

  /* --------------------------------- matches --------------------------------- */

  const timesMet = (a, b) =>
    db.get("select count(*) as n from matches where status != 'void' and ((wallet_a = ? and wallet_b = ?) or (wallet_a = ? and wallet_b = ?))", a, b, b, a).n;

  /** Pair the queue (oldest first, random seats) and open a Smash&Clash match for each pair. */
  async function pairQueue() {
    if (phase() !== 'open') return;
    const queue = db.all("select id, wallet, queued_at from entries where status = 'queued'");
    for (const [x, y] of pair(queue, timesMet, cfg)) {
      const [ea, eb] = Math.random() < 0.5 ? [x, y] : [y, x];
      let m;
      try {
        m = await sc.games.createMatch({ players: [name(ea.wallet), name(eb.wallet)], ruleset: cfg.ruleset });
      } catch (e) {
        log.warn?.(`[tournament] could not open a match: ${e.message}`);
        return;
      }
      const t = now();
      try {
        db.tx(() => {
          for (const e of [ea, eb]) {
            const r = db.run("update entries set status = 'matched', match_id = ? where id = ? and status = 'queued'", m.id, e.id);
            if (r.changes !== 1) throw new Error(`${e.id} left the queue`);
          }
          db.run(
            `insert into matches (id, wallet_a, wallet_b, entry_a, entry_b, invite_a, invite_b, status, last_change_at, created_at, watch_url)
             values (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`,
            m.id, ea.wallet, eb.wallet, ea.id, eb.id, m.invites.A, m.invites.B, t, t, m.state?.watchUrl ?? null
          );
        });
        log.info?.(`[tournament] match ${m.id}: ${name(ea.wallet)} vs ${name(eb.wallet)}`);
      } catch (e) {
        log.warn?.(`[tournament] pairing undone: ${e.message}`); // the unused game simply expires on smashandclash.in
      }
    }
  }

  /** Read every match in play from the Smash&Clash API and apply results, no-shows, stalls and the deadline. */
  async function watchMatches() {
    for (const m of db.all("select * from matches where status in ('waiting','active')")) {
      try {
        observe(m, await sc.games.watch(m.id));
      } catch (e) {
        log.warn?.(`[tournament] watch ${m.id}: ${e.message}`);
      }
    }
  }

  function observe(m, s) {
    const t = now();
    const walletOf = (seat) => (seat === 'A' ? m.wallet_a : m.wallet_b);
    const status = s.status === 'active' ? 'active' : m.status;
    if (s.moveCount !== m.move_count || status !== m.status) {
      // every move (and the start) resets the move clock
      db.run('update matches set move_count = ?, status = ?, last_change_at = ? where id = ?', s.moveCount, status, t, m.id);
      m = { ...m, move_count: s.moveCount, status, last_change_at: t };
    }
    if (s.status === 'finished') return finish(m, s.winner === 'draw' ? 'draw' : walletOf(s.winner), 'game', s);
    if (s.status === 'abandoned') return voidMatch(m, 'abandoned', true);

    // the tournament is over: first-to-N ends matches in play at once (refunded); a deadline gives them the grace period
    if (phase() === 'closing') {
      if (db.meta('closedBy') === 'target') return voidMatch(m, 'closed', true);
      if (t > closedAt() + cfg.settleGraceMinutes * MIN) return voidMatch(m, 'deadline', true);
    }
    if (s.status === 'waiting' && t - m.created_at > cfg.showUpMinutes * MIN) {
      const open = s.openSeats ?? [];
      if (open.length === 2) return voidMatch(m, 'no-show', false); // neither came: both fees stay in the pool
      if (open.length === 1) return forfeit(m, open[0], 'no-show');
    }
    if (s.status === 'active') {
      if (cfg.playerKind === 'person') {
        const agentSeat = ['A', 'B'].find((x) => s.playerKinds?.[x] === 'agent');
        if (agentSeat) return forfeit(m, agentSeat, 'agent-seat');
      }
      if (s.turn && t - m.last_change_at > cfg.moveTimeoutMinutes * MIN) return forfeit(m, s.turn, 'stalled');
    }
  }

  function finish(m, winner, reason, s) {
    db.run(
      "update matches set status = 'finished', winner = ?, reason = ?, score = ?, finished_at = ?, replay_url = ? where id = ? and status in ('waiting','active')",
      winner, reason, `${s.score.A}-${s.score.B}`, now(), s.replayUrl ?? null, m.id
    );
    log.info?.(`[tournament] ${m.id} finished: ${winner === 'draw' ? 'draw' : name(winner)}`);
    if (phase() === 'open' && targetReached(table(), cfg)) close('target');
  }

  function forfeit(m, loserSeat, reason) {
    const winner = loserSeat === 'A' ? m.wallet_b : m.wallet_a;
    db.tx(() => {
      db.run("update matches set status = 'forfeit', winner = ?, reason = ?, finished_at = ? where id = ? and status in ('waiting','active')", winner, reason, now(), m.id);
      // when forfeits don't count, whoever showed up isn't charged for the no-show: their entry goes back in the queue
      if (!cfg.forfeitsCount && reason === 'no-show' && phase() === 'open') {
        db.run("update entries set status = 'queued', match_id = null where id = ?", winner === m.wallet_a ? m.entry_a : m.entry_b);
      }
    });
    log.info?.(`[tournament] ${m.id} forfeit (${reason}) by ${name(loserSeat === 'A' ? m.wallet_a : m.wallet_b)}`);
    if (cfg.forfeitsCount && phase() === 'open' && targetReached(table(), cfg)) close('target');
  }

  function voidMatch(m, reason, refund) {
    db.tx(() => {
      db.run("update matches set status = 'void', reason = ?, finished_at = ? where id = ? and status in ('waiting','active')", reason, now(), m.id);
      if (refund) db.run("update entries set status = 'refund-due' where id in (?, ?) and status = 'matched'", m.entry_a, m.entry_b);
    });
    log.info?.(`[tournament] ${m.id} void (${reason})${refund ? ', fees refunded' : ''}`);
  }

  /* --------------------------------- payouts --------------------------------- */

  /**
   * Move one payout forward: new -> signed+saved -> sent -> landed. Safe to call again and again (every tick,
   * after a crash): a saved signature is checked on chain before anything is signed again.
   */
  async function advancePayout(key) {
    const p = db.get('select * from payouts where key = ?', key);
    if (!p || p.status === 'sent') return p?.status;
    if (p.status === 'sending') {
      const st = await chain.pool.check(p.signature, p.last_valid);
      if (st === 'landed') {
        db.run("update payouts set status = 'sent', raw = null, sent_at = ? where key = ?", now(), key);
        afterPayout(db.get('select * from payouts where key = ?', key));
        return 'sent';
      }
      if (st === 'pending') {
        await chain.pool.submit(p.raw).catch(() => {}); // rebroadcast; it can only land once
        return 'sending';
      }
      db.run("update payouts set status = 'new', signature = null, raw = null, note = ? where key = ?", `previous attempt ${st}`, key); // it can never land: sign a fresh one
    }
    const prepared = await chain.pool.prepare(p.wallet, BigInt(p.amount), memo(key));
    db.run("update payouts set status = 'sending', signature = ?, raw = ?, last_valid = ? where key = ?", prepared.signature, prepared.raw, prepared.lastValidBlockHeight, key);
    await chain.pool.submit(prepared.raw).catch((e) => log.warn?.(`[tournament] payout ${key}: ${e.message}`));
    return 'sending';
  }

  function afterPayout(p) {
    if (p.kind === 'refund') db.run("update entries set status = 'refunded' where id = ?", p.key.slice('refund:'.length));
    log.info?.(`[tournament] paid ${fromUnits(p.amount, cfg.decimals)} to ${p.wallet} (${p.key}) ${p.signature}`);
  }

  function queuePayout(key, kind, wallet, units, note = null) {
    db.run('insert into payouts (key, kind, wallet, amount, status, note, created_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(key) do nothing', key, kind, wallet, String(units), 'new', note, now());
  }

  async function processPayouts() {
    for (const e of db.all("select * from entries where status = 'refund-due'")) queuePayout(`refund:${e.id}`, 'refund', e.wallet, e.amount);
    for (const p of db.all("select key from payouts where status != 'sent' order by created_at")) {
      try {
        await advancePayout(p.key);
      } catch (e) {
        log.warn?.(`[tournament] payout ${p.key}: ${e.message}`);
      }
    }
  }

  /* -------------------------------- settlement -------------------------------- */

  /** Once closed and every match is over: refund who never played, then pay the winner the pot. */
  async function settle() {
    if (phase() !== 'closing') return;
    if (db.get("select 1 from matches where status in ('waiting','active')")) return;
    db.run("update entries set status = 'refund-due' where status = 'queued'");
    db.run("update entries set status = 'expired' where status = 'pending'");
    await processPayouts();
    if (db.get("select 1 from entries where status = 'refund-due'")) return; // refunds first

    if (!db.meta('winner')) {
      const t = table();
      const winner = db.meta('closedBy') === 'target'
        ? t.filter((r) => r.wins >= cfg.winTarget && r.opponents >= cfg.minOpponentsToWin).sort((a, b) => a.lastWinAt - b.lastWinAt)[0]
        : pickWinner(t, cfg);
      const pot = db.all("select amount from entries where status = 'matched'").reduce((s, e) => s + BigInt(e.amount), 0n);
      if (!winner || pot === 0n) {
        // nobody qualified: everyone who played gets their fee back
        db.run("update entries set status = 'refund-due' where status = 'matched'");
        db.meta('winner', 'none');
        log.info?.('[tournament] no eligible winner: refunding every fee');
        return;
      }
      const { prize, rake } = split(pot, cfg);
      const balance = await chain.pool.balance();
      if (balance < prize) {
        log.error?.(`[tournament] the pool holds ${fromUnits(balance, cfg.decimals)}, less than the prize ${fromUnits(prize, cfg.decimals)}: not paying`);
        return;
      }
      db.meta('winner', winner.wallet);
      db.meta('prize', prize);
      db.meta('rake', rake);
      queuePayout('prize', 'prize', winner.wallet, prize, `${winner.name}: ${winner.wins} wins`);
    }
    if (db.meta('winner') !== 'none') {
      const st = await advancePayout('prize');
      if (st !== 'sent') return;
    }
    db.meta('settledAt', now());
    log.info?.('[tournament] settled');
  }

  /* ----------------------------------- clock ---------------------------------- */

  let busy = false;
  /** One step of the tournament. The server runs it every few seconds; tests call it directly. */
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      db.meta('heartbeat', Date.now()); // scripts/settle.mjs checks this before paying from the same pool
      if (now() >= cfg.endsAt && !db.meta('closedAt') && !db.meta('settledAt')) close('deadline');
      await reconcile();
      await pairQueue();
      await watchMatches();
      await processPayouts();
      await settle();
    } finally {
      busy = false;
    }
  }

  /* ------------------------------- what's public ------------------------------ */

  function table() {
    const names = new Map(db.all('select wallet, name from players').map((p) => [p.wallet, p.name]));
    return standings(db.all("select * from matches where status in ('finished','forfeit')"), names, cfg);
  }

  /** The wallet's match in progress, with its own invite (nobody else ever sees it). */
  function current(wallet) {
    const m = db.get("select * from matches where status in ('waiting','active') and (wallet_a = ? or wallet_b = ?) order by created_at desc", wallet, wallet);
    if (!m) return null;
    const seat = m.wallet_a === wallet ? 'A' : 'B';
    return { id: m.id, seat, invite: seat === 'A' ? m.invite_a : m.invite_b, opponent: name(seat === 'A' ? m.wallet_b : m.wallet_a), status: m.status, createdAt: m.created_at, showUpBy: m.created_at + cfg.showUpMinutes * MIN };
  }

  function publicEntry(e) {
    return { id: e.id, status: e.status, amount: fromUnits(e.amount, cfg.decimals), reference: e.reference, feeSignature: e.fee_signature ?? null, createdAt: e.created_at, matchId: e.match_id ?? null };
  }

  function publicMatch(m) {
    return {
      id: m.id,
      players: [name(m.wallet_a), name(m.wallet_b)],
      wallets: [m.wallet_a, m.wallet_b],
      status: m.status,
      winner: m.winner === 'draw' ? 'draw' : m.winner ? name(m.winner) : null,
      reason: m.reason,
      score: m.score && m.winner === m.wallet_b ? m.score.split('-').reverse().join('-') : m.score, // the winner's points first
      moves: m.move_count,
      replayUrl: m.replay_url,
      finishedAt: m.finished_at,
    };
  }

  async function poolOnChain() {
    if (now() - onChain.at > 30_000) {
      onChain = { units: await chain.pool.balance().catch(() => onChain.units), at: now() };
    }
    return onChain.units;
  }

  async function state(wallet) {
    const pot = db.all("select amount from entries where status in ('queued','matched')").reduce((s, e) => s + BigInt(e.amount), 0n);
    const bal = await poolOnChain();
    const winner = db.meta('winner');
    const prize = db.get("select * from payouts where key = 'prize'");
    const out = {
      name: cfg.name,
      phase: phase(),
      startsAt: cfg.startsAt,
      endsAt: cfg.endsAt,
      closedAt: db.meta('closedAt') ? Number(db.meta('closedAt')) : null,
      closedBy: db.meta('closedBy'),
      now: now(),
      cluster: cfg.cluster,
      mint: cfg.mint,
      token: cfg.cluster === 'mainnet-beta' ? '$SMASH' : 'test $SMASH',
      ruleset: cfg.ruleset,
      fee: String(cfg.matchFee),
      rakePercent: cfg.rakePercent,
      rules: {
        winTarget: cfg.winTarget,
        maxRepeatPairings: cfg.maxRepeatPairings,
        minOpponentsToWin: cfg.minOpponentsToWin,
        forfeitsCount: cfg.forfeitsCount,
        showUpMinutes: cfg.showUpMinutes,
        moveTimeoutMinutes: cfg.moveTimeoutMinutes,
        settleGraceMinutes: cfg.settleGraceMinutes,
        playerKind: cfg.playerKind,
        minAge: cfg.minAge ?? 18,
        ageCheck: !!cfg.ageCheck,
      },
      pool: {
        address: chain.pool.address,
        tokenAccount: chain.pool.tokenAccount,
        explorer: explorerAddress(cfg, chain.pool.tokenAccount),
        pot: fromUnits(pot, cfg.decimals),
        prize: fromUnits(split(pot, cfg).prize, cfg.decimals),
        onChain: bal === null ? null : fromUnits(bal, cfg.decimals),
      },
      players: db.get('select count(distinct wallet) as n from entries where fee_signature is not null').n,
      standings: table().slice(0, 50).map(({ wallet, name, wins, losses, draws, played, opponents }) => ({ wallet, name, wins, losses, draws, played, opponents })),
      matches: db.all('select * from matches order by created_at desc limit 25').map(publicMatch),
      result: winner
        ? winner === 'none'
          ? { winner: null, note: 'Nobody met the bar to win, so every fee was refunded.' }
          : { winner, name: name(winner), prize: fromUnits(db.meta('prize'), cfg.decimals), status: prize?.status ?? null, signature: prize?.signature ?? null, explorer: prize?.signature ? explorerTx(cfg, prize.signature) : null }
        : null,
      payouts: db.all("select * from payouts where status = 'sent' order by sent_at desc limit 25").map((p) => ({ kind: p.kind, wallet: p.wallet, amount: fromUnits(p.amount, cfg.decimals), signature: p.signature, explorer: explorerTx(cfg, p.signature) })),
      devFaucet: cfg.devFaucet,
    };
    if (wallet) {
      const row = out.standings.find((r) => r.wallet === wallet);
      out.me = {
        wallet,
        name: name(wallet),
        standing: row ?? null,
        current: current(wallet),
        entries: db.all('select * from entries where wallet = ? order by created_at desc limit 20', wallet).map(publicEntry),
        payouts: db.all('select * from payouts where wallet = ? order by created_at desc', wallet).map((p) => ({ kind: p.kind, amount: fromUnits(p.amount, cfg.decimals), status: p.status, explorer: p.signature && p.status === 'sent' ? explorerTx(cfg, p.signature) : null })),
      };
    }
    return out;
  }

  return { phase, tick, enter, confirm, cancel, rename, ensurePlayer, state, table, current, observe, settle, reconcile, pairQueue, watchMatches, processPayouts, fee };
}
