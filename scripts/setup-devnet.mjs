// One-time devnet setup: a pool wallet, a test token that stands in for $SMASH, and a .env.
//   npm run setup:devnet
//
// Devnet tokens are free and worthless, so nobody risks anything while you build. The test token has the
// same shape as $SMASH (a classic SPL token, 6 decimals); on mainnet you use the real mint instead.
// The pool wallet is the test token's mint authority, so the server's dev faucet can hand testers tokens.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const KEY = resolve(process.env.POOL_KEYPAIR || './keys/pool.json');
const ENV = resolve('.env');

if (process.env.SOLANA_CLUSTER && process.env.SOLANA_CLUSTER !== 'devnet') {
  console.error('This script only sets up devnet. For mainnet, read docs/going-to-mainnet.md.');
  process.exit(1);
}

const connection = new Connection(RPC, 'confirmed');

// 1. the pool wallet (kept, if you run this again)
mkdirSync(resolve('keys'), { recursive: true });
let pool;
if (existsSync(KEY)) {
  pool = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, 'utf8'))));
  console.log(`pool wallet   ${pool.publicKey.toBase58()} (existing ${KEY})`);
} else {
  pool = Keypair.generate();
  writeFileSync(KEY, JSON.stringify([...pool.secretKey]), { mode: 0o600 });
  console.log(`pool wallet   ${pool.publicKey.toBase58()} (new, saved to ${KEY})`);
}

// 2. devnet SOL for network fees (the public faucet is rate-limited; it may take a retry, or use faucet.solana.com)
let sol = await connection.getBalance(pool.publicKey);
if (sol < 0.2 * LAMPORTS_PER_SOL) {
  for (const amount of [1, 0.5]) {
    try {
      const sig = await connection.requestAirdrop(pool.publicKey, amount * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      sol = await connection.getBalance(pool.publicKey);
      break;
    } catch (e) {
      console.log(`airdrop of ${amount} SOL failed: ${e.message.split('\n')[0]}`);
    }
  }
}
console.log(`devnet SOL    ${sol / LAMPORTS_PER_SOL}`);
if (sol < 0.05 * LAMPORTS_PER_SOL) {
  console.error(`\nThe pool wallet needs devnet SOL. Get some at https://faucet.solana.com for:\n  ${pool.publicKey.toBase58()}\nthen run this again.`);
  process.exit(2);
}

// 3. the test token (kept in .env, if you run this again)
const env = existsSync(ENV) ? readFileSync(ENV, 'utf8') : readFileSync(resolve('.env.example'), 'utf8');
let mint = /^SMASH_MINT=(\w+)/m.exec(env)?.[1];
if (mint && (await connection.getAccountInfo(new PublicKey(mint)))) {
  console.log(`test mint     ${mint} (existing)`);
} else {
  const m = await createMint(connection, pool, pool.publicKey, null, 6);
  mint = m.toBase58();
  console.log(`test mint     ${mint} (new: "test $SMASH", 6 decimals, the pool wallet can mint)`);
}

// 4. the pool's token account, where every entry fee lands
const ata = await getOrCreateAssociatedTokenAccount(connection, pool, new PublicKey(mint), pool.publicKey);
console.log(`pool account  ${ata.address.toBase58()}`);

// 5. .env
const set = (text, key, value) => (new RegExp(`^#?\\s*${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^#?\\s*${key}=.*$`, 'm'), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`);
let out = env;
out = set(out, 'SOLANA_CLUSTER', 'devnet');
out = set(out, 'SMASH_MINT', mint);
out = set(out, 'POOL_KEYPAIR', './keys/pool.json');
writeFileSync(ENV, out);
console.log(`\nWrote ${ENV}. Start the server with:  npm start`);
console.log(`Watch the pool on the explorer: https://explorer.solana.com/address/${ata.address.toBase58()}?cluster=devnet`);
