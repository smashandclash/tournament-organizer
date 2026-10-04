// Watching and re-watching, through the SDK:
//   openWatch   any public game, live: games.watch() for the board, then games.follow() long-polls
//               for each move (spectators only ever see the public board, never a hand)
//   openReplay  a finished game, move by move: games.replay() + games.review() for a game id, or
//               replays.read() + replays.review() for a shared replay link (…/replay#z=…)

import { boardEl } from './board.js';
import { deck, errorText, personaName, sdk, seatName } from './sdk.js';
import { avatar, h, icon, slab } from './ui.js';

const CLASS_TONE = { brilliant: 'great', great: 'great', best: 'good', excellent: 'good', good: 'good', inaccuracy: 'meh', mistake: 'bad', blunder: 'bad', miss: 'bad', opening: 'neutral', forced: 'neutral' };

function bar({ onExit, title, a, b, aOn, bOn, sa, sb, site }) {
  return h(
    'header',
    { class: 'game-bar' },
    slab('Back', { fill: 'sugar', size: 'sm', badge: 'back', label: 'Back', onclick: onExit, focus: 'lobby' }),
    h(
      'div',
      { class: 'scores', 'aria-label': title },
      h('span', { class: `score score--you${aOn ? ' on' : ''}`, 'aria-label': `${a}: ${sa}` }, avatar(a, site, 'avatar avatar--sm'), h('b', { class: 'num' }, sa), h('span', {}, a)),
      h('span', { class: 'vs', 'aria-hidden': 'true' }, 'vs'),
      h('span', { class: `score score--them${bOn ? ' on' : ''}`, 'aria-label': `${b}: ${sb}` }, avatar(b, site, 'avatar avatar--sm'), h('b', { class: 'num' }, sb), h('span', {}, b))
    ),
    h('span', { class: 'bar-spacer', 'aria-hidden': 'true' })
  );
}

/* ---------------------------------- watch ----------------------------------- */

export function openWatch({ root, smashApi, id, onExit, onReplay }) {
  const sc = sdk(smashApi);
  let s = null;
  let cards = new Map();
  let err = null;
  let closed = false;
  let flash = new Set();

  const owners = (st) => new Map((st?.board ?? []).filter((t) => t.card).map((t) => [t.cell, `${t.card}:${t.owner}:${t.frozen ? 1 : 0}`]));

  async function loop() {
    try {
      cards = await deck(sc);
      s = await sc.games.watch(id);
      render();
      while (!closed && s.status !== 'finished' && s.status !== 'abandoned') {
        const before = owners(s);
        const next = await sc.games.follow(id, { since: s.moveCount, status: s.status, wait: 20 });
        if (closed) return;
        const after = owners(next);
        flash = new Set([...after].filter(([c, v]) => before.get(c) !== v).map(([c]) => c));
        s = next;
        render();
      }
    } catch (e) {
      err = errorText(e);
      render();
    }
  }

  function render() {
    if (closed) return;
    const a = seatName(s, 'A');
    const b = seatName(s, 'B');
    const over = s && (s.status === 'finished' || s.status === 'abandoned');
    let main = 'Loading the game…';
    if (err) main = err;
    else if (s?.status === 'waiting') main = `Waiting for ${s.openSeats?.length === 2 ? 'both players' : s.openSeats?.[0] === 'A' ? a : b} to take a seat…`;
    else if (s?.status === 'active') main = `${s.turn === 'A' ? a : b} to move`;
    else if (s?.status === 'abandoned') main = 'Called off.';
    else if (s?.status === 'finished') main = s.winner === 'draw' ? `A draw, ${s.score.A}–${s.score.B}.` : `${s.winner === 'A' ? a : b} wins, ${Math.max(s.score.A, s.score.B)}–${Math.min(s.score.A, s.score.B)}.`;
    root.replaceChildren(
      h(
        'section',
        { class: 'game', 'aria-label': 'Watching a game' },
        bar({ onExit, title: 'Score', a: a || 'Seat A', b: b || 'Seat B', aOn: s?.turn === 'A', bOn: s?.turn === 'B', sa: s?.score.A ?? 0, sb: s?.score.B ?? 0, site: smashApi }),
        h(
          'div',
          { class: 'game-body' },
          h('div', { class: 'play' }, h('div', { class: 'table' }, boardEl({ tiles: s?.board ?? [], mine: (o) => o === 'you', names: { mine: a, theirs: b }, cards, flash, label: `The board: ${a} in blue, ${b} in orange` }))),
          h(
            'aside',
            { class: 'panel' },
            h('span', { class: over ? 'pill pill--soft' : 'pill pill--live' }, over ? null : h('span', { class: 'dot' }), over ? 'Finished' : 'Watching live'),
            h('p', { class: 'status-main', role: 'status', 'aria-live': 'polite' }, main),
            s ? h('p', { class: 'status-detail' }, `Move ${s.moveCount}${s.lastMove ? ` · last: ${s.lastMove}` : ''} · ${s.ruleset === 'classic' ? 'Classic' : 'Mutators'} rules`) : null,
            over && s?.moveCount ? slab('Replay and review', { fill: 'sun', wide: true, onclick: () => onReplay(id), focus: 'replay' }) : null,
            h('p', { class: 'meta' }, 'Spectators see the public board only, never a hand. Each move arrives over a long-poll (games.follow).')
          )
        )
      )
    );
  }

  render();
  loop();
  return {
    close() {
      closed = true;
    },
  };
}

