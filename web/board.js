// The board, drawn from any of the SDK's board shapes: a player's view (owner you/opponent), the public
// board a spectator sees (the same, from seat A), or a replay frame (owner A/B). One renderer for all three.

import { h } from './ui.js';

export const COLS = 'ABCDE';
const PIECE = { knight: '♞', bishop: '♝', rook: '♜', queen: '♛' };

/** Cells in screen order. Your side nearest you: seat A sees row 3 at the top; seat B the board turned round. */
export function cellOrder(flip) {
  const rows = flip ? [1, 2, 3] : [3, 2, 1];
  const cols = flip ? [...COLS].reverse() : [...COLS];
  return rows.flatMap((r) => cols.map((c) => `${c}${r}`));
}

/**
 * @param {{
 *   tiles: Array<{cell:string, card?:string, owner?:string, frozen?:boolean}>,
 *   mine: (owner:string) => boolean,        which owner is drawn blue (the viewer, or seat A)
 *   names?: { mine: string, theirs: string },
 *   cards: Map<string, {image:string}>,
 *   flip?: boolean,
 *   special?: { chessTiles?: Array<{cell,piece}>, powerTiles?: Array<{cell,color,boost}>, overrunZones?: string[] },
 *   mutators?: boolean,
 *   lit?: Set<string>, path?: string[], flash?: Set<string>, mark?: Set<string>,
 *   onCell?: (cell:string) => void,
 *   label?: string,
 * }} o
 */
export function boardEl(o) {
  const tiles = new Map(o.tiles.map((t) => [t.cell, t]));
  const chess = new Map((o.special?.chessTiles ?? []).map((t) => [t.cell, t.piece]));
  const power = new Map((o.special?.powerTiles ?? []).map((t) => [t.cell, t]));
  const overrun = new Set(o.mutators ? o.special?.overrunZones ?? [] : []);
  const lit = o.lit ?? new Set();
  const path = o.path ?? [];
  const flash = o.flash ?? new Set();
  const mark = o.mark ?? new Set();
  const names = o.names ?? { mine: 'blue', theirs: 'orange' };
  const interactive = !!o.onCell;
  return h(
    'div',
    { class: 'board', role: interactive ? 'grid' : 'img', 'aria-label': o.label ?? 'The board' },
    cellOrder(o.flip).map((cell) => {
      const t = tiles.get(cell);
      const p = power.get(cell);
      const piece = chess.get(cell);
      const art = t?.card && o.cards.get(t.card)?.image;
      const mine = t?.card ? o.mine(t.owner) : null;
      const isLit = lit.has(cell);
      const label = [
        cell,
        t?.card ? `${t.card}, ${mine ? names.mine : names.theirs}${t.frozen ? ', frozen' : ''}` : 'empty',
        piece ? `${piece} tile` : '',
        p ? `+${p.boost} ${p.color} power tile` : '',
        isLit ? 'you can play here' : '',
      ].filter(Boolean).join(', ');
      const cls = ['tile', mine === true && 'mine', mine === false && 'theirs', isLit && 'lit', path.includes(cell) && 'picked', (flash.has(cell) || mark.has(cell)) && 'flash', overrun.has(cell) && 'overrun', p && `power-${p.color}`].filter(Boolean).join(' ');
      const kids = [
        art ? h('img', { src: art, alt: '', class: mine === false ? 'turned' : '', draggable: 'false' }) : h('span', { class: 'coord' }, cell),
        t?.frozen ? h('span', { class: 'frost' }, 'FROZEN') : null,
        piece ? h('span', { class: 'badge piece', title: piece }, PIECE[piece] ?? '♟') : null,
        p ? h('span', { class: 'badge boost' }, `+${p.boost}`) : null,
      ];
      return interactive
        ? h('button', { class: cls, type: 'button', 'aria-label': label, 'aria-disabled': isLit ? null : 'true', 'data-focus': `tile-${cell}`, onclick: () => o.onCell(cell) }, kids)
        : h('div', { class: cls, 'aria-hidden': 'true' }, kids);
    })
  );
}
