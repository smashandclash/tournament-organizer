// Small DOM helpers shared by the lobby and the game: an element builder, the candy slab, the icons.

export const h = (tag, attrs = {}, ...kids) => {
  const el = tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'rect' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
};

/**
 * A candy slab: the game's button. One `sun` per screen (the primary action), `cherry` only for
 * something destructive, `mint` for done/success, `sugar` for everything quiet.
 * @param {string} label
 * @param {{ fill?: 'sun'|'sugar'|'mint'|'sky'|'gum'|'grape'|'cherry', size?: 'hero'|'md'|'sm', pill?: string, icon?: string, badge?: string, wide?: boolean, href?: string, focus?: string, disabled?: boolean, onclick?: Function, label?: string, sub?: string }} o
 */
export function slab(label, o = {}) {
  const cls = ['jb', `jb--${o.fill ?? 'sugar'}`, o.size === 'hero' && 'jb--hero', o.size === 'sm' && 'jb--sm', o.wide && 'jb--wide'].filter(Boolean).join(' ');
  const face = h(
    'span',
    { class: 'jb__face' },
    o.badge ? h('span', { class: 'jb__badge', 'aria-hidden': 'true' }, icon(o.badge)) : null,
    o.icon ? h('span', { class: 'jb__ico', 'aria-hidden': 'true' }, icon(o.icon)) : null,
    h('span', { class: 'jb__text' }, h('span', { class: 'jb__label' }, label, o.sub ? h('small', {}, o.sub) : null), o.pill ? h('span', { class: 'jb__pill' }, o.pill) : null)
  );
  if (o.href) return h('a', { class: cls, href: o.href, target: o.href.startsWith('http') ? '_blank' : null, rel: o.href.startsWith('http') ? 'noopener' : null, 'data-focus': o.focus }, face);
  return h('button', { class: cls, type: 'button', disabled: o.disabled, onclick: o.onclick, 'aria-label': o.label, 'data-focus': o.focus ?? `slab-${label}` }, face);
}

const PATHS = {
  play: 'M8 5.5v13l11-6.5z',
  book: 'M5 4.5h9a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3zM17 7.5V20M8.5 9h5M8.5 12.5h5',
  film: 'M4 5h16v14H4zM4 9h16M4 15h16M8 5v4M8 15v4M16 5v4M16 15v4',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4v3h-4z',
  coins: 'M12 4c4 0 7 1.3 7 3s-3 3-7 3-7-1.3-7-3 3-3 7-3zM5 7v5c0 1.7 3 3 7 3s7-1.3 7-3V7M5 12v5c0 1.7 3 3 7 3s7-1.3 7-3v-5',
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v4M4 7.5V17a2 2 0 0 0 2 2h13V9H6.5A2.5 2.5 0 0 1 4 6.5M15.5 14h1',
  shield: 'M12 3.5l7 3v5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9v-5z M9 12l2 2 4-4',
  back: 'M14.5 6l-6 6 6 6',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  plus: 'M12 5v14M5 12h14',
  home: 'M4 11.5 12 5l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.5H9v5.5H5.5A1.5 1.5 0 0 1 4 19z',
  ranks: 'M9 20V9.5h6V20M3.5 20v-6.5H9M15 20v-9h5.5V20M2.5 20h19M12 3.5l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z',
  swords: 'M5 4l9.5 9.5M4 5l1-1M14.5 13.5l-2 2 4 4 2-2zM19 4l-9.5 9.5M20 5l-1-1M9.5 13.5l2 2-4 4-2-2z',
  close: 'M6 6l12 12M18 6 6 18',
  code: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15',
  target: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11.3a.7.7 0 1 0 0 1.4.7.7 0 0 0 0-1.4z',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  spark: 'M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9zM18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6.5 6.5 0 0 1 3.5 6',
  chevron: 'M9.5 6l6 6-6 6',
};

export function icon(name) {
  const filled = name === 'play';
  return h('svg', { viewBox: '0 0 24 24', width: '24', height: '24', fill: filled ? 'currentColor' : 'none', stroke: filled ? 'none' : 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' }, h('path', { d: PATHS[name] ?? PATHS.plus }));
}

/* champions: every player and tournament wears one, picked from its wallet / name (stable) */
const CHAMPIONS = ['01_Pengu', '02_Luna', '03_Noodle', '04_Tina', '05_Lizzie', '06_Baa-Baa', '07_Shadow', '08_Vega', '09_Nevermore', '10_Mr_Nibbles', '11_Lifafa', '12_Stripes', '13_Jasper', '14_Stella', '15_Stello', '16_Amber', '17_Po', '18_Mr_Lollihops', '19_Cornelius', '20_Shelly'];
export function champion(seed, site) {
  let a = 2166136261;
  for (const ch of String(seed)) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  const file = CHAMPIONS[(a >>> 0) % CHAMPIONS.length];
  return { name: file.replace(/^\d+_/, '').replaceAll('_', ' '), art: `${site}/Characters-webp/${file}.webp`, card: `${site}/Cards-webp/${file}.webp` };
}

/** A champion by its card id (1-20), e.g. the one an agent plays as. */
export function championById(id, site) {
  const file = CHAMPIONS[(Number(id) - 1 + CHAMPIONS.length) % CHAMPIONS.length] ?? CHAMPIONS[0];
  return { name: file.replace(/^\d+_/, '').replaceAll('_', ' '), art: `${site}/Characters-webp/${file}.webp`, card: `${site}/Cards-webp/${file}.webp` };
}

export function avatar(seed, site, cls = 'avatar') {
  const c = champion(seed, site);
  return h('span', { class: cls, 'aria-hidden': 'true' }, h('img', { src: c.art, alt: '', loading: 'lazy', draggable: 'false' }));
}

/** Redraw without losing keyboard focus: refocus the element with the same data-focus (or role and label). */
export function keepFocus(root, draw) {
  const a = document.activeElement;
  const key = (e) => e.getAttribute('data-focus') ?? `${e.tagName}|${e.getAttribute('href') ?? ''}|${e.textContent}`;
  const k = a && a !== document.body && root.contains(a) ? key(a) : null;
  draw();
  if (k) [...root.querySelectorAll('button, a, [tabindex]')].find((e) => key(e) === k)?.focus();
}