/* ---------------------------------- replay ---------------------------------- */

export function openReplay({ root, smashApi, id, url, onExit }) {
  const sc = sdk(smashApi);
  let r = null;
  let rv = null;
  let cards = new Map();
  let err = null;
  let step = 0;
  let playing = null;
  let closed = false;

  async function load() {
    try {
      cards = await deck(sc);
      [r, rv] = await Promise.all([url ? sc.replays.read(url) : sc.games.replay(id), (url ? sc.replays.review(url) : sc.games.review(id)).catch(() => null)]);
      step = r.moves.length;
      render();
    } catch (e) {
      err = errorText(e);
      render();
    }
  }

  const go = (n) => {
    if (!r) return;
    step = Math.max(0, Math.min(r.moves.length, n));
    render();
  };
  function toggle() {
    if (playing) {
      clearInterval(playing);
      playing = null;
    } else {
      if (step >= r.moves.length) step = 0;
      playing = setInterval(() => {
        if (step >= r.moves.length) return toggle();
        go(step + 1);
      }, 900);
    }
    render();
  }
  const onKey = (e) => {
    if (closed || !r || e.target.closest?.('input')) return;
    if (e.key === 'ArrowRight') go(step + 1);
    else if (e.key === 'ArrowLeft') go(step - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(r.moves.length);
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);

  function graph() {
    if (!rv?.graph?.length) return null;
    const n = rv.graph.length - 1 || 1;
    const W = 300;
    const H = 72;
    const y = (v) => H / 2 - (v / 6) * (H / 2 - 4);
    const pts = rv.graph.map((v, i) => `${((i / n) * W).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `M0,${H / 2} L${pts.replaceAll(' ', ' L')} L${W},${H / 2} Z`;
    const svg = h(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, class: 'evalgraph', role: 'img', 'aria-label': `Who was ahead, move by move: above the line ${nameOf('A')}, below ${nameOf('B')}` },
      h('rect', { x: '0', y: '0', width: String(W), height: String(H / 2), class: 'eval-a' }),
      h('rect', { x: '0', y: String(H / 2), width: String(W), height: String(H / 2), class: 'eval-b' }),
      h('path', { d: area, class: 'eval-area' }),
      h('path', { d: `M${pts.replaceAll(' ', ' L')}`, class: 'eval-line' }),
      h('rect', { x: String(((step / n) * W - 1.5).toFixed(1)), y: '0', width: '3', height: String(H), class: 'eval-now' })
    );
    svg.addEventListener('click', (e) => {
      const box = svg.getBoundingClientRect();
      go(Math.round(((e.clientX - box.left) / box.width) * n));
    });
    return svg;
  }

  // a practice game against the house: its seat wears the same persona it wore in the game
  const nameOf = (seat) => (r.players[seat] === 'Smash&Clash House' ? personaName(r.id ?? id ?? 'replay') : r.players[seat]);

  function render() {
    if (closed) return;
    const a = r ? nameOf('A') : 'Seat A';
    const b = r ? nameOf('B') : 'Seat B';
    const frame = r && step > 0 ? r.moves[step - 1] : null;
    const prev = r && step > 1 ? r.moves[step - 2] : null;
    const changed = new Set((frame?.board ?? []).filter((t) => t.card && !prev?.board.some((p) => p.cell === t.cell && p.card === t.card && p.owner === t.owner)).map((t) => t.cell));
    const rm = frame && rv ? rv.moves.find((m) => m.n === frame.n) : null;
    const over = r && step === r.moves.length;
    const result = r ? (r.winner === 'draw' ? `A draw, ${r.score.A}–${r.score.B}` : r.winner ? `${r.winner === 'A' ? a : b} won ${Math.max(r.score.A, r.score.B)}–${Math.min(r.score.A, r.score.B)}` : '') : '';
    root.replaceChildren(
      h(
        'section',
        { class: 'game', 'aria-label': 'Replay' },
        bar({ onExit, title: 'Score at this move', a, b, aOn: frame?.seat === 'A', bOn: frame?.seat === 'B', sa: frame?.score.A ?? 0, sb: frame?.score.B ?? 0, site: smashApi }),
        h(
          'div',
          { class: 'game-body' },
          h(
            'div',
            { class: 'play' },
            h('div', { class: 'table' }, boardEl({ tiles: frame?.board ?? [], mine: (o) => o === 'A', names: { mine: a, theirs: b }, cards, special: { chessTiles: r?.chessTiles ?? [] }, mark: changed, label: `Move ${step}: ${a} in blue, ${b} in orange` })),
            r
              ? h(
                  'div',
                  { class: 'scrub' },
                  h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'First move', onclick: () => go(0), disabled: step === 0 }, '⏮'),
                  h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous move', onclick: () => go(step - 1), disabled: step === 0 }, '◀'),
                  h('button', { class: 'iconbtn iconbtn--main', type: 'button', 'aria-label': playing ? 'Pause' : 'Play the moves', onclick: toggle }, playing ? '❚❚' : '▶'),
                  h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Next move', onclick: () => go(step + 1), disabled: step === r.moves.length }, '▶▶'),
                  h('input', { type: 'range', min: '0', max: String(r.moves.length), value: String(step), 'aria-label': 'Move', oninput: (e) => go(Number(e.target.value)) }),
                  h('span', { class: 'num scrub-n' }, `${step}/${r.moves.length}`)
                )
              : null
          ),
          h(
            'aside',
            { class: 'panel' },
            h('span', { class: 'pill pill--soft' }, url ? 'Shared replay' : 'Replay'),
            h('p', { class: 'status-main', role: 'status', 'aria-live': 'polite' }, err ?? (!r ? 'Loading the replay…' : frame ? `${frame.n}. ${frame.seat === 'A' ? a : b}: ${frame.name}` : 'The deal')),
            rm ? h('p', { class: `classchip tone-${CLASS_TONE[rm.class] ?? 'neutral'}` }, rv.classes?.[rm.class] ?? rm.class, rm.label && rm.label !== (rv.classes?.[rm.class] ?? rm.class) ? h('small', {}, ` · ${rm.label}`) : null) : null,
            frame?.captures ? h('p', { class: 'status-detail' }, `${frame.captures} ${frame.captures === 1 ? 'card' : 'cards'} captured`) : null,
            over && result ? h('p', { class: 'status-detail' }, result) : null,
            rv ? h('div', { class: 'review-mini' }, h('p', { class: 'review-mini__title' }, 'Game Review'), h('div', { class: 'acc' }, h('span', { class: 'acc__you' }, h('b', { class: 'num' }, `${Math.round(rv.accuracy.A)}%`), ` ${a}`), h('span', { class: 'acc__them' }, h('b', { class: 'num' }, `${Math.round(rv.accuracy.B)}%`), ` ${b}`)), graph(), h('p', { class: 'meta' }, [rv.turningPoint != null ? `Turning point: move ${rv.turningPoint}` : '', rv.biggestBlunder != null ? `biggest swing: move ${rv.biggestBlunder}` : ''].filter(Boolean).join(' · ') || 'Tap the graph to jump to a move.')) : null,
            r
              ? h(
                  'ol',
                  { class: 'moves moves--all' },
                  r.moves.map((m) => {
                    const c = rv?.moves.find((x) => x.n === m.n);
                    return h('li', { class: `${m.seat === 'A' ? 'you' : 'them'}${m.n === frame?.n ? ' now' : ''}` }, h('button', { type: 'button', onclick: () => go(m.n), 'aria-current': m.n === frame?.n ? 'step' : null }, h('span', { class: 'num' }, m.n), m.name, c && CLASS_TONE[c.class] !== 'neutral' && CLASS_TONE[c.class] !== 'good' ? h('i', { class: `tone-${CLASS_TONE[c.class]}` }, rv.classes?.[c.class] ?? c.class) : null));
                  })
                )
              : null,
            r?.replayUrl ? h('a', { class: 'more', href: r.replayUrl, target: '_blank', rel: 'noopener' }, icon('eye'), ' Open on smashandclash.in') : null,
            h('p', { class: 'meta meta--keys' }, 'Keyboard: ← and → step through the moves, Home and End jump.')
          )
        )
      )
    );
  }

  render();
  load();
  return {
    close() {
      closed = true;
      if (playing) clearInterval(playing);
      window.removeEventListener('keydown', onKey);
    },
  };
}
