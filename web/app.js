// Tournament Organizer: the app. A shell (appbar, nav, dock) around views kept in the URL
// (#/ home, #/events, #/practice, #/ranks, #/matches, #/wallet, #/rules, #/sdk) and full-screen layers:
// a tournament match (#/match), a practice game (#/play), a live game (#/watch/<id>), a replay (#/replay/<id>).
// The tournament is decided on the organizer's server; everything else talks to Smash&Clash through the SDK.

import { balances, base58, connectStandard, fromBase64, installedWallets, testWallet } from './wallet.js';
import { PRACTICE, openGame } from './game.js';
import { openReplay, openWatch } from './watch.js';
import { SDK_VERSION, deck, errorText, practiceRecord, rules, sdk, seatName, strengthFor } from './sdk.js';
import { avatar, champion, championById, h, icon, keepFocus, slab } from './ui.js';

const $ = (sel) => document.querySelector(sel);

let T = null; // the tournament, as /api/tournament says
let wallet = null; // the connected wallet (wallet.js)
let bal = null;
let busy = null;
let toast = null;
let layer = null; // the open full-screen layer: { key, handle }
let pendingPractice = null; // a practice game to start when #/play opens
let pendingReplayUrl = null; // a shared replay link to open at #/replay/link
let lastBalanceAt = 0;
const drawn = {}; // region -> the state it was last drawn from (redraw only on change)

