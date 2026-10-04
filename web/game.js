// The game client: one screen for every way to play through the Smash&Clash SDK.
//
//   tournament  the browser claims its own seat with the invite the tournament gave this wallet
//               (games.claim / games.resume); results are read by the organizer's server
//   practice    free games that never count: an opponent at your level (games.startHouse), whoever
//               is online (games.quickMatch), a friend by link (games.createDuel opponent 'person'),
//               an agent by code (games.createDuel), a duel by code (games.joinDuel)
//
// Play is game.play(); between turns game.waitForTurn() long-polls; game.sync() feeds the move list and
// the other side's hand; game.review() scores a finished game. In practice, greedyMove() offers a hint.

import { avatar, h, slab } from './ui.js';
import { boardEl } from './board.js';
import { afterPracticeGame, deck, errorText, greedyMove, sdk, seatName } from './sdk.js';

const SEATS = 'snc-tournament:seats'; // tournament game id -> player token (a reload resumes, never reclaims)
export const PRACTICE = 'snc-tournament:practice-game'; // the practice game in progress, to resume

// Move names: "Pengu@C2" places, "Teddy!C2" overruns, "hop→E3" / "hop: stay" resolve a hop,
// "BOULDER(D2)", "FREEZE(C1)", "RECRUIT(D3→B1)", "FLIP" and "SWAP" play an effect.
export function parseMove(name) {
  let m;
  if ((m = /^(.+)[@!]([A-E][1-3])$/.exec(name))) return { name, key: m[1], cells: [m[2]] };
  if ((m = /^hop→([A-E][1-3])$/.exec(name))) return { name, key: 'hop', cells: [m[1]] };
  if (name.startsWith('hop')) return { name, key: 'hop', cells: [] };
  if ((m = /^([A-Z]+)\((.*)\)$/.exec(name))) return { name, key: m[1], cells: m[2].split('→') };
  return { name, key: name, cells: [] };
}
// The key a hand card's moves start with: its name, or an effect's keyword ("Boulder!" -> BOULDER).
const handKey = (card) => (card.kind === 'effect' ? card.card.replace(/!$/, '').toUpperCase() : card.card);

