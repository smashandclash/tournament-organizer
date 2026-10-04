// The one Smash&Clash SDK client the app shares, plus what several screens need from it.
// The SDK is served from node_modules by the organizer's server (/vendor/smashandclash-sdk.js).

import { SDK_VERSION, SmashAndClash, firstLegalMove, greedyMove } from '/vendor/smashandclash-sdk.js';

export { SDK_VERSION, firstLegalMove, greedyMove };

let client = null;
/** The shared client (no API key: the SDK talks to the public Smash&Clash API). */
export function sdk(baseUrl) {
  if (!client || client.http.baseUrl !== baseUrl.replace(/\/+$/, '')) client = new SmashAndClash({ baseUrl });
  return client;
}

let cardsP = null;
/** The deck (51 cards), fetched once: name -> card (image, sides, what an effect does). */
export const deck = (sc) => (cardsP ??= sc.cards().then((list) => new Map(list.map((c) => [c.name, c]))).catch((e) => ((cardsP = null), Promise.reject(e))));

let rulesP = null;
/** The rules, short, as the API words them. */
export const rules = (sc) => (rulesP ??= sc.rules().catch((e) => ((rulesP = null), Promise.reject(e))));

/** A readable error: the SDK's problem details carry a hint on what to do next. */
export function errorText(e) {
  const msg = e?.message || String(e);
  if (/failed to fetch/i.test(msg)) return 'Could not reach Smash&Clash. Check your connection.';
  return e?.hint ? `${msg} ${e.hint}` : msg;
}

/* ------------------------------ practice record ----------------------------- */
// Practice is free and never counts for the tournament. The opponent at your level plays at your practice
// rating, which moves after every game (an ELO update), so it always meets you where you are.

const RECORD = 'snc-tournament:practice';
export function practiceRecord() {
  try {
    return { rating: 1200, played: 0, won: 0, ...JSON.parse(localStorage.getItem(RECORD) ?? '{}') };
  } catch {
    return { rating: 1200, played: 0, won: 0 };
  }
}
export function savePractice(patch) {
  const next = { ...practiceRecord(), ...patch };
  try {
    localStorage.setItem(RECORD, JSON.stringify(next));
  } catch {}
  return next;
}
export const strengthFor = (rating) => Math.max(800, Math.min(1600, Math.round(rating)));
export function afterPracticeGame(strength, result /* 'you' | 'opponent' | 'draw' */) {
  const r = practiceRecord();
  const score = result === 'you' ? 1 : result === 'draw' ? 0.5 : 0;
  const expected = 1 / (1 + 10 ** ((strength - r.rating) / 400));
  return savePractice({ rating: Math.round(r.rating + 32 * (score - expected)), played: r.played + 1, won: r.won + (result === 'you' ? 1 : 0) });
}

/* --------------------------------- personas --------------------------------- */
// The opponent at your level wears a player's handle, never a label for what it is: the same shapes
// the game's own lobby uses (an Adjective+Noun+digits handle, or a first name).

const ADJECTIVES = ['Brave', 'Swift', 'Sneaky', 'Mighty', 'Wobbly', 'Spicy', 'Turbo', 'Cosmic', 'Jolly', 'Rapid', 'Zesty', 'Lucky', 'Cheeky', 'Bouncy', 'Fuzzy', 'Nifty', 'Bold', 'Snappy', 'Plucky', 'Stormy', 'Frosty', 'Toasty'];
const NOUNS = ['Otter', 'Tiger', 'Pengu', 'Yeti', 'Falcon', 'Walrus', 'Comet', 'Ninja', 'Badger', 'Phoenix', 'Koala', 'Bison', 'Hawk', 'Panda', 'Wombat', 'Moose', 'Lynx', 'Heron', 'Gecko', 'Puffin', 'Quokka', 'Ibex'];
const FIRST = ['arjun', 'priya', 'rohan', 'aisha', 'kabir', 'meera', 'ishan', 'tara', 'zoya', 'sana', 'kenji', 'yuki', 'mei', 'jisoo', 'hana', 'sora', 'leo', 'maya', 'nina', 'omar', 'theo', 'aria', 'finn', 'luca', 'noor', 'ivy'];
function rng(seed) {
  let a = 2166136261;
  for (const ch of seed) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function personaName(gameId) {
  const r = rng(gameId);
  const pick = (xs) => xs[Math.min(xs.length - 1, Math.floor(r() * xs.length))];
  const roll = r();
  if (roll < 0.45) return `${pick(ADJECTIVES)}${pick(NOUNS)}${Math.floor(r() * 1000)}`;
  const first = pick(FIRST);
  if (roll < 0.7) return first;
  if (roll < 0.85) return `${first}${Math.floor(r() * 90) + 10}`;
  return `${first}_${String.fromCharCode(97 + Math.floor(r() * 26))}`;
}

/** A seat's display name: the house wears a persona; everyone else, their own name. */
export function seatName(state, seat) {
  if (!state) return '';
  if (state.playerKinds?.[seat] === 'house') return personaName(state.id);
  return state.players?.[seat] ?? (seat === 'A' ? 'Player 1' : 'Player 2');
}