const ROUTES = {
  '/': { title: 'Home', short: 'Home', icon: 'home', view: homeView },
  '/events': { title: 'Tournaments', short: 'Events', icon: 'trophy', view: eventsView },
  '/practice': { title: 'Practice', short: 'Practice', icon: 'target', view: practiceView, wide: true, live: true },
  '/ranks': { title: 'Leaderboard', short: 'Ranks', icon: 'ranks', view: ranksView },
  '/matches': { title: 'Matches', short: 'Matches', icon: 'swords', view: matchesView, live: true },
  '/wallet': { title: 'Wallet', short: 'Wallet', icon: 'wallet', view: walletView },
  '/rules': { title: 'How it works', short: 'Rules', icon: 'book', view: rulesView, wide: true },
  '/sdk': { title: 'Built with the SDK', short: 'SDK', icon: 'code', view: sdkView, wide: true, live: true },
};
/** The route: a view (#/ranks) or a full-screen layer (#/match, #/play, #/watch/<id>, #/replay/<id>). */
function route() {
  const p = location.hash.replace(/^#/, '') || '/';
  let m;
  if (p === '/match' || p === '/play') return { layer: p.slice(1) };
  if ((m = /^\/watch\/(g_[\w-]{4,40})$/.exec(p))) return { layer: 'watch', id: m[1] };
  if ((m = /^\/replay\/(g_[\w-]{4,40})$/.exec(p))) return { layer: 'replay', id: m[1] };
  if (p === '/replay/link') return { layer: 'replay-link' };
  return { view: ROUTES[p] ? p : '/' };
}
const path = () => route().view ?? '/';
const sc = () => sdk(T.smashApi);

/* --------------------------- SDK data for the views ------------------------- */
// Views that show live Smash&Clash data (agent profiles, open duels, live games, the deck) read it through
// this cache: the first read starts the request, the view redraws when it lands, it refreshes after `ttl`.
const cache = new Map();
let remoteVersion = 0;
function remote(key, ttl, fetcher) {
  let c = cache.get(key);
  if (!c || (!c.pending && Date.now() - c.at > ttl)) {
    c = { at: Date.now(), value: c?.value, error: null, pending: true };
    cache.set(key, c);
    const entry = c;
    fetcher()
      .then(
        (v) => ((entry.value = v), (entry.error = null)),
        (e) => (entry.error = errorText(e))
      )
      .finally(() => {
        entry.pending = false;
        entry.at = Date.now();
        remoteVersion++;
        render();
      });
  }
  return c;
}

/* ----------------------------------- api ----------------------------------- */

async function api(p, body) {
  const res = await fetch(p, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

async function refresh() {
  try {
    T = await api('/api/tournament');
    if (wallet && T.me && T.me.wallet !== wallet.address) await signOut(true); // another wallet's session
    if (wallet && Date.now() - lastBalanceAt > 15_000) {
      lastBalanceAt = Date.now();
      balances(T.rpc, wallet.address, T.mint).then((b) => ((bal = b), render())).catch(() => {});
    }
  } catch (e) {
    say(`Could not reach the tournament server: ${e.message}`, true);
  }
  render();
}

async function act(label, fn) {
  if (busy) return;
  busy = label;
  render();
  try {
    await fn();
  } catch (e) {
    say(e.message ?? String(e), true);
  } finally {
    busy = null;
    await refresh();
  }
}

function say(text, bad = false, link = null) {
  toast = { text, bad, link, id: Math.random() };
  const mine = toast.id;
  $('#toast').replaceChildren(h('div', { class: bad ? 'toast bad' : 'toast', role: bad ? 'alert' : 'status' }, text, link ? [' ', h('a', { href: link, target: '_blank', rel: 'noopener' }, 'View on the explorer')] : null));
  setTimeout(() => {
    if (toast?.id === mine) {
      toast = null;
      $('#toast').replaceChildren();
    }
  }, bad ? 7000 : 4500);
}

/* --------------------------------- sheets ---------------------------------- */

/** Open the sheet (a bottom sheet on phones, a dialog from 768px) with this content. */
function sheet(title, ...content) {
  const dlg = $('#sheet');
  dlg.replaceChildren(h('div', { class: 'sheet-panel' }, h('span', { class: 'sheet-grip', 'aria-hidden': 'true' }), h('h2', { id: 'sheet-title', class: 'ribbon' }, h('span', {}, title)), ...content));
  if (!dlg.open) dlg.showModal();
  return dlg;
}
const closeSheet = () => $('#sheet').open && $('#sheet').close();
$('#sheet').addEventListener('click', (e) => e.target === e.currentTarget && closeSheet()); // a tap on the backdrop

function chooseWallet() {
  const list = installedWallets(T.cluster);
  const items = [
    ...list.map((w) => ({ name: w.name, icon: w.icon, pick: () => connectStandard(w, { cluster: T.cluster, rpcUrl: T.rpc }) })),
    ...(T.cluster !== 'mainnet-beta' ? [{ name: 'Test wallet', note: 'Kept in this browser. Devnet only: free test tokens, nothing of value.', pick: async () => testWallet({ cluster: T.cluster, rpcUrl: T.rpc }) }] : []),
  ];
  sheet(
    'Connect a wallet',
    h('p', { class: 'muted caption' }, 'Signing in is free: you sign a message that proves the wallet is yours. It moves nothing.'),
    h(
      'ul',
      { class: 'wallet-list' },
      items.map((it, i) => {
        const b = slab(it.name, {
          fill: i === 0 ? 'sky' : 'sugar',
          wide: true,
          sub: it.note,
          onclick: () => {
            closeSheet();
            act('Connecting…', async () => {
              wallet = await it.pick();
              await signIn();
            });
          },
        });
        b.querySelector('.jb__face').prepend(it.icon ? h('img', { src: it.icon, alt: '' }) : h('span', { class: 'wallet-dot', 'aria-hidden': 'true' }));
        return h('li', {}, b);
      }),
      list.length ? null : h('li', { class: 'muted caption' }, T.cluster === 'mainnet-beta' ? 'No Solana wallet found. Install Phantom, Solflare or Backpack.' : 'No wallet extension found. Use the test wallet, or install Phantom or Solflare and switch it to devnet.')
    ),
    h('div', { class: 'sheet-actions' }, h('button', { class: 'textbtn', type: 'button', onclick: closeSheet }, 'Cancel'))
  );
}

function rename() {
  const input = h('input', { id: 'name', name: 'name', value: T.me?.name ?? '', maxlength: '16', minlength: '2', autocomplete: 'nickname', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'done', required: true });
  const form = h(
    'form',
    {
      class: 'field',
      onsubmit: (e) => {
        e.preventDefault();
        closeSheet();
        act('Saving…', async () => {
          await api('/api/me/name', { name: input.value });
          say('Name saved.');
        });
      },
    },
    h('label', { for: 'name' }, 'Your name in this tournament'),
    input,
    h('small', {}, '2 to 16 letters, digits, spaces, _ . or -'),
    h('div', { class: 'sheet-actions' }, h('button', { class: 'textbtn', type: 'button', onclick: closeSheet }, 'Cancel'), slab('Save', { fill: 'sun', size: 'sm' }))
  );
  form.querySelector('.jb').type = 'submit';
  sheet('Rename', form);
  input.select();
}

/* --------------------------------- wallets --------------------------------- */

async function signIn() {
  const { message: text } = await api('/api/auth/nonce', { wallet: wallet.address });
  const sig = await wallet.signMessage(new TextEncoder().encode(text));
  await api('/api/auth/verify', { wallet: wallet.address, message: text, signature: base58(sig) });
  lastBalanceAt = 0;
}

async function signOut(quiet) {
  await api('/api/auth/signout', {}).catch(() => {});
  await wallet?.disconnect?.();
  wallet = null;
  bal = null;
  if (!quiet) await refresh();
}

/* --------------------------------- entering -------------------------------- */

/** Before the first paid entry where it matters: the organizer's minimum age, and who runs the tournament. */
function enter() {
  const key = `snc-tournament:age-${T.rules.minAge}`;
  let ok = false;
  try {
    ok = !T.rules.ageCheck || localStorage.getItem(key) === '1';
  } catch {}
  if (ok) return payEntry();
  const box = h('input', { type: 'checkbox', id: 'adult', required: true });
  const form = h(
    'form',
    {
      class: 'field',
      onsubmit: (e) => {
        e.preventDefault();
        try {
          localStorage.setItem(key, '1');
        } catch {}
        closeSheet();
        payEntry();
      },
    },
    h('label', { class: 'check', for: 'adult' }, box, h('span', {}, `I am ${T.rules.minAge} or older, at least the age the law where I live requires, and allowed to enter this tournament where I am.`)),
    h('small', {}, `${T.organizer ? `${T.name} is run by ${T.organizer}` : 'This tournament is run by its organizer'}, not by Smash&Clash. Entry fees and prizes are in $SMASH and are held and paid by the organizer; Smash&Clash is not responsible for this tournament or anything that goes wrong in it.`),
    h('div', { class: 'sheet-actions' }, h('button', { class: 'textbtn', type: 'button', onclick: closeSheet }, 'Cancel'), slab(`Enter · ${T.fee} ${coin()}`, { fill: 'sun', size: 'sm' }))
  );
  form.querySelector('.jb').type = 'submit';
  sheet('Before you enter', form);
}

/** Pay one match's fee: the server builds the transfer, the wallet signs and sends it, the server checks the chain. */
function payEntry() {
  act('Preparing your entry…', async () => {
    const { entry, transaction, message: msg } = await api('/api/entries', {});
    busy = 'Approve the payment in your wallet…';
    render();
    const signature = await wallet.signAndSend({ transaction: fromBase64(transaction), message: fromBase64(msg) });
    busy = 'Confirming on chain…';
    render();
    for (let i = 0; ; i++) {
      const r = await api(`/api/entries/${entry.id}/confirm`, { signature });
      if (!r.pending) break;
      if (i > 40) throw new Error('The payment has not confirmed yet. It will still count once it lands; check back in a minute.');
      await new Promise((res) => setTimeout(res, 1500)); // 202: not on chain yet
    }
    lastBalanceAt = 0;
    say('You are in. Finding you an opponent…');
  });
}

const cancel = (id) => act('Cancelling…', async () => {
  const e = await api(`/api/entries/${id}/cancel`, {});
  say(e.status === 'refund-due' ? 'You left the queue. Your fee is on its way back.' : 'Cancelled.');
});

const faucet = () => act('Sending test tokens…', async () => {
  const r = await api('/api/dev/faucet', {});
  lastBalanceAt = 0;
  say(`Sent ${r.tokens} test $SMASH and ${r.sol} SOL for network fees.`, false, r.explorer);
});

/* ---------------------------------- layers --------------------------------- */

const play = () => (location.hash = '#/match');
const back = () => (history.length > 1 ? history.back() : (location.hash = '#/'));

function showLayer(key, make) {
  if (layer?.key === key) return;
  hideLayer(false);
  $('#app').inert = true;
  $('#game').hidden = false;
  $('#game').scrollTop = 0;
  layer = { key, handle: make($('#game')) };
}

function hideLayer(again = true) {
  if (!layer) return;
  layer.handle.close();
  layer = null;
  $('#game').hidden = true;
  $('#game').replaceChildren();
  $('#app').inert = false;
  if (again) refresh();
}

const gameEvents = (kind, data) => {
  if (kind === 'over') setTimeout(refresh, 4000);
  if (kind === 'replay') location.hash = `#/replay/${data}`;
  if (kind === 'again') startPractice(data);
};

/** Open the layer a route names. false: it cannot open (nothing to show), so the route falls back. */
function openLayer(r) {
  const smashApi = T.smashApi;
  if (r.layer === 'match') {
    const c = T.me?.current;
    if (!c && !layer?.key.startsWith('match:')) return false;
    if (c) showLayer(`match:${c.id}`, (root) => openGame({ root, smashApi, onExit: back, onEvent: gameEvents, source: { kind: 'tournament', matchId: c.id, invite: c.invite, moveTimeoutMinutes: T.rules.moveTimeoutMinutes } }));
  } else if (r.layer === 'play') {
    if (pendingPractice) {
      const src = pendingPractice;
      pendingPractice = null;
      showLayer(`play:${Date.now()}`, (root) => openGame({ root, smashApi, onExit: back, onEvent: gameEvents, source: src }));
    } else if (!layer?.key.startsWith('play:')) {
      const saved = savedPractice();
      if (!saved) return false;
      showLayer(`play:${saved.id}`, (root) => openGame({ root, smashApi, onExit: back, onEvent: gameEvents, source: { kind: 'practice', mode: saved.mode, strength: saved.strength, resume: { id: saved.id, token: saved.token } } }));
    }
  } else if (r.layer === 'watch') {
    showLayer(`watch:${r.id}`, (root) => openWatch({ root, smashApi, id: r.id, onExit: back, onReplay: (id) => (location.hash = `#/replay/${id}`) }));
  } else if (r.layer === 'replay') {
    showLayer(`replay:${r.id}`, (root) => openReplay({ root, smashApi, id: r.id, onExit: back }));
  } else if (r.layer === 'replay-link') {
    if (pendingReplayUrl) {
      const url = pendingReplayUrl;
      pendingReplayUrl = null;
      showLayer(`replay-link:${url}`, (root) => openReplay({ root, smashApi, url, onExit: back }));
    } else if (!layer?.key.startsWith('replay-link:')) return false;
  }
  return true;
}

/* --------------------------------- practice -------------------------------- */
// Free games that never count for the tournament, each one a different way into a game with the SDK.

function savedPractice() {
  try {
    return JSON.parse(localStorage.getItem(PRACTICE) ?? 'null');
  } catch {
    return null;
  }
}

/** The saved practice game, if it is still being played (one that ended while its screen was closed is dropped). */
function livePractice() {
  const saved = savedPractice();
  if (!saved) return null;
  const st = remote(`saved:${saved.id}`, 30_000, () => sc().games.watch(saved.id));
  if (st.value && (st.value.status === 'finished' || st.value.status === 'abandoned')) {
    try {
      localStorage.removeItem(PRACTICE);
    } catch {}
    return null;
  }
  return saved;
}

function startPractice(mode, extra = {}) {
  const strength = strengthFor(practiceRecord().rating);
  const opts = { name: T.me?.name ?? 'Guest', as: 'person', ruleset: T.ruleset };
  const starters = {
    house: (c) => c.games.startHouse({ ...opts, strength }), // an opponent at your level (an ELO)
    quick: (c) => c.games.quickMatch({ ...opts, opponent: 'any' }), // whoever is online
    invite: (c) => c.games.createDuel({ ...opts, opponent: 'person' }), // a friend, by link
    code: (c) => c.games.createDuel(opts), // an AI agent, by a 6-letter code
    join: (c) => c.games.joinDuel(extra.code, { name: opts.name, as: 'person' }), // someone's duel, by code
  };
  pendingPractice = { kind: 'practice', mode, start: starters[mode], strength: mode === 'house' ? strength : null };
  if (route().layer === 'play') {
    hideLayer(false);
    render();
  } else location.hash = '#/play';
}

function joinByCode() {
  const input = h('input', { id: 'code', name: 'code', maxlength: '6', minlength: '6', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go', pattern: '[A-Za-z2-9]{6}', required: true, placeholder: 'K7QF2M' });
  const form = h(
    'form',
    {
      class: 'field',
      onsubmit: (e) => {
        e.preventDefault();
        closeSheet();
        startPractice('join', { code: input.value.trim().toUpperCase() });
      },
    },
    h('label', { for: 'code' }, 'Duel code'),
    input,
    h('small', {}, 'The 6-letter code someone (or an AI agent) gave you.'),
    h('div', { class: 'sheet-actions' }, h('button', { class: 'textbtn', type: 'button', onclick: closeSheet }, 'Cancel'), slab('Join', { fill: 'sun', size: 'sm' }))
  );
  form.querySelector('.jb').type = 'submit';
  sheet('Join with a code', form);
  input.focus();
}

function openReplayLink() {
  const input = h('input', { id: 'rlink', name: 'rlink', type: 'url', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go', required: true, placeholder: 'https://www.smashandclash.in/replay#z=…' });
  const form = h(
    'form',
    {
      class: 'field',
      onsubmit: (e) => {
        e.preventDefault();
        closeSheet();
        pendingReplayUrl = input.value.trim();
        location.hash = '#/replay/link';
      },
    },
    h('label', { for: 'rlink' }, 'Replay link'),
    input,
    h('small', {}, 'Any shared Smash&Clash replay link: the whole game travels inside it.'),
    h('div', { class: 'sheet-actions' }, h('button', { class: 'textbtn', type: 'button', onclick: closeSheet }, 'Cancel'), slab('Open', { fill: 'sun', size: 'sm' }))
  );
  form.querySelector('.jb').type = 'submit';
  sheet('Open a replay link', form);
  input.focus();
}

/* ------------------------------ agent challenges ---------------------------- */
// A Hosted Agent Challenge (powered by AgentsORG): the SDK mints a link, you play the agent on
// smashandclash.in, and the app reads the result back with challenges.get().

const CHALLENGE = 'snc-tournament:challenge';
const AGENTS = ['poke', 'claude'];
function savedChallenge() {
  try {
    return JSON.parse(localStorage.getItem(CHALLENGE) ?? 'null');
  } catch {
    return null;
  }
}
function saveChallenge(c) {
  try {
    if (c) localStorage.setItem(CHALLENGE, JSON.stringify(c));
    else localStorage.removeItem(CHALLENGE);
  } catch {}
}
function challengeAgent(slug) {
  const tab = window.open('about:blank', '_blank'); // opened on the tap (no popup blocker), filled in once the link is minted
  act('Minting your challenge…', async () => {
    try {
      const ch = await sc().challenges.create({ agent: slug, challenger: T.me?.name ?? 'Guest', ruleset: T.ruleset });
      saveChallenge({ token: ch.token, url: ch.url, agent: ch.agent.name, slug, expiresAt: ch.expiresAt, status: 'pending', result: null });
      if (tab) tab.location.href = ch.url;
      else window.location.assign(ch.url);
      say(`Challenge ready. Play ${ch.agent.name} in the new tab; the result shows up here.`);
    } catch (e) {
      tab?.close();
      throw e;
    }
  });
}

/* ---------------------------------- words ---------------------------------- */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const short = (w) => (w && w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);
const skew = () => (T ? T.now - Date.now() : 0);
const serverNow = () => Date.now() + skew();
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return d ? `${d}d ${hh}h ${mm}m` : hh ? `${hh}h ${mm}m ${String(ss).padStart(2, '0')}s` : `${mm}m ${String(ss).padStart(2, '0')}s`;
}
const REASON = { 'no-show': 'no-show', stalled: 'out of time', 'agent-seat': 'agent seat', deadline: 'time ran out', closed: 'tournament ended', abandoned: 'called off' };
const coin = () => T.token.replace('test ', '');

function phasePill(t) {
  if (t.phase === 'open') return h('span', { class: 'pill pill--live' }, h('span', { class: 'dot' }), 'Live');
  if (t.phase === 'upcoming') return h('span', { class: 'pill' }, 'Coming up');
  if (t.phase === 'closing') return h('span', { class: 'pill' }, 'Final matches');
  return h('span', { class: 'pill pill--soft' }, 'Finished');
}

function clockText(t = T) {
  if (!t) return ['', ''];
  if (t.phase === 'upcoming') return ['Starts in', span(t.startsAt - serverNow())];
  if (t.phase === 'open') return ['Ends in', span(t.endsAt - serverNow())];
  if (t.phase === 'closing') return ['Entries closed', 'finishing up'];
  return ['Tournament', 'over'];
}

/** What the one primary action is right now: shown in the dock (phones, tablets) and the sidebar (desktop). */
function primary() {
  const t = T;
  const tok = t.token;
  if (!wallet || !t.me) {
    return { note: t.phase === 'open' ? `${t.fee} ${tok} per match · winner takes all` : null, slab: slab('Play', { fill: 'sun', size: 'hero', badge: 'play', pill: t.phase === 'open' ? 'Connect a wallet' : t.phase === 'upcoming' ? 'Opens soon' : 'Entries closed', onclick: chooseWallet, disabled: !!busy || t.phase !== 'open', focus: 'primary' }) };
  }
  const me = t.me;
  const cur = me.current;
  const queued = me.entries.find((e) => e.status === 'queued');
  const low = bal && bal.tokens < Number(t.fee);
  if (cur) {
    const by = new Date(cur.showUpBy - skew()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { note: cur.status === 'waiting' ? `Take your seat by ${by}, or it is a forfeit` : 'Your match is on', slab: slab(cur.status === 'active' ? 'Resume' : 'Play now', { fill: 'sun', size: 'hero', badge: 'play', pill: `vs ${cur.opponent}`, onclick: play, focus: 'primary' }) };
  }
  if (queued) {
    return { note: h('span', {}, h('span', { class: 'pill pill--live' }, h('span', { class: 'dot' }), 'In the queue'), ' Finding an opponent…'), slab: slab('Leave the queue', { fill: 'sugar', wide: true, pill: 'Full refund', onclick: () => cancel(queued.id), disabled: !!busy, focus: 'primary' }) };
  }
  if (t.phase === 'open') {
    const faucetBtn = t.devFaucet && low ? h('button', { class: 'textbtn', type: 'button', onclick: faucet, disabled: !!busy }, 'Get test tokens') : null;
    return {
      note: busy ?? (t.blocked ? 'Entering is not available in your region.' : low ? [`You need ${t.fee} ${tok}`, faucetBtn] : `${t.fee} ${tok} goes into the pool`),
      slab: slab('Play', { fill: 'sun', size: 'hero', badge: 'play', pill: `Enter · ${t.fee} ${coin()}`, onclick: enter, disabled: !!busy || t.blocked || low, focus: 'primary' }),
    };
  }
  return { note: null, slab: slab('Play', { fill: 'sun', size: 'hero', badge: 'play', pill: t.phase === 'upcoming' ? 'Opens soon' : 'Entries closed', disabled: true, focus: 'primary' }) };
}

/* ---------------------------------- render --------------------------------- */

/** Redraw one region of the shell, only when its inputs changed, without losing keyboard focus. */
function region(name, el, key, build) {
  if (drawn[name] === key) return;
  drawn[name] = key;
  keepFocus(el, () => el.replaceChildren(...[build()].flat().filter(Boolean)));
}

/** A look and a platform name: THEME / BRAND_NAME on the server, or ?theme= / ?brand= to preview one. */
function applyLook() {
  const q = new URLSearchParams(location.search);
  const theme = (q.get('theme') || T.theme || '').replace(/[^a-z]/g, '');
  const brand = (q.get('brand') || T.brand || '').slice(0, 28);
  const html = document.documentElement;
  if (theme) html.dataset.theme = theme;
  else delete html.dataset.theme;
  html.classList.toggle('has-brand', !!brand);
  for (const el of document.querySelectorAll('.brand-word')) el.textContent = brand;
  const initials = brand.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  for (const el of document.querySelectorAll('.brand-badge')) el.textContent = initials;
  window.__brand = brand;
}

function render() {
  if (!T) return;
  applyLook();
  const r = route();
  if (r.layer) {
    if (openLayer(r)) return;
    history.replaceState(null, '', r.layer === 'play' ? '#/practice' : r.layer === 'replay-link' ? '#/matches' : '#/');
  } else if (layer) hideLayer();
  const view = ROUTES[path()];
  document.title = `${view.title} · ${window.__brand || 'Tournament Organizer'}`;
  $('#view-title').textContent = view.title;
  const base = JSON.stringify([{ ...T, now: 0 }, busy, bal, wallet?.address]);
  renderNav(path());
  const pk = JSON.stringify([T.me?.current, T.me?.entries?.find((e) => e.status === 'queued')?.id, T.phase, T.fee, T.blocked, busy, !!wallet, !!T.me, bal?.tokens, T.devFaucet]);
  region('dock', $('#dock'), pk, dockContent);
  region('foot', $('#nav-foot'), pk + JSON.stringify([T.me?.name, T.me?.standing, T.cluster]), sideFoot);
  region('bar', $('#appbar-actions'), JSON.stringify([T.cluster, T.me?.name, T.me?.wallet, bal?.tokens, busy === 'Connecting…', !!wallet]), appbarActions);
  // views with live Smash&Clash data redraw when it lands, and every 15 s to refresh it
  const live = view.live ? `|${Math.floor(Date.now() / 15000)}` : '';
  region('view', $('#view'), `${path()}${base}|${remoteVersion}${live}`, () => h('div', { class: 'view-inner' }, view.view()));
}

function renderNav(p) {
  const ul = $('#nav-items');
  if (!ul.childElementCount) {
    ul.replaceChildren(
      ...Object.entries(ROUTES).map(([href, r]) =>
        h('li', { class: r.wide ? 'nav-li--wide' : null }, h('a', { class: 'nav-item', href: `#${href}`, 'data-route': href }, icon(r.icon), h('span', { class: 'short' }, r.short), h('span', { class: 'long' }, r.title)))
      )
    );
  }
  for (const a of ul.querySelectorAll('a')) {
    if (a.dataset.route === p) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function dockContent() {
  const pr = primary();
  return [pr.note ? h('div', { class: 'dock-note' }, pr.note) : null, pr.slab];
}

function sideFoot() {
  const pr = primary();
  const me = T.me;
  return [
    h('span', { class: 'pill pill--glass' }, T.cluster === 'mainnet-beta' ? 'Solana' : `Solana ${T.cluster} · test tokens`),
    wallet && me
      ? h('div', { class: 'side-me' }, h('a', { class: 'who', href: '#/wallet' }, avatar(me.wallet, T.smashApi, 'avatar avatar--sm'), h('div', {}, h('b', {}, me.name), h('span', { class: 'num' }, bal ? `${bal.tokens.toLocaleString()} ${T.token}` : short(me.wallet)))), pr.note ? h('p', { class: 'side-state' }, pr.note) : null)
      : pr.note
        ? h('p', { class: 'side-state' }, pr.note)
        : null,
    pr.slab,
  ];
}

function appbarActions() {
  const clock = h('span', { class: 'pill pill--glass clock-pill num', id: 'clock-pill' }, clockText().join(' '));
  const me =
    wallet && T.me
      ? h('a', { class: 'chip-me', href: '#/wallet', 'aria-label': `${T.me.name}: your wallet`, 'data-focus': 'chip-me' }, avatar(T.me.wallet, T.smashApi, 'avatar avatar--sm'), h('span', { class: 'who' }, h('b', {}, T.me.name), h('span', { class: 'num' }, bal ? `${bal.tokens.toLocaleString()} ${coin()}` : short(T.me.wallet))))
      : h('span', { class: 'connect' }, slab(busy === 'Connecting…' ? 'Connecting…' : 'Connect', { fill: 'sugar', size: 'sm', badge: 'wallet', onclick: chooseWallet, disabled: !!busy, focus: 'connect-top' }));
  return [clock, me];
}

/* ----------------------------------- views --------------------------------- */

function homeView() {
  const t = T;
  const champ = champion(t.name, t.smashApi);
  const [clockA, clockB] = clockText();
  const res = t.result;
  const pot = res?.winner
    ? h('div', { class: 'pot pot--won' }, h('span', { class: 'pill pot__label' }, 'Winner'), h('div', { class: 'pot__value' }, res.name), h('span', { class: 'pot__note' }, `took ${res.prize} ${t.token}`, res.explorer ? [' · ', h('a', { href: res.explorer, target: '_blank', rel: 'noopener' }, 'see the payout on chain')] : res.status ? ' · paying out…' : ''))
    : res
      ? h('div', { class: 'pot' }, h('span', { class: 'pill pot__label' }, 'No winner'), h('span', { class: 'pot__note' }, res.note))
      : h('div', { class: 'pot' }, h('span', { class: 'pill pot__label' }, t.rakePercent ? `Prize · pool minus ${t.rakePercent}%` : 'Prize pool · winner takes all'), h('div', { class: 'pot__value num' }, h('img', { class: 'coin', src: '/brand/smash-coin.svg', alt: '' }), t.pool.prize, h('small', {}, t.token)), h('span', { class: 'pot__note' }, `Grows by ${t.fee} with every entry. `, h('button', { class: 'textbtn pot__link', type: 'button', onclick: aboutSmash }, 'What is $SMASH?')));

  const feature = h(
    'section',
    { class: 'feature', 'aria-labelledby': 'feature-title' },
    h('div', { class: 'feature-art', 'aria-hidden': 'true' }, h('img', { class: 'art-card', src: champ.card, alt: '' }), h('img', { src: champ.art, alt: '' })),
    h('div', { class: 'status-row' }, phasePill(t), h('span', { class: 'pill pill--glass' }, 'Featured'), t.organizer ? h('span', { class: 'pill pill--soft' }, `by ${t.organizer}`) : null),
    h('h2', { id: 'feature-title', class: 'display' }, t.name),
    h('p', { class: 'glass clock', id: 'clock' }, h('span', {}, clockA), h('span', { class: 'num' }, clockB)),
    pot,
    h('dl', { class: 'facts' }, fact('Per match', `${t.fee} ${coin()}`), fact('Players', t.players), fact('Format', t.rules.winTarget ? `First to ${t.rules.winTarget}` : 'Most wins'), fact('Game', t.ruleset === 'classic' ? 'Classic' : 'Mutators')),
    h('p', { class: 'verify' }, 'The pool is a public Solana account: ', h('a', { href: t.pool.explorer, target: '_blank', rel: 'noopener', class: 'mono' }, short(t.pool.tokenAccount)), t.pool.onChain !== null ? ` holds ${t.pool.onChain} ${t.token} right now.` : '.')
  );

  const top = t.standings.slice(0, 5);
  const live = t.matches.slice(0, 4);
  return [
    h('div', { class: 'home-top' }, feature, runCard()),
    homePractice(),
    h(
      'div',
      { class: 'split' },
      h('section', { class: 'panel', 'aria-labelledby': 'home-lb' }, h('div', { class: 'section-head' }, h('h2', { id: 'home-lb', class: 'ribbon' }, h('span', {}, 'Top players')), h('a', { class: 'more', href: '#/ranks' }, 'See all')), top.length ? rankRows(top) : empty('No results yet', 'Win the first match and you top the board.')),
      h('section', { class: 'panel', 'aria-labelledby': 'home-m' }, h('div', { class: 'section-head' }, h('h2', { id: 'home-m', class: 'ribbon' }, h('span', {}, 'Latest matches')), h('a', { class: 'more', href: '#/matches' }, 'See all')), live.length ? feedList(live) : empty('No matches yet', 'Matches show up here the moment they are made.'))
    ),
    h('a', { class: 'panel tcard tcard--host', href: '#/rules' }, h('div', { class: 'tcard__top' }, h('span', { class: 'tcard__art', 'aria-hidden': 'true' }, icon('book')), h('span', { class: 'pill' }, 'New here?')), h('h3', {}, 'How it works'), h('p', {}, `Pay ${t.fee} ${t.token} per match, get paired with the next player, win the most and take the whole pool.`)),
    fineprint(),
  ];
}
const fact = (k, v) => h('div', { class: 'fact' }, h('dt', {}, k), h('dd', {}, String(v)));
const stat = (k, v) => h('div', {}, h('dt', {}, k), h('dd', {}, String(v)));
const empty = (title, text) => h('div', { class: 'empty' }, h('img', { class: 'art', src: champion(title, T.smashApi).art, alt: '', loading: 'lazy' }), h('b', {}, title), h('span', {}, text));
const artOf = (id) => championById(id, T.smashApi).art;
const CROWN = 'M3 18h18l1.5-10-5.5 4-5-8-5 8-5.5-4zM3 20h18';
const crown = () => h('svg', { class: 'crown', viewBox: '0 0 24 22', 'aria-hidden': 'true' }, h('path', { d: CROWN, fill: '#ffc21a', stroke: '#0d1a4a', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }));
const faces = (a, b) => h('span', { class: 'faces', 'aria-hidden': 'true' }, avatar(a, T.smashApi), avatar(b, T.smashApi));

/** Your run, on Home: who you are and how you stand (the action itself lives in the dock / sidebar). */
function runCard() {
  const t = T;
  if (!wallet || !t.me) {
    return h('aside', { class: 'plate run', 'aria-label': 'Get started' }, h('h3', {}, 'Get started'), h('p', {}, `1. Connect a Solana wallet (signing in is free). 2. Pay ${t.fee} ${t.token} to enter a match. 3. Play it right here. The most wins takes the whole pool.`), slab('Connect a wallet', { fill: 'sky', badge: 'wallet', wide: true, onclick: chooseWallet, disabled: !!busy || t.phase === 'settled', focus: 'connect-run' }));
  }
  const me = t.me;
  const st = me.standing;
  return h(
    'aside',
    { class: 'plate run', 'aria-label': 'Your run' },
    h('div', { class: 'run-head' }, avatar(me.wallet, t.smashApi, 'avatar avatar--lg'), h('div', {}, h('h3', {}, me.name), h('p', { class: 'sub mono' }, `${short(me.wallet)} · ${wallet.kind === 'test' ? 'test wallet' : wallet.name}`))),
    h('dl', { class: 'run-stats' }, stat('Wins', st?.wins ?? 0), stat('Losses', st?.losses ?? 0), stat('Rank', st ? `#${t.standings.findIndex((r) => r.wallet === me.wallet) + 1}` : '—'), stat('Opponents', `${st?.opponents ?? 0}/${t.rules.minOpponentsToWin}`), stat(coin(), bal ? bal.tokens.toLocaleString() : '…'), stat('SOL', bal ? bal.sol.toFixed(3) : '…')),
    busy ? h('p', { class: 'busy', role: 'status' }, busy) : null
  );
}

function eventsView() {
  const here = { url: null, name: T.name, phase: T.phase, startsAt: T.startsAt, endsAt: T.endsAt, prize: T.pool.prize, token: T.token, fee: T.fee, players: T.players, winTarget: T.rules.winTarget };
  const list = [here, ...(T.peers ?? [])];
  const card = (t) => {
    const [a, b] = clockText(t);
    const inner = [
      h('div', { class: 'tcard__banner', 'aria-hidden': 'true' }, h('img', { src: champion(t.name, T.smashApi).art, alt: '', loading: 'lazy' }), phasePill(t)),
      h('h3', {}, t.name),
      h('p', { class: 'tcard__prize num' }, t.prize ?? '0', ' ', h('small', {}, t.token ?? '')),
      h('p', { class: 'tcard__meta' }, h('span', {}, `${t.fee} per match`), h('span', {}, plural(t.players ?? 0, 'player')), h('span', {}, t.winTarget ? `First to ${t.winTarget}` : 'Most wins'), h('span', { class: 'num' }, `${a} ${b}`)),
    ];
    return t.url ? h('a', { class: 'panel tcard', href: t.url, target: '_blank', rel: 'noopener' }, inner) : h('a', { class: 'panel tcard tcard--here', href: '#/', 'aria-label': `${t.name}: open` }, inner, h('span', { class: 'pill pill--soft' }, 'This tournament'));
  };
  return [
    h('div', { class: 'cards' }, list.map(card), h('a', { class: 'panel tcard tcard--host', href: 'https://docs.smashandclash.in', target: '_blank', rel: 'noopener' }, h('div', { class: 'tcard__banner', 'aria-hidden': 'true' }, icon('plus'), h('span', { class: 'pill' }, 'Open source')), h('h3', {}, 'Host your own'), h('p', {}, 'Tournament Organizer is an example built with the Smash&Clash SDK. Fork it, set your rules and run tournaments on your own site.'))),
    fineprint(),
  ];
}

function rankRows(list) {
  return h(
    'ol',
    { class: 'rows' },
    list.map((p) => {
      const i = T.standings.indexOf(p);
      return h(
        'li',
        { class: p.wallet === T.me?.wallet ? 'row you' : 'row' },
        h('span', { class: 'rank', 'aria-label': `Rank ${i + 1}` }, i + 1),
        avatar(p.wallet, T.smashApi),
        h('span', { class: 'who' }, h('b', {}, p.name), h('span', {}, `${p.played} played · ${plural(p.opponents, 'opponent')}`, p.wallet === T.me?.wallet ? h('span', { class: 'tag' }, 'You') : null, p.opponents < T.rules.minOpponentsToWin ? h('span', { class: 'tag', title: `Needs ${T.rules.minOpponentsToWin} different opponents to win` }, 'Not eligible yet') : null)),
        h('span', { class: 'rec num', 'aria-label': `${p.wins} wins, ${p.losses} losses${p.draws ? `, ${p.draws} draws` : ''}` }, `${p.wins}–${p.losses}`, p.draws ? h('small', {}, ` ${p.draws}D`) : null)
      );
    })
  );
}

function ranksView() {
  const t = T;
  const top = t.standings.slice(0, 3);
  const podium = h(
    'div',
    { class: 'podium', role: 'list', 'aria-label': 'Top three' },
    [1, 0, 2].map((i) => {
      const p = top[i];
      const place = i + 1;
      if (!p) return h('div', { class: `step step--${place} step--empty`, role: 'listitem', 'aria-label': `${place}: open` }, h('span', { class: 'avatar' }), h('span', { class: 'name muted' }, '—'), h('div', { class: 'block' }, place, h('small', {}, 'open')));
      return h('div', { class: `step step--${place}`, role: 'listitem', 'aria-label': `${place}. ${p.name}, ${plural(p.wins, 'win')}` }, place === 1 ? crown() : null, avatar(p.wallet, t.smashApi), h('span', { class: 'name' }, p.name), h('div', { class: 'block num' }, p.wins, h('small', {}, p.wins === 1 ? 'win' : 'wins')));
    })
  );
  return [
    h('section', { class: 'panel', 'aria-labelledby': 'lb-title' }, h('div', { class: 'section-head' }, h('h2', { id: 'lb-title', class: 'ribbon' }, h('span', {}, t.name)), h('span', { class: 'pill pill--soft' }, t.rules.winTarget ? `First to ${t.rules.winTarget} wins` : 'Most wins takes it')), podium, t.standings.length ? rankRows(t.standings) : empty('No results yet', 'Win the first match and you top the board.')),
    h('p', { class: 'fineprint' }, `Ties go to fewer losses, then to whoever got there first. To win you need ${plural(t.rules.minOpponentsToWin, 'different opponent')}.`),
  ];
}

function feedList(list) {
  return h(
    'ul',
    { class: 'feed' },
    list.map((m) => {
      const what = m.status === 'waiting' ? 'Taking seats' : m.status === 'active' ? `Live · move ${m.moves}` : m.status === 'void' ? `Void${REASON[m.reason] ? ` · ${REASON[m.reason]}` : ''}` : m.winner === 'draw' ? `Draw ${m.score ?? ''}` : `${m.winner} won${m.score ? ` ${m.score}` : ''}${REASON[m.reason] ? ` · ${REASON[m.reason]}` : ''}`;
      const link = m.status === 'active' || m.status === 'waiting' ? h('a', { href: `#/watch/${m.id}` }, 'Watch') : m.moves > 0 && m.status !== 'void' ? h('a', { href: `#/replay/${m.id}` }, 'Review') : h('span', {});
      return h('li', {}, h('span', { class: `state-dot ${m.status}`, 'aria-hidden': 'true' }), h('span', { class: 'vs' }, faces(m.wallets?.[0] ?? m.players[0], m.wallets?.[1] ?? m.players[1]), m.players[0], h('i', {}, 'vs'), m.players[1]), link, h('span', { class: 'what' }, what));
    })
  );
}

function matchesView() {
  const t = T;
  return [
    h('section', { class: 'panel', 'aria-labelledby': 'm-title' }, h('div', { class: 'section-head' }, h('h2', { id: 'm-title', class: 'ribbon' }, h('span', {}, 'All matches')), h('span', { class: 'pill pill--soft' }, `${t.matches.filter((m) => m.status === 'active').length} live`)), t.matches.length ? feedList(t.matches) : empty('No matches yet', 'Matches show up here the moment they are made.')),
    t.payouts.length
      ? h('section', { class: 'panel', 'aria-labelledby': 'p-title' }, h('div', { class: 'section-head' }, h('h2', { id: 'p-title', class: 'ribbon' }, h('span', {}, 'Payouts'))), h('ul', { class: 'feed' }, t.payouts.map((p) => h('li', {}, h('span', { class: 'state-dot finished', 'aria-hidden': 'true' }), h('span', { class: 'vs' }, `${p.kind === 'prize' ? 'Prize' : 'Refund'} · ${p.amount} ${coin()}`), h('a', { href: p.explorer, target: '_blank', rel: 'noopener' }, 'Tx'), h('span', { class: 'what mono' }, `to ${short(p.wallet)}`)))))
      : null,
    publicGames(),
    h('p', { class: 'fineprint' }, 'Results come from the Smash&Clash game server. Every payout is a Solana transaction anyone can check.'),
  ];
}

function walletView() {
  const t = T;
  if (!wallet || !t.me) {
    return [
      smashPanel(),
      h('section', { class: 'plate run' }, h('h3', {}, 'Your wallet is your account'), h('p', {}, 'Connect a Solana wallet to enter matches and receive prizes. Signing in is free and moves nothing; every payment asks your wallet first.'), slab('Connect a wallet', { fill: 'sky', badge: 'wallet', wide: true, onclick: chooseWallet, disabled: !!busy, focus: 'connect-wallet' })),
      fineprint(),
    ];
  }
  const me = t.me;
  const entries = me.entries.filter((e) => e.status !== 'expired');
  const STATUS = { pending: 'Waiting for payment', queued: 'In the queue', matched: 'Played', 'refund-due': 'Refund on its way', refunded: 'Refunded' };
  return [
    runCard(),
    h(
      'div',
      { class: 'split' },
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'w-actions' },
        h('div', { class: 'section-head' }, h('h2', { id: 'w-actions', class: 'ribbon' }, h('span', {}, 'Account'))),
        h('div', { class: 'run', style: null }, t.devFaucet ? slab('Get test tokens', { fill: 'mint', wide: true, icon: 'coins', pill: `${Number(t.fee) * 10} ${t.token} + SOL for fees`, onclick: faucet, disabled: !!busy, focus: 'faucet' }) : null, slab('Rename', { fill: 'sugar', wide: true, onclick: rename, disabled: !!busy, focus: 'rename' }), slab('Sign out', { fill: 'cherry', wide: true, onclick: () => signOut(), focus: 'signout' }))
      ),
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'w-history' },
        h('div', { class: 'section-head' }, h('h2', { id: 'w-history', class: 'ribbon' }, h('span', {}, 'History'))),
        entries.length || me.payouts.length
          ? h('ul', { class: 'history' }, entries.map((e) => h('li', {}, h('span', {}, `Entry · ${e.amount} ${coin()}`), h('span', {}, e.status === 'matched' && e.matchId === me.current?.id ? 'In a match' : STATUS[e.status] ?? e.status))), me.payouts.map((p) => h('li', {}, h('span', {}, `${p.kind === 'prize' ? 'Prize' : 'Refund'} · ${p.amount} ${coin()}`), h('span', {}, p.explorer ? h('a', { href: p.explorer, target: '_blank', rel: 'noopener' }, 'View tx') : 'Sending…'))))
          : empty('Nothing yet', 'Your entries, refunds and prizes show up here.')
      )
    ),
    smashPanel(),
    fineprint(),
  ];
}

function rulesView() {
  const r = T.rules;
  const tok = T.token;
  return [
    h(
      'ol',
      { class: 'steps' },
      step('Pay to play', `Each match costs ${T.fee} ${tok}. Every fee goes into the prize pool, a public Solana account anyone can check.`),
      step('Get paired', `You meet the next player in the queue. Nobody picks their opponent, and two players meet at most ${r.maxRepeatPairings} times.`),
      step('Play here', 'Matches are played in this app. Results come straight from the Smash&Clash game server, never from a browser.'),
      step('Take it all', r.winTarget ? `The first player to ${r.winTarget} wins takes the pool, and the tournament ends right there.` : 'When time runs out, the most wins takes the pool. Ties go to fewer losses, then to whoever got there first.'),
      step('Play fair', `You need ${plural(r.minOpponentsToWin, 'different opponent')} to win. Take your seat within ${r.showUpMinutes} min and move within ${r.moveTimeoutMinutes} min on your turn, or you forfeit${r.forfeitsCount ? '' : ' (forfeits do not count as wins here)'}.`),
      step('Money back', `Leave the queue before you are paired for a full refund. If nobody qualifies to win, every fee is refunded.${r.playerKind === 'person' ? ' This one is for people: a seat played by an AI agent forfeits.' : ' AI agents are welcome too.'}`),
      step('Who runs it', `${T.organizer ? T.organizer : 'The organizer'} runs this tournament, holds the pool and pays the winner. Smash&Clash only plays the games and reports the results.${r.ageCheck ? ` Entrants must be ${r.minAge}+ (or older, where local law requires).` : ''}`)
    ),
    T.cluster !== 'mainnet-beta' ? h('p', { class: 'note' }, `This tournament runs on Solana ${T.cluster} with test tokens that have no value. Tournament Organizer is an example of what you can build with the Smash&Clash SDK.`) : null,
    smashPanel(),
    ...gamePanels(),
    fineprint(),
  ];
}
const STEP_ART = { 'Pay to play': 1, 'Get paired': 6, 'Play here': 3, 'Take it all': 12, 'Play fair': 14, 'Money back': 17, 'Who runs it': 19 };
const step = (title, text) => h('li', { class: STEP_ART[title] ? 'has-art' : null }, h('b', {}, title), text, STEP_ART[title] ? h('img', { class: 'step-art', src: artOf(STEP_ART[title]), alt: '', loading: 'lazy' }) : null);

/* ---------------------------------- $SMASH --------------------------------- */

const SMASH_MINT = '4VkfpAfHWFkBsVoSrAp4bos4yzWmJYj3z1LPNm1Dxory';
const ORYNTH = 'https://www.orynth.dev/projects/smash-clash';

/** What $SMASH is, plainly: the token this tournament runs on, where to see it, and the risk. */
function smashInfo() {
  const test = T.cluster !== 'mainnet-beta';
  return [
    h('p', { class: 'status-detail' }, '$SMASH is the Smash&Clash community token, a standard token on Solana created by Harshit Khemani, the founder of Smash&Clash, and listed on Orynth. Tournaments built on Smash&Clash use $SMASH, and only $SMASH, for entry fees and prizes.'),
    test ? h('p', { class: 'status-detail' }, `This tournament is a test on Solana ${T.cluster}: it uses a free test token that stands in for $SMASH and is worth nothing.`) : null,
    h('dl', { class: 'smash-facts' }, h('div', {}, h('dt', {}, 'Network'), h('dd', {}, 'Solana')), h('div', {}, h('dt', {}, 'Mint address'), h('dd', { class: 'mono' }, SMASH_MINT))),
    h(
      'div',
      { class: 'run-actions' },
      h('a', { class: 'more', href: ORYNTH, target: '_blank', rel: 'noopener' }, '$SMASH on Orynth'),
      h('a', { class: 'more', href: `https://explorer.solana.com/address/${SMASH_MINT}`, target: '_blank', rel: 'noopener' }, 'The mint on the Solana explorer'),
      h('button', { class: 'chipbtn', type: 'button', onclick: () => navigator.clipboard?.writeText(SMASH_MINT).then(() => say('Mint address copied.')) }, 'Copy the address')
    ),
    h('p', { class: 'fineprint dark' }, 'You never need $SMASH to play Smash&Clash itself. Holding it gives no share in or claim on Smash&Clash. Like any crypto token, it can lose all its value and small tokens can be hard to sell: only enter with what you can afford to lose. Nothing here is financial advice.'),
  ];
}

function smashPanel() {
  return h('section', { class: 'panel', 'aria-labelledby': 'smash-title' }, h('div', { class: 'section-head smash-head' }, h('img', { class: 'coin coin--lg', src: '/brand/smash-coin.svg', alt: '' }), h('h2', { id: 'smash-title', class: 'ribbon' }, h('span', {}, 'What is $SMASH?'))), smashInfo());
}

const aboutSmash = () => sheet('What is $SMASH?', ...smashInfo(), h('div', { class: 'sheet-actions' }, h('button', { class: 'textbtn', type: 'button', onclick: closeSheet }, 'Close')));
const fineprint = () => h('p', { class: 'fineprint' }, 'Tournament Organizer is built with the ', h('a', { href: '#/sdk' }, 'Smash&Clash SDK'), '. This tournament is run by its organizer, not by Smash&Clash; Smash&Clash does not hold, move or pay out any tokens.');

/* ---------------------------------- practice -------------------------------- */

function practiceView() {
  const pr = practiceRecord();
  const strength = strengthFor(pr.rating);
  const saved = livePractice();
  const ch = savedChallenge();
  if (ch?.status === 'pending') {
    // the challenge's result, read back from Smash&Clash until it is played or expires
    const st = remote(`challenge:${ch.token}`, 8000, () => sc().challenges.get(ch.token));
    if (st.value && st.value.status !== 'pending') saveChallenge({ ...ch, status: st.value.status, result: st.value.result });
  }
  const duels = remote('open-duels', 15000, () => sc().games.openDuels());
  const MODES = [
    ['house', 'At your level', 'sky', 'users', `Rating ${strength}`, 'An opponent that plays at your practice rating, which moves after every game.', 2],
    ['quick', 'Quick match', 'grape', 'swords', 'Whoever is online', 'The Smash&Clash queue: you meet whoever else is looking for a game.', 5],
    ['invite', 'Invite a friend', 'gum', 'link', 'Send a link', 'They play you in their browser, no sign-up.', 4],
    ['code', 'Duel an agent', 'sugar', 'spark', 'Get a code', 'Open a duel with a 6-letter code an AI agent joins (MCP or CLI).', 7],
  ];
  return [
    h(
      'section',
      { class: 'plate run', 'aria-labelledby': 'pr-title' },
      h('h3', { id: 'pr-title' }, 'Free play'),
      h('p', {}, 'Practice games are free and never count for the tournament. Warm up, learn the cards, then go win the pool.'),
      h('dl', { class: 'run-stats' }, stat('Practice rating', pr.rating), stat('Played', pr.played), stat('Won', pr.won)),
      saved ? slab('Resume your game', { fill: 'sun', wide: true, badge: 'play', pill: { house: 'At your level', quick: 'Quick match', invite: 'Friend', code: 'Agent duel', join: 'Duel' }[saved.mode] ?? 'Practice', onclick: () => (location.hash = '#/play'), focus: 'resume' }) : null
    ),
    h(
      'div',
      { class: 'modes' },
      MODES.map(([mode, label, fill, ico, pill, desc, champ]) => h('div', { class: 'mode' }, h('img', { class: 'mode-art', src: artOf(champ), alt: '', loading: 'lazy' }), slab(label, { fill, wide: true, icon: ico, pill, onclick: () => startPractice(mode), disabled: !!busy, focus: `mode-${mode}` }), h('p', { class: 'fineprint' }, desc))),
      h('div', { class: 'mode' }, h('img', { class: 'mode-art', src: artOf(13), alt: '', loading: 'lazy' }), slab('Join with a code', { fill: 'sugar', wide: true, icon: 'plus', pill: 'Enter a code', onclick: joinByCode, focus: 'mode-join' }), h('p', { class: 'fineprint' }, 'Someone gave you a duel code? Play them here.'))
    ),
    h(
      'div',
      { class: 'split' },
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'od-title' },
        h('div', { class: 'section-head' }, h('h2', { id: 'od-title', class: 'ribbon' }, h('span', {}, 'Open duels')), h('span', { class: 'pill pill--soft' }, 'games.openDuels')),
        duels.value?.length
          ? h('ul', { class: 'feed' }, duels.value.slice(0, 8).map((d) => h('li', {}, h('span', { class: 'state-dot waiting', 'aria-hidden': 'true' }), h('span', { class: 'vs' }, d.host, d.hostKind === 'agent' ? h('span', { class: 'tag' }, 'Agent') : null), h('button', { class: 'chipbtn', type: 'button', onclick: () => startPractice('join', { code: d.code }) }, 'Join'), h('span', { class: 'what' }, `${d.ruleset === 'classic' ? 'Classic' : 'Mutators'} · code ${d.code}`))))
          : empty(duels.pending ? 'Looking…' : 'No open duels', duels.error ?? 'Open one with "Duel an agent", or check back soon.')
      ),
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'ag-title' },
        h('div', { class: 'section-head' }, h('h2', { id: 'ag-title', class: 'ribbon' }, h('span', {}, 'AI agents')), h('span', { class: 'pill pill--soft' }, 'challenges')),
        h('p', { class: 'status-detail' }, 'Challenge an AI agent to a Smash&Clash game. You play it on smashandclash.in; the result comes back here.'),
        ch ? challengeCard(ch) : null,
        h('div', { class: 'agents' }, AGENTS.map(agentCard))
      )
    ),
    fineprint(),
  ];
}

function agentCard(slug) {
  const prof = remote(`agent:${slug}`, 60_000, () => sc().agents.profile(slug));
  const a = prof.value?.agent;
  const games = remote(`agent-matches:${slug}`, 60_000, () => sc().agents.matches(slug, { limit: 2 }));
  const recent = games.value?.matches?.slice(0, 2) ?? [];
  const champ = championById(a?.characterId ?? (slug === 'claude' ? 12 : 1), T.smashApi);
  return h(
    'article',
    { class: 'agent' },
    h('div', { class: 'agent-head' }, h('span', { class: 'avatar avatar--lg', 'aria-hidden': 'true' }, h('img', { src: champ.art, alt: '', loading: 'lazy' })), h('div', {}, h('h3', {}, a?.name ?? slug), h('p', { class: 'meta' }, a ? `${a.rank} · rating ${a.rating}${a.provisional ? ' (new)' : ''} · ${plural(a.games, 'game')}${a.winRate != null ? ` · ${a.winRate}% won` : ''}` : prof.error ?? 'Loading…'))),
    recent.length ? h('ul', { class: 'history' }, recent.map((m) => h('li', {}, h('span', {}, `vs ${m.challenger}`), h('span', {}, m.winner === 'draw' ? `draw ${m.scoreAgent}–${m.scoreChallenger}` : m.winner === 'agent' ? `${a?.name ?? slug} won ${m.scoreAgent}–${m.scoreChallenger}` : `${m.challenger} won ${m.scoreChallenger}–${m.scoreAgent}`)))) : null,
    slab(`Challenge ${a?.name ?? slug}`, { fill: 'grape', wide: true, size: 'sm', onclick: () => challengeAgent(slug), disabled: !!busy, focus: `challenge-${slug}` })
  );
}

function challengeCard(ch) {
  const r = ch.result;
  const line =
    ch.status === 'pending'
      ? `Your game against ${ch.agent} is ready to play.`
      : ch.status === 'expired'
        ? `Your challenge to ${ch.agent} expired.`
        : r
          ? r.winner === 'draw'
            ? `You drew ${ch.agent}, ${r.scoreChallenger}–${r.scoreAgent}.`
            : r.winner === 'challenger'
              ? `You beat ${ch.agent}, ${r.scoreChallenger}–${r.scoreAgent}!`
              : `${ch.agent} won, ${r.scoreAgent}–${r.scoreChallenger}.`
          : `Your game against ${ch.agent} is over.`;
  return h(
    'div',
    { class: 'challenge' },
    h('p', { class: 'run-state' }, ch.status === 'pending' ? h('span', { class: 'pill pill--live' }, h('span', { class: 'dot' }), 'Pending') : h('span', { class: 'pill pill--soft' }, ch.status), line),
    h('div', { class: 'run-actions' }, ch.status === 'pending' ? h('a', { class: 'more', href: ch.url, target: '_blank', rel: 'noopener' }, 'Open the game') : null, r?.replayUrl ? h('a', { class: 'more', href: r.replayUrl, target: '_blank', rel: 'noopener' }, 'Replay') : null, h('button', { class: 'textbtn', type: 'button', onclick: () => (saveChallenge(null), (drawn.view = null), render()) }, ch.status === 'pending' ? 'Forget it' : 'Clear'))
  );
}

/* --------------------------------- the SDK --------------------------------- */

const FEATURES = [
  ['Host a match between two people', 'games.createMatch({ players, ruleset })', 'Server: every tournament pairing', null],
  ['Read a result', 'games.watch(id)', 'Server: results, no-shows, stalls', null],
  ['Take your seat from an invite', 'games.claim(inviteUrl, { as })', 'Your tournament matches', '#/'],
  ['Pick a game back up', 'games.resume(id, playerToken)', 'Reloads, practice resume', '#/practice'],
  ['Play and wait', 'game.play(move) · game.waitForTurn()', 'Every game screen', '#/practice'],
  ['Resign or call off', 'game.resign()', 'Every game screen', '#/practice'],
  ['A seat’s move feed', 'game.sync({ since })', 'Move list, the other hand', '#/practice'],
  ['An opponent at your level', 'games.startHouse({ strength })', 'Practice', '#/practice'],
  ['Whoever is online', 'games.quickMatch({ opponent })', 'Practice', '#/practice'],
  ['A friend by link', "games.createDuel({ opponent: 'person' })", 'Practice', '#/practice'],
  ['An agent by code', 'games.createDuel() · games.joinDuel(code)', 'Practice', '#/practice'],
  ['Duels waiting for a player', 'games.openDuels()', 'Practice', '#/practice'],
  ['Watch any game live', 'games.watch(id) · games.follow(id, { since })', 'Matches → Watch', '#/matches'],
  ['Public games', "games.live({ status })", 'Matches', '#/matches'],
  ['A finished game, move by move', 'games.replay(id)', 'Replay viewer', '#/matches'],
  ['Game Review', 'games.review(id) · game.review()', 'Replay viewer, after a game', '#/matches'],
  ['Shared replay links', 'replays.read(url) · replays.review(url)', 'Matches → Open a replay link', '#/matches'],
  ['The deck', 'cards()', 'Every board, How it works', '#/rules'],
  ['The rules', 'rules()', 'How it works', '#/rules'],
  ['Hints and bots', 'greedyMove(view, seat) · firstLegalMove · game.playOut()', 'Practice hint · scripts/simulate.mjs', '#/practice'],
  ['Challenge an AI agent', 'challenges.create · challenges.get', 'Practice → AI agents', '#/practice'],
  ['Agents’ records', 'agents.profile(slug) · agents.matches(slug)', 'Practice → AI agents', '#/practice'],
  ['Errors you can act on', 'SmashAndClashError (message + hint)', 'Every error toast', null],
  ['Rate limits', 'client.http.rateLimit', 'This page', null],
];

function sdkView() {
  const rl = sc().http.rateLimit;
  return [
    h(
      'section',
      { class: 'plate run', 'aria-labelledby': 'sdk-title' },
      h('h3', { id: 'sdk-title' }, 'Built with the Smash&Clash SDK'),
      h('p', {}, 'Tournament Organizer is an example: every Smash&Clash feature it shows comes from @smashandclash/sdk, the same package you can install today. Fork it and build your own.'),
      h('dl', { class: 'run-stats' }, stat('SDK', `v${SDK_VERSION}`), stat('API', new URL(T.smashApi).host), stat('Rate limit', rl ? `${rl.remaining} left (${rl.policy})` : 'no limited call yet')),
      h('div', { class: 'run-actions' }, h('a', { class: 'more', href: 'https://docs.smashandclash.in', target: '_blank', rel: 'noopener' }, 'Docs'), h('a', { class: 'more', href: 'https://www.npmjs.com/package/@smashandclash/sdk', target: '_blank', rel: 'noopener' }, 'npm'), h('a', { class: 'more', href: 'https://github.com/smashandclash/tldraw', target: '_blank', rel: 'noopener' }, 'Another example: tldraw'))
    ),
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'feat-title' },
      h('div', { class: 'section-head' }, h('h2', { id: 'feat-title', class: 'ribbon' }, h('span', {}, 'Every feature, and where it is'))),
      h('ul', { class: 'featmap' }, FEATURES.map(([what, call, where, href]) => h('li', {}, h('b', {}, what), h('code', {}, call), href ? h('a', { href }, where) : h('span', {}, where))))
    ),
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'more-title' },
      h('div', { class: 'section-head' }, h('h2', { id: 'more-title', class: 'ribbon' }, h('span', {}, 'Beyond the browser'))),
      h(
        'ul',
        { class: 'history' },
        h('li', {}, h('span', {}, 'The CLI, for people and agents'), h('code', {}, 'npx @smashandclash/cli watch <game-id>')),
        h('li', {}, h('span', {}, 'An agent joins a duel code'), h('code', {}, 'smashandclash duel join <CODE> --strategy greedy')),
        h('li', {}, h('span', {}, 'The MCP server, for AI assistants'), h('code', {}, 'https://www.smashandclash.in/api/mcp')),
        h('li', {}, h('span', {}, 'Bots that play a whole tournament'), h('code', {}, 'npm run simulate'))
      )
    ),
    fineprint(),
  ];
}

