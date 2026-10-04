// Solana: the entry fee a player signs, its on-chain verification, and the prize pool.
//
// Fees are SPL-token transfers ($SMASH) from the player's wallet into the pool's token account. The server
// builds the transaction (with a one-off Solana Pay "reference" key and a memo naming the entry), the
// player's wallet signs and sends it, and the server verifies the result on chain from the token-balance
// changes, never from what the browser says.

import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const memoIx = (text) => new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text, 'utf8') });

export function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

/**
 * The fee transaction for one entry, unsigned, for the player's wallet to sign and send.
 * The player is the only signer and pays the network fee.
 * @returns {{ transaction: string, message: string }} base64 of the whole transaction, and of its message
 */
export async function buildFeeTransaction({ connection, cfg, payer, poolOwner, amount, reference, memo }) {
  const mint = new PublicKey(cfg.mint);
  const from = getAssociatedTokenAddressSync(mint, payer);
  const to = getAssociatedTokenAddressSync(mint, poolOwner);
  const ix = createTransferCheckedInstruction(from, mint, to, payer, amount, cfg.decimals);
  ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false }); // lets anyone find this payment by its reference
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(cfg.commitment);
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(ix, memoIx(memo));
  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    message: tx.serializeMessage().toString('base64'),
  };
}

/** How much of `mint` the wallet holds (base units), or 0n when it has no token account yet. */
export async function tokenBalance(connection, cfg, owner) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(cfg.mint), new PublicKey(owner));
  try {
    return BigInt((await connection.getTokenAccountBalance(ata, cfg.commitment)).value.amount);
  } catch {
    return 0n;
  }
}

/** The change in an owner's balance of `mint` across a parsed transaction (base units). */
export function tokenDelta(meta, owner, mint) {
  const sum = (list) => (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
}

/**
 * Did this signature pay this entry? Checks the transaction succeeded, carries the entry's reference key,
 * was signed by the player, and moved exactly `amount` of the mint from the player to the pool.
 * @returns {Promise<{ ok: true } | { ok: false, retry?: boolean, reason: string }>}
 */
export async function verifyFeePayment({ connection, cfg, signature, payer, poolOwner, amount, reference }) {
  let tx;
  try {
    tx = await connection.getParsedTransaction(signature, { commitment: cfg.commitment, maxSupportedTransactionVersion: 0 });
  } catch (e) {
    return { ok: false, retry: true, reason: `could not read the transaction yet (${e.message})` };
  }
  if (!tx) return { ok: false, retry: true, reason: 'the transaction is not confirmed yet' };
  if (tx.meta?.err) return { ok: false, reason: 'the transaction failed on chain' };
  const keys = tx.transaction.message.accountKeys.map((k) => ({ key: k.pubkey.toString(), signer: k.signer }));
  if (!keys.some((k) => k.key === reference)) return { ok: false, reason: "the transaction doesn't carry this entry's reference" };
  if (!keys.some((k) => k.key === payer && k.signer)) return { ok: false, reason: 'the transaction was not signed by your wallet' };
  const into = tokenDelta(tx.meta, poolOwner, cfg.mint);
  const out = tokenDelta(tx.meta, payer, cfg.mint);
  if (into !== amount || out !== -amount) return { ok: false, reason: `the transaction moved ${into} units into the pool, not ${amount}` };
  return { ok: true };
}

/**
 * The prize pool, held by a wallet the organizer controls. Anyone can watch its token account on an
 * explorer. To make it trust-minimized, replace this class with one that talks to an escrow program;
 * the tournament only uses address, tokenAccount, balance(), prepare(), submit() and check().
 *
 * Payouts are signed first and sent second, so the signature is known (and saved) before anything goes
 * out: a timeout or a crash can always be resolved by asking the chain about that one signature.
 */
export class CustodialPool {
  constructor({ connection, cfg, keypair }) {
    this.connection = connection;
    this.cfg = cfg;
    this.keypair = keypair;
    this.mint = new PublicKey(cfg.mint);
    this.owner = keypair.publicKey;
    this.address = this.owner.toBase58();
    this.tokenAccount = getAssociatedTokenAddressSync(this.mint, this.owner).toBase58();
  }
  /** The pool's real balance on chain (base units). */
  balance() {
    return tokenBalance(this.connection, this.cfg, this.owner);
  }
  /** Sign (not send) a transfer of `units` to a wallet, creating its token account if needed. */
  async prepare(wallet, units, memo) {
    const dest = new PublicKey(wallet);
    const destAta = getAssociatedTokenAddressSync(this.mint, dest);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.cfg.commitment);
    const tx = new Transaction({ feePayer: this.owner, blockhash, lastValidBlockHeight }).add(
      createAssociatedTokenAccountIdempotentInstruction(this.owner, destAta, dest, this.mint),
      createTransferCheckedInstruction(new PublicKey(this.tokenAccount), this.mint, destAta, this.owner, BigInt(units), this.cfg.decimals),
      memoIx(memo)
    );
    tx.sign(this.keypair);
    return { signature: bs58.encode(tx.signature), raw: tx.serialize().toString('base64'), lastValidBlockHeight };
  }
  /** Broadcast a prepared transaction (again, if need be: the same signature can only land once). */
  async submit(raw) {
    await this.connection.sendRawTransaction(Buffer.from(raw, 'base64'), { preflightCommitment: this.cfg.commitment, maxRetries: 0 });
  }
  /** 'landed' | 'failed' | 'pending' | 'expired' (expired = it can never land, so it is safe to prepare a new one). */
  async check(signature, lastValidBlockHeight) {
    const { value } = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = value[0];
    if (st?.err) return 'failed';
    const want = this.cfg.commitment === 'finalized' ? ['finalized'] : ['confirmed', 'finalized'];
    if (st && want.includes(st.confirmationStatus)) return 'landed';
    if (st) return 'pending';
    const height = await this.connection.getBlockHeight(this.cfg.commitment);
    return height > lastValidBlockHeight ? 'expired' : 'pending';
  }
}

