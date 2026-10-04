// The tournament's rules as pure functions: standings, the winner, and fair pairing. No I/O, all tested.

/**
 * Standings from finished matches.
 * A match counts once it has a result: 'finished' (played out) or 'forfeit' (a no-show or a stall),
 * the latter only when forfeits count. Draws count as played, not won.
 *
 * @param {Array<{wallet_a:string, wallet_b:string, status:string, winner:string|null, finished_at:number|null}>} matches
 * @param {Map<string,string>} names wallet -> display name
 * @param {{ forfeitsCount: boolean }} cfg
 */
export function standings(matches, names, cfg) {
  const rows = new Map();
  const row = (w) => {
    if (!rows.has(w)) rows.set(w, { wallet: w, name: names.get(w) ?? shortWallet(w), wins: 0, losses: 0, draws: 0, played: 0, opponents: new Set(), lastWinAt: 0 });
    return rows.get(w);
  };
  for (const m of matches) {
    const counts = m.status === 'finished' || (m.status === 'forfeit' && cfg.forfeitsCount);
    if (!counts || !m.winner) continue;
    const a = row(m.wallet_a), b = row(m.wallet_b);
    a.played++; b.played++;
    a.opponents.add(m.wallet_b); b.opponents.add(m.wallet_a);
    if (m.winner === 'draw') { a.draws++; b.draws++; continue; }
    const [w, l] = m.winner === m.wallet_a ? [a, b] : [b, a];
    w.wins++; l.losses++;
    w.lastWinAt = Math.max(w.lastWinAt, m.finished_at ?? 0);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, opponents: r.opponents.size }))
    .sort(compareRows);
}

/** Most wins; then fewest losses; then whoever reached their total first; then the wallet (stable). */
export function compareRows(a, b) {
  return b.wins - a.wins || a.losses - b.losses || a.lastWinAt - b.lastWinAt || (a.wallet < b.wallet ? -1 : 1);
}

/** The winner: the top player who has at least one win and enough different opponents. null if nobody qualifies. */
export function pickWinner(table, cfg) {
  return table.find((r) => r.wins > 0 && r.opponents >= cfg.minOpponentsToWin) ?? null;
}

/** Has someone reached the win target (first-to-N mode)? */
export function targetReached(table, cfg) {
  return cfg.winTarget > 0 && table.some((r) => r.wins >= cfg.winTarget && r.opponents >= cfg.minOpponentsToWin);
}

/**
 * Pair queued entries, oldest first. Two entries pair when they belong to different wallets and those
 * wallets haven't met maxRepeatPairings times already. Nobody picks their opponent.
 *
 * @param {Array<{id:string, wallet:string, queued_at:number}>} queue
 * @param {(a:string, b:string) => number} timesMet
 * @param {{ maxRepeatPairings: number }} cfg
 * @returns {Array<[entry, entry]>}
 */
export function pair(queue, timesMet, cfg) {
  const waiting = [...queue].sort((x, y) => x.queued_at - y.queued_at);
  const used = new Set();
  const pairs = [];
  for (let i = 0; i < waiting.length; i++) {
    const a = waiting[i];
    if (used.has(a.id)) continue;
    for (let j = i + 1; j < waiting.length; j++) {
      const b = waiting[j];
      if (used.has(b.id) || b.wallet === a.wallet) continue;
      if (timesMet(a.wallet, b.wallet) >= cfg.maxRepeatPairings) continue;
      used.add(a.id); used.add(b.id);
      pairs.push([a, b]);
      break;
    }
  }
  return pairs;
}

/** Split the pool: the winner's prize and the organizer's rake, in base units (rake rounds down). */
export function split(poolUnits, cfg) {
  const pool = BigInt(poolUnits);
  const rake = (pool * BigInt(Math.round(cfg.rakePercent * 100))) / 10000n;
  return { prize: pool - rake, rake };
}

export const shortWallet = (w) => (w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

/** A display name: letters, digits, space, _ . -, 2-16 chars; else the short wallet. */
export function cleanName(name, wallet) {
  const n = String(name ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
  return n.length >= 2 ? n : shortWallet(wallet);
}