/* ------------------------------ public games ------------------------------- */

function publicGames() {
  const live = remote('live', 15000, () => sc().games.live({ status: 'active', limit: 8 }));
  const done = remote('finished', 30000, () => sc().games.live({ status: 'finished', limit: 6 }));
  const row = (g, href, label) => h('li', {}, h('span', { class: `state-dot ${g.status}`, 'aria-hidden': 'true' }), h('span', { class: 'vs' }, faces(seatName(g, 'A'), seatName(g, 'B') || g.id), seatName(g, 'A'), h('i', {}, 'vs'), seatName(g, 'B') || '…'), h('a', { href }, label), h('span', { class: 'what' }, g.status === 'active' ? `Live · move ${g.moveCount} · ${g.score.A}–${g.score.B}` : `${g.winner === 'draw' ? 'Draw' : `${seatName(g, g.winner)} won`} ${Math.max(g.score.A, g.score.B)}–${Math.min(g.score.A, g.score.B)}`));
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'pub-title' },
    h('div', { class: 'section-head' }, h('h2', { id: 'pub-title', class: 'ribbon' }, h('span', {}, 'On Smash&Clash now')), h('button', { class: 'chipbtn', type: 'button', onclick: openReplayLink }, 'Open a replay link')),
    live.value?.length ? h('ul', { class: 'feed' }, live.value.map((g) => row(g, `#/watch/${g.id}`, 'Watch'))) : empty(live.pending ? 'Looking…' : 'Nothing live right now', live.error ?? 'Public games show up here while they are played.'),
    done.value?.length ? [h('p', { class: 'fineprint subhead' }, 'Just finished'), h('ul', { class: 'feed' }, done.value.map((g) => row(g, `#/replay/${g.id}`, 'Review')))] : null
  );
}