/** Everything the tournament needs from Solana, in one object (tests swap in a fake). */
export function createChain({ connection, cfg, poolKeypair }) {
  const pool = new CustodialPool({ connection, cfg, keypair: poolKeypair });
  return {
    pool,
    newReference: () => Keypair.generate().publicKey.toBase58(),
    balanceOf: (wallet) => tokenBalance(connection, cfg, wallet),
    buildFee: ({ payer, amount, reference, memo }) =>
      buildFeeTransaction({ connection, cfg, payer: new PublicKey(payer), poolOwner: pool.owner, amount, reference: new PublicKey(reference), memo }),
    verifyFee: ({ signature, payer, amount, reference }) =>
      verifyFeePayment({ connection, cfg, signature, payer, poolOwner: pool.address, amount, reference }),
    /** Signatures that carry this reference key (a payment the browser sent but never reported). */
    findPayments: async (reference) =>
      (await connection.getSignaturesForAddress(new PublicKey(reference), { limit: 10 }, cfg.commitment === 'finalized' ? 'finalized' : 'confirmed'))
        .filter((s) => !s.err)
        .map((s) => s.signature),
    /** devnet only: mint test tokens and send a little SOL for network fees (the pool is the test mint's authority). */
    async faucet(wallet, tokens, sol) {
      const dest = new PublicKey(wallet);
      const mint = new PublicKey(cfg.mint);
      const ata = getAssociatedTokenAddressSync(mint, dest);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(pool.owner, ata, dest, mint),
        createMintToCheckedInstruction(mint, ata, pool.owner, tokens, cfg.decimals),
        SystemProgram.transfer({ fromPubkey: pool.owner, toPubkey: dest, lamports: Math.round(sol * LAMPORTS_PER_SOL) })
      );
      return sendAndConfirmTransaction(connection, tx, [poolKeypair], { commitment: 'confirmed' });
    },
  };
}
