// Sign in with a Solana wallet: the server hands out a one-time message, the wallet signs it, the server
// checks the ed25519 signature and sets a session cookie. No passwords, no email; the wallet is the account.

import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';

const NONCE_TTL = 10 * 60_000;
const SESSION_TTL = 7 * 24 * 3600_000;
export const COOKIE = 'snc_session';

export function isWallet(s) {
  try {
    return typeof s === 'string' && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

/** The exact text the wallet signs. Both sides rebuild it from the same parts, so nothing else can be slipped in. */
export function signInMessage({ domain, wallet, nonce, issuedAt, tournament }) {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    '',
    `Sign in to ${tournament}. This only proves you own this wallet: it costs nothing and moves no tokens.`,
    '',
    `URI: https://${domain}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
  ].join('\n');
}

export function createAuth(db, cfg) {
  const domain = new URL(cfg.publicUrl).host;
  return {
    /** Step 1: a nonce and the message for this wallet to sign. */
    challenge(wallet) {
      if (!isWallet(wallet)) throw Object.assign(new Error('that is not a Solana wallet address'), { status: 400 });
      const nonce = randomBytes(16).toString('hex');
      const issuedAt = Date.now();
      db.run('delete from nonces where expires_at < ?', issuedAt);
      db.run('insert into nonces (nonce, wallet, expires_at) values (?, ?, ?)', nonce, wallet, issuedAt + NONCE_TTL);
      return { nonce, message: signInMessage({ domain, wallet, nonce, issuedAt, tournament: cfg.name }) };
    },

    /** Step 2: check the signed message; returns a session token for the cookie. Each nonce works once. */
    verify({ wallet, message, signature }) {
      const bad = (m) => Object.assign(new Error(m), { status: 401 });
      if (!isWallet(wallet) || typeof message !== 'string' || typeof signature !== 'string') throw bad('wallet, message and signature are required');
      const nonce = /\nNonce: ([0-9a-f]{32})\n/.exec(message)?.[1];
      const issued = /\nIssued At: (\S+)$/.exec(message)?.[1];
      const row = nonce && db.get('select * from nonces where nonce = ?', nonce);
      if (!row || row.wallet !== wallet || row.expires_at < Date.now()) throw bad('that sign-in expired; try again');
      const expected = signInMessage({ domain, wallet, nonce, issuedAt: Date.parse(issued), tournament: cfg.name });
      if (message !== expected) throw bad('that is not the message we asked you to sign');
      let sig;
      try {
        sig = bs58.decode(signature);
      } catch {
        throw bad('the signature is not base58');
      }
      if (!nacl.sign.detached.verify(new TextEncoder().encode(message), sig, new PublicKey(wallet).toBytes())) throw bad('the signature does not match this wallet');
      db.run('delete from nonces where nonce = ?', nonce);
      const token = randomBytes(32).toString('base64url');
      db.run('insert into sessions (token, wallet, expires_at) values (?, ?, ?)', token, wallet, Date.now() + SESSION_TTL);
      return token;
    },

    /** The signed-in wallet for a request, or null. */
    walletOf(req) {
      const token = cookies(req)[COOKIE];
      if (!token) return null;
      const s = db.get('select wallet, expires_at from sessions where token = ?', token);
      return s && s.expires_at > Date.now() ? s.wallet : null;
    },

    signOut(req) {
      const token = cookies(req)[COOKIE];
      if (token) db.run('delete from sessions where token = ?', token);
    },

    cookie(token, maxAgeMs = SESSION_TTL) {
      const secure = cfg.publicUrl.startsWith('https://') ? '; Secure' : '';
      return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
    },
  };
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