/** Claim a seat; both players claiming the same game at once can collide (409), so try again briefly. */
export async function claimSeat(sc, invite, opts) {
  for (let i = 0; ; i++) {
    try {
      return await sc.games.claim(invite, opts);
    } catch (e) {
      if (e.status !== 409 || i >= 4 || /finished|abandoned/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
    }
  }
}

const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

/**
 * @param {{ root: HTMLElement, smashApi: string, onExit: () => void, onEvent?: (kind: string, data?: any) => void,
 *   source: { kind: 'tournament', matchId: string, invite: string }
 *         | { kind: 'practice', mode: 'house'|'quick'|'invite'|'code'|'join', start?: (sc) => Promise<any>, resume?: { id, token }, strength?: number, playerName?: string } }} o
 */
export function openGame({ root, smashApi, onExit, onEvent = () => {}, source }) {
  const sc = sdk(smashApi);
  const practice = source.kind === 'practice';
  let game = null;
  let cards = new Map();
  let selected = null;
  let path = [];
  let busy = practice ? (source.mode === 'quick' ? 'Joining the queue…' : 'Dealing…') : 'Taking your seat…';
  let notice = null;
  let armed = null;
  let flash = new Set();
  let hintCells = new Set();
  let closed = false;
  let gen = 0;
  let feed = null; // from game.sync(): { opponentHand, moves }
  let review = null;
  let finished = false;
  let turnSince = 0; // when this screen saw our turn begin (the move clock counts from it)
  const clock = setInterval(() => {
    const el = root.querySelector('.turn-clock b');
    if (el) el.textContent = clockText();
  }, 1000);

  const view = () => game?.view;
  const mySeat = () => game?.state.seat ?? 'A';
  const otherSeat = () => (mySeat() === 'A' ? 'B' : 'A');
  const opponentName = () => seatName(game?.state, otherSeat()) || 'Opponent';

  function say(text, ms = 4000) {
    notice = { text, until: Date.now() + ms };
    render();
    setTimeout(render, ms + 50);
  }

  async function task(label, fn) {
    if (busy && busy !== label) return;
    busy = label;
    render();
    try {
      await fn();
    } catch (e) {
      say(errorText(e), 6000);
    } finally {
      busy = null;
      render();
    }
  }

  /* ------------------------------- the seat -------------------------------- */

  async function start() {
    await task(busy, async () => {
      cards = await deck(sc);
      if (source.kind === 'tournament') {
        const saved = store.get(SEATS, {})[source.matchId];
        if (saved) game = await sc.games.resume(source.matchId, saved).catch(() => null);
        if (!game) {
          game = await claimSeat(sc, source.invite, { as: 'person' });
          store.set(SEATS, Object.fromEntries(Object.entries({ ...store.get(SEATS, {}), [game.id]: game.playerToken }).slice(-20)));
        }
      } else if (source.resume) {
        game = await sc.games.resume(source.resume.id, source.resume.token);
      } else {
        game = await source.start(sc);
        store.set(PRACTICE, { id: game.id, token: game.playerToken, mode: source.mode, strength: source.strength ?? null, inviteUrl: game.inviteUrl ?? null });
      }
      onEvent('seated', game.state);
    });
    if (!game) return;
    afterChange(new Map());
  }

  /* ------------------------------- the moves ------------------------------- */

  function owners() {
    const out = new Map();
    for (const t of view()?.board ?? []) if (t.card) out.set(t.cell, `${t.card}:${t.owner}:${t.frozen ? 1 : 0}`);
    return out;
  }

  function candidates() {
    const v = view();
    if (!v || !game.yourTurn || busy) return [];
    const moves = v.legalMoves.map(parseMove);
    if (v.pendingHop) return moves.filter((m) => m.key === 'hop');
    const card = selected == null ? null : v.hand[selected];
    return card ? moves.filter((m) => m.key === handKey(card)) : [];
  }

  function targets() {
    const next = candidates().filter((m) => m.cells.length > path.length && path.every((c, i) => m.cells[i] === c));
    return new Set(next.map((m) => m.cells[path.length]));
  }

  const playable = (card) => !!view()?.legalMoves.some((n) => parseMove(n).key === handKey(card));

  function play(name) {
    selected = null;
    path = [];
    hintCells = new Set();
    task(`Playing ${name}…`, async () => {
      const before = owners();
      await game.play(name);
      afterChange(before);
    });
  }

  function clickHand(i) {
    const v = view();
    if (!v || !game.yourTurn || busy || v.pendingHop) return;
    const card = v.hand[i];
    if (!card) return;
    if (!playable(card)) return say(`${card.card} has nothing to do right now.`);
    hintCells = new Set();
    if (selected === i) {
      const now = candidates().find((m) => m.cells.length === 0);
      if (now) return play(now.name);
      selected = null;
    } else selected = i;
    path = [];
    render();
  }

  function clickCell(cell) {
    if (!game?.yourTurn || busy) return;
    if (!targets().has(cell)) {
      if (path.length) {
        path = [];
        render();
      }
      return;
    }
    path = [...path, cell];
    const done = candidates().find((m) => m.cells.length === path.length && m.cells.every((c, i) => c === path[i]));
    if (done) return play(done.name);
    render();
  }

  /** Practice only: the SDK's greedy chooser suggests a move; the card lifts and its tiles light. */
  function hint() {
    const v = view();
    if (!practice || !v || !game.yourTurn) return;
    const m = parseMove(greedyMove(v, mySeat()));
    const i = v.hand.findIndex((c) => handKey(c) === m.key);
    selected = i >= 0 ? i : null;
    path = [];
    hintCells = new Set(m.cells);
    say(`Try ${m.name}.`, 5000);
  }

  function resign() {
    if (!game || game.over) return;
    if (game.waiting) {
      // nobody joined yet: calling it off is not a loss
      return task('Calling it off…', async () => {
        await game.resign();
        if (practice) store.set(PRACTICE, null);
        onExit();
      });
    }
    if (!(armed?.key === 'resign' && armed.until > Date.now())) {
      armed = { key: 'resign', until: Date.now() + 5000 };
      say(practice ? 'Press Resign again to concede this practice game.' : 'Press Resign again to concede this match. It counts as a loss.', 5000);
      return;
    }
    armed = null;
    task('Resigning…', async () => {
      const before = owners();
      await game.resign();
      afterChange(before);
    });
  }

  function copyInvite() {
    const url = game?.inviteUrl ?? store.get(PRACTICE, {})?.inviteUrl;
    if (!url) return;
    if (navigator.share) navigator.share({ title: 'Play me at Smash&Clash', url }).catch(() => {});
    else navigator.clipboard?.writeText(url).then(() => say('Invite link copied. Send it to a friend.'), () => say(url, 10000));
  }

  /* ------------------------------ game updates ----------------------------- */

  function afterChange(before) {
    if (!game) return render();
    turnSince = game.yourTurn && !game.over ? turnSince || Date.now() : 0;
    const after = owners();
    flash = before.size ? new Set([...after].filter(([cell, v]) => before.get(cell) !== v).map(([cell]) => cell)) : new Set();
    if (game.over) finish();
    else pump();
    if (!game.waiting) refreshFeed();
    render();
  }

  /** The move list and the other side's hand, from the seat's own sync feed. */
  async function refreshFeed() {
    try {
      const s = await game.sync({ since: Math.max(0, (game.state.moveCount ?? 0) - 8) });
      feed = { opponentHand: s.state.opponentHand, deck: s.state.deck, moves: s.moves.slice(-8).reverse().map((m) => ({ seat: m.seat, name: m.name, n: m.index + 1 })) };
      render();
    } catch {}
  }

  // Long-poll until it is your turn or the game ends. One pump at a time.
  async function pump() {
    const g = ++gen;
    while (!closed && g === gen && game && !game.over && !game.yourTurn) {
      const before = owners();
      const wasWaiting = game.waiting;
      try {
        await game.waitForTurn(20);
      } catch (e) {
        if (closed || g !== gen) return;
        say(errorText(e), 5000);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      if (closed || g !== gen) return;
      if (game.over || game.yourTurn || owners().size !== before.size || wasWaiting !== game.waiting) return afterChange(before);
      render();
    }
  }

  async function finish() {
    if (finished) return;
    finished = true;
    const result = game.winner;
    if (practice) {
      if (source.mode === 'house' && game.state.status === 'finished') afterPracticeGame(source.strength ?? 1200, result);
      store.set(PRACTICE, null);
    }
    onEvent('over', game.state);
    if ((game.state.moveCount ?? 0) > 0 && game.state.status === 'finished') {
      try {
        review = await game.review();
        render();
      } catch {}
    }
  }

  /* -------------------------------- drawing -------------------------------- */

  function status() {
    const v = view();
    const opp = opponentName();
    if (busy) return { main: busy };
    if (!game) return { main: 'Could not start this game.', detail: 'Go back and try again.', action: { label: 'Back', onClick: onExit, fill: 'sugar' } };
    if (game.waiting) {
      if (source.kind === 'tournament') return { main: `Waiting for ${opp}…`, detail: 'Your seat is taken. The match starts when your opponent takes theirs. If they do not show up in time, you win by forfeit.' };
      if (source.mode === 'quick') return { main: 'Looking for an opponent…', detail: 'You are in the Smash&Clash quick-match queue: you meet whoever is online. Cancel to leave it.' };
      if (game.code) return { main: h('span', {}, 'Duel code ', h('span', { class: 'selectable mono-code' }, game.code)), detail: 'Give this code to an AI agent (for example Claude through the Smash&Clash MCP, or the CLI: smashandclash duel join <code>). It joins and plays you here.' };
      return { main: 'Waiting for your friend…', detail: 'Send them your invite link: they play you in their browser, no sign-up.', action: { label: navigator.share ? 'Share invite link' : 'Copy invite link', onClick: copyInvite, fill: 'sky' } };
    }
    if (game.over) {
      const s = v?.score ?? { you: 0, opponent: 0 };
      const main = game.state.status === 'abandoned' ? 'Game called off.' : game.winner === 'you' ? `You win, ${s.you}–${s.opponent}!` : game.winner === 'draw' ? `A draw, ${s.you}–${s.opponent}.` : `${opp} wins, ${s.opponent}–${s.you}.`;
      const detail = source.kind === 'tournament' ? 'The tournament reads the result from Smash&Clash and updates the standings in a few seconds.' : 'Practice games never count for the tournament.';
      return { main, detail, over: true, action: practice ? { label: 'Play again', onClick: () => onEvent('again', source.mode), fill: 'sun' } : { label: 'Back to the tournament', onClick: onExit, fill: 'sun' } };
    }
    if (!game.yourTurn) return { main: `${opp} is playing…` };
    if (v.pendingHop) {
      const stay = v.legalMoves.find((n) => n.startsWith('hop:'));
      const from = v.pendingHop.from;
      const piece = v.special?.chessTiles.find((t) => t.cell === from)?.piece ?? 'chess piece';
      return { main: 'Hop! Pick a glowing tile.', detail: `Your card landed on a ${piece} tile: it may hop like a ${piece} and attack again.`, action: stay && { label: `Stay on ${from}`, onClick: () => play(stay), fill: 'sugar' } };
    }
    const card = selected == null ? null : v.hand[selected];
    if (!card) return { main: 'Your turn. Pick a card.' };
    if (card.kind === 'character') return { main: `Place ${card.card} on a glowing tile.`, detail: 'Pick the card again to put it back.' };
    const now = candidates().find((m) => m.cells.length === 0);
    if (now) return { main: `Play ${card.card}?`, detail: card.does, action: { label: `Play ${card.card}`, onClick: () => play(now.name), fill: 'sun' } };
    if (path.length) return { main: 'Now pick an empty tile for it.', detail: card.does };
    return { main: `${card.card} Pick a glowing tile.`, detail: card.does };
  }

  function reviewEl() {
    if (!review) return null;
    const me = mySeat();
    const them = otherSeat();
    const best = (seat) => ['brilliant', 'great', 'best'].reduce((s, k) => s + (review.counts[seat]?.[k] ?? 0), 0);
    const bad = (seat) => ['mistake', 'blunder'].reduce((s, k) => s + (review.counts[seat]?.[k] ?? 0), 0);
    const turning = review.turningPoint != null ? review.moves.find((m) => m.n === review.turningPoint) : null;
    return h(
      'div',
      { class: 'review-mini' },
      h('p', { class: 'review-mini__title' }, 'Game Review'),
      h('div', { class: 'acc' }, h('span', { class: 'acc__you' }, h('b', { class: 'num' }, `${Math.round(review.accuracy[me])}%`), ' you'), h('span', { class: 'acc__them' }, h('b', { class: 'num' }, `${Math.round(review.accuracy[them])}%`), ` ${opponentName()}`)),
      h('p', { class: 'meta' }, `Top plays ${best(me)} · mistakes ${bad(me)}${turning ? ` · turning point: move ${turning.n}, ${turning.name}` : ''}`)
    );
  }

  function feedEl() {
    if (!feed || !game || game.waiting) return null;
    return h(
      'div',
      { class: 'movelog' },
      h('p', { class: 'meta' }, `${opponentName()} holds ${feed.opponentHand} ${feed.opponentHand === 1 ? 'card' : 'cards'} · deck ${feed.deck}`),
      feed.moves.length ? h('ol', { class: 'moves' }, feed.moves.map((m) => h('li', { class: m.seat === mySeat() ? 'you' : 'them' }, h('span', { class: 'num' }, m.n), m.name))) : null
    );
  }

  /** The move clock (tournament matches): how long is left to move, counted from when this screen saw the turn begin. */
  function clockText() {
    const limit = (source.moveTimeoutMinutes ?? 0) * 60_000;
    if (!limit || !turnSince) return '';
    const left = Math.max(0, limit - (Date.now() - turnSince));
    return `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  }

  function resultEl(st) {
    if (!game?.over || busy) return null;
    const s = view()?.score ?? { you: 0, opponent: 0 };
    const tone = game.state.status === 'abandoned' ? 'draw' : game.winner === 'you' ? 'win' : game.winner === 'draw' ? 'draw' : 'loss';
    const title = { win: 'You win!', loss: `${opponentName()} wins`, draw: game.state.status === 'abandoned' ? 'Called off' : 'A draw' }[tone];
    const me = game.state.players?.[mySeat()] ?? 'You';
    const face = (name) => avatar(name || 'opponent', smashApi, 'avatar result__face');
    return h(
      'div',
      { class: `result result--${tone}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'result__faces' }, tone === 'draw' ? [face(me), face(opponentName())] : face(tone === 'win' ? me : opponentName())),
      h('p', { class: 'result__title' }, title),
      h('p', { class: 'result__score num' }, h('span', { class: 'you' }, s.you), h('i', {}, '–'), h('span', { class: 'them' }, s.opponent)),
      review ? h('p', { class: 'result__acc' }, `Accuracy: you ${Math.round(review.accuracy[mySeat()])}%, ${opponentName()} ${Math.round(review.accuracy[otherSeat()])}%`) : null,
      h('div', { class: 'result__actions' }, st.action ? slab(st.action.label, { fill: 'sun', size: 'sm', onclick: st.action.onClick, focus: 'action' }) : null, game.state.status === 'finished' && game.state.moveCount ? slab('Replay and review', { fill: 'sugar', size: 'sm', onclick: () => onEvent('replay', game.id), focus: 'replay' }) : null)
    );
  }

  function render() {
    if (closed) return;
    const v = view();
    const st = status();
    const yourTurn = !!game?.yourTurn && !busy;
    const noticeText = notice && notice.until > Date.now() ? notice.text : null;
    const board = boardEl({
      tiles: v?.board ?? [],
      mine: (owner) => owner === 'you',
      names: { mine: 'yours', theirs: `${opponentName()}'s` },
      cards,
      flip: mySeat() === 'B',
      special: v?.special,
      mutators: v?.ruleset === 'mutators',
      lit: targets(),
      path,
      flash,
      mark: hintCells,
      onCell: clickCell,
    });
    const handCards = v?.hand ?? [];
    const hand = h(
      'div',
      { class: `hand hand--${handCards.length}`, role: 'group', 'aria-label': 'Your hand' },
      handCards.map((card, i) => {
        const art = cards.get(card.card)?.image;
        const dim = yourTurn && !v.pendingHop && !playable(card);
        const desc = card.kind === 'character' ? `${card.card}: top ${card.top}, right ${card.right}, bottom ${card.bottom}, left ${card.left}` : `${card.card}: ${card.does}`;
        return h('button', { class: ['hand-card', selected === i && 'selected', dim && 'dim', !dim && yourTurn && !v?.pendingHop && 'ready'].filter(Boolean).join(' '), type: 'button', 'data-focus': `card-${i}`, 'aria-pressed': selected === i ? 'true' : 'false', 'aria-label': desc, title: desc, onclick: () => clickHand(i) }, art ? h('img', { src: art, alt: '', draggable: 'false' }) : h('span', {}, card.card));
      })
    );
    const s = v?.score ?? { you: 0, opponent: 0 };
    const focused = root.contains(document.activeElement) ? document.activeElement?.dataset?.focus : null; // keep keyboard focus across redraws
    const armedResign = armed?.key === 'resign' && armed.until > Date.now();
    const resignSlab = slab(game?.waiting ? 'Cancel' : armedResign ? 'Confirm resign' : 'Resign', { fill: game?.waiting ? 'sugar' : 'cherry', size: 'sm', onclick: resign, disabled: !game || game.over || !!busy, focus: 'resign' });
    if (game?.over) resignSlab.style.visibility = 'hidden';
    const themOn = !!game && !game.over && !game.yourTurn && !game.waiting;
    const tag = practice ? { house: 'Practice · at your level', quick: 'Practice · quick match', invite: 'Practice · a friend', code: 'Practice · agent duel', join: 'Practice · duel' }[source.mode] : 'Tournament match';
    const myName = game?.state.players?.[mySeat()] ?? 'You';
    const live = !!game && !game.over && !game.waiting;
    const backs = live ? Math.min(6, feed?.opponentHand ?? 5) : 0;
    const banner = live ? (yourTurn ? h('div', { class: 'turn-banner you' }, 'Your turn') : themOn ? h('div', { class: 'turn-banner them' }, `${opponentName()}’s turn`) : null) : null;
    root.replaceChildren(
      h(
        'section',
        { class: `game${yourTurn ? ' is-yours' : ''}`, 'aria-label': tag },
        h(
          'header',
          { class: 'game-bar' },
          slab('Back', { fill: 'sugar', size: 'sm', badge: 'back', label: 'Back', onclick: () => onExit(), focus: 'lobby' }),
          h(
            'div',
            { class: 'scores' },
            h('span', { class: `score score--you${yourTurn ? ' on' : ''}`, 'aria-label': `You: ${s.you}` }, avatar(myName, smashApi, 'avatar avatar--sm'), h('b', { class: 'num' }, s.you), h('span', {}, 'You')),
            h('span', { class: 'vs', 'aria-hidden': 'true' }, 'vs'),
            h('span', { class: `score score--them${themOn ? ' on' : ''}`, 'aria-label': `${opponentName()}: ${s.opponent}` }, avatar(opponentName() || 'opponent', smashApi, 'avatar avatar--sm'), h('b', { class: 'num' }, s.opponent), h('span', {}, game?.waiting ? '…' : opponentName()))
          ),
          resignSlab
        ),
        h(
          'div',
          { class: 'game-body' },
          h(
            'div',
            { class: 'play' },
            h(
              'div',
              { class: 'opp-hand', 'aria-label': live ? `${opponentName()} holds ${feed?.opponentHand ?? 5} cards` : null },
              Array.from({ length: backs }, () => h('img', { class: 'card-back', src: `${smashApi}/Card_Back_v2.png`, alt: '', draggable: 'false' }))
            ),
            h('div', { class: 'table' }, banner, board, resultEl(st)),
            hand
          ),
          h(
            'aside',
            { class: 'panel' },
            h('span', { class: practice ? 'pill pill--soft' : 'pill' }, tag),
            h('p', { class: 'status-main', role: 'status', 'aria-live': 'polite' }, st.main),
            noticeText || st.detail ? h('p', { class: noticeText ? 'status-detail notice' : 'status-detail' }, noticeText ?? st.detail) : null,
            yourTurn && source.moveTimeoutMinutes ? h('p', { class: 'turn-clock' }, 'Move within ', h('b', { class: 'num' }, clockText())) : null,
            st.action && !st.over ? slab(st.action.label, { fill: st.action.fill ?? 'sun', wide: true, onclick: st.action.onClick, focus: 'action' }) : null,
            practice && yourTurn && !v?.pendingHop ? slab('Hint', { fill: 'sky', size: 'sm', wide: true, onclick: hint, focus: 'hint', pill: 'SDK greedyMove' }) : null,
            reviewEl(),
            feedEl(),
            v ? h('p', { class: 'meta' }, `${v.ruleset === 'mutators' ? 'Mutators' : 'Classic'} rules${game?.state.lastMove ? ` · Last move: ${game.state.lastMove}` : ''}`) : null,
            h('p', { class: 'meta meta--keys' }, 'Pick a card, then a glowing tile. An effect with no target plays when you pick it twice. Keyboard: Tab to a card or tile, Enter to pick.')
          )
        )
      )
    );
    if (focused) root.querySelector(`[data-focus="${focused}"]`)?.focus();
  }

  start();
  return {
    close() {
      closed = true;
      gen++;
      clearInterval(clock);
    },
  };
}