/* ---------------------------- the game itself ------------------------------ */

function gamePanels() {
  const text = remote('rules', 3_600_000, () => rules(sc()));
  const cards = remote('deck', 3_600_000, () => deck(sc()));
  return [
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'gr-title' },
      h('div', { class: 'section-head' }, h('h2', { id: 'gr-title', class: 'ribbon' }, h('span', {}, 'The game')), h('span', { class: 'pill pill--soft' }, T.ruleset === 'classic' ? 'Classic' : 'Mutators')),
      text.value ? h('div', { class: 'rules-text' }, text.value.split(/\n{2,}/).map((para) => h('p', {}, para.replace(/\n/g, ' ')))) : empty(text.pending ? 'Loading the rules…' : 'Rules unavailable', text.error ?? '')
    ),
    h(
      'section',
      { class: 'panel', 'aria-labelledby': 'deck-title' },
      h('div', { class: 'section-head' }, h('h2', { id: 'deck-title', class: 'ribbon' }, h('span', {}, 'The deck')), cards.value ? h('span', { class: 'pill pill--soft' }, `${cards.value.size} cards`) : null),
      cards.value
        ? h(
            'ul',
            { class: 'deck' },
            [...cards.value.values()].map((c) => h('li', { title: c.kind === 'character' ? `${c.name}: top ${c.top}, right ${c.right}, bottom ${c.bottom}, left ${c.left}` : `${c.name}: ${c.does}` }, h('img', { src: c.image, alt: '', loading: 'lazy' }), h('span', {}, c.name), h('small', {}, c.kind === 'character' ? `${c.top} · ${c.right} · ${c.bottom} · ${c.left}` : 'Effect')))
          )
        : empty(cards.pending ? 'Loading the deck…' : 'Deck unavailable', cards.error ?? '')
    ),
  ];
}

function homePractice() {
  const saved = livePractice();
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'hp-title' },
    h('div', { class: 'section-head' }, h('h2', { id: 'hp-title', class: 'ribbon' }, h('span', {}, 'Warm up for free')), h('a', { class: 'more', href: '#/practice' }, 'More ways to play')),
    h(
      'div',
      { class: 'modes modes--row' },
      saved ? slab('Resume', { fill: 'sun', size: 'sm', badge: 'play', onclick: () => (location.hash = '#/play'), focus: 'home-resume' }) : null,
      slab('At your level', { fill: 'sky', size: 'sm', icon: 'users', onclick: () => startPractice('house'), disabled: !!busy, focus: 'home-house' }),
      slab('Quick match', { fill: 'grape', size: 'sm', icon: 'swords', onclick: () => startPractice('quick'), disabled: !!busy, focus: 'home-quick' }),
      slab('Invite a friend', { fill: 'gum', size: 'sm', icon: 'link', onclick: () => startPractice('invite'), disabled: !!busy, focus: 'home-invite' })
    ),
    h('p', { class: 'fineprint dark' }, 'Practice games never count for the tournament.')
  );
}

/* ----------------------------------- boot ---------------------------------- */

window.addEventListener('hashchange', () => {
  closeSheet();
  drawn.view = null;
  render();
  if (!route().layer) {
    $('#view').scrollTop = 0;
    $('#view').focus({ preventScroll: true }); // screen readers land on the new view
  }
});

await refresh();
// a returning test-wallet player is signed in already: pick the wallet back up
if (T?.me && T.cluster !== 'mainnet-beta') {
  try {
    const tw = testWallet({ cluster: T.cluster, rpcUrl: T.rpc });
    if (tw.address === T.me.wallet) wallet = tw;
  } catch {}
}
if (T?.me && !wallet) await api('/api/auth/signout', {}).catch(() => {}); // a browser wallet must connect again
for (const k of Object.keys(drawn)) drawn[k] = null;
await refresh();
setInterval(refresh, 4000);
setInterval(() => {
  if (!T) return;
  const [a, b] = clockText();
  const c = $('#clock');
  if (c) c.replaceChildren(h('span', {}, a), h('span', { class: 'num' }, b));
  const pill = $('#clock-pill');
  if (pill) pill.textContent = `${a} ${b}`;
}, 1000);
