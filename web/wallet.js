// Wallets, without a bundler: any Wallet Standard wallet (Phantom, Solflare, Backpack, …) plus, on devnet
// only, a throwaway test wallet kept in this browser so anyone can try the tournament in one click.
//
// Every wallet here exposes the same three things:
//   address                         base58 public key
//   signMessage(bytes)              -> Uint8Array signature (sign-in)
//   signAndSend({ transaction, message }) -> base58 signature (the entry fee)

/* --------------------------------- base58 --------------------------------- */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

/* ---------------------------------- RPC ----------------------------------- */

export async function rpc(url, method, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const sendRaw = (url, tx) => rpc(url, 'sendTransaction', [toBase64(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }]);

/* ----------------------------- Wallet Standard ----------------------------- */

const standard = [];
function register(...wallets) {
  for (const w of wallets) if (!standard.includes(w)) standard.push(w);
  return () => {};
}
// the Wallet Standard handshake: wallets that loaded before us answer app-ready, later ones announce themselves
window.addEventListener('wallet-standard:register-wallet', (e) => e.detail?.({ register }));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));

const chainOf = (cluster) => `solana:${cluster === 'mainnet-beta' ? 'mainnet' : cluster}`;

/** The installed wallets that can sign in and pay on this cluster. */
export function installedWallets(cluster) {
  return standard.filter(
    (w) =>
      w.features['standard:connect'] &&
      w.features['solana:signMessage'] &&
      (w.features['solana:signAndSendTransaction'] || w.features['solana:signTransaction']) &&
      (!w.chains?.length || w.chains.some((c) => c.startsWith('solana:')))
  );
}

/** Connect a Wallet Standard wallet. */
export async function connectStandard(w, { cluster, rpcUrl }) {
  const { accounts } = await w.features['standard:connect'].connect();
  const account = accounts?.[0] ?? w.accounts?.[0];
  if (!account) throw new Error(`${w.name} did not share an account`);
  const chain = chainOf(cluster);
  return {
    name: w.name,
    icon: w.icon,
    kind: 'standard',
    address: account.address,
    async signMessage(bytes) {
      const [r] = await w.features['solana:signMessage'].signMessage({ account, message: bytes });
      return r.signature;
    },
    async signAndSend({ transaction }) {
      const f = w.features['solana:signAndSendTransaction'];
      if (f) {
        const [r] = await f.signAndSendTransaction({ account, transaction, chain });
        return base58(r.signature);
      }
      const [r] = await w.features['solana:signTransaction'].signTransaction({ account, transaction, chain });
      return sendRaw(rpcUrl, r.signedTransaction);
    },
    disconnect: () => w.features['standard:disconnect']?.disconnect(),
  };
}

/* ------------------------- the devnet test wallet -------------------------- */

const BURNER_KEY = 'snc-tournament:test-wallet';

/** A throwaway devnet wallet in localStorage. Never use it for anything of value. */
export function testWallet({ cluster, rpcUrl }) {
  if (cluster === 'mainnet-beta') throw new Error('The test wallet is for devnet only.');
  const nacl = window.nacl;
  let secret;
  try {
    const saved = localStorage.getItem(BURNER_KEY);
    if (saved) secret = fromBase64(saved);
  } catch {}
  if (!secret || secret.length !== 64) {
    secret = nacl.sign.keyPair().secretKey;
    try {
      localStorage.setItem(BURNER_KEY, toBase64(secret));
    } catch {}
  }
  const kp = nacl.sign.keyPair.fromSecretKey(secret);
  return {
    name: 'Test wallet (this browser, devnet)',
    icon: null,
    kind: 'test',
    address: base58(kp.publicKey),
    async signMessage(bytes) {
      return nacl.sign.detached(bytes, kp.secretKey);
    },
    async signAndSend({ message }) {
      // a transaction with one signer on the wire: [1 signature] [64-byte signature] [message]
      const sig = nacl.sign.detached(message, kp.secretKey);
      const tx = new Uint8Array(1 + 64 + message.length);
      tx[0] = 1;
      tx.set(sig, 1);
      tx.set(message, 65);
      return sendRaw(rpcUrl, tx);
    },
    disconnect() {},
  };
}

/** The wallet's token and SOL balances, read straight from the chain. */
export async function balances(rpcUrl, owner, mint) {
  const [tok, sol] = await Promise.all([
    rpc(rpcUrl, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] })),
    rpc(rpcUrl, 'getBalance', [owner, { commitment: 'confirmed' }]).catch(() => ({ value: 0 })),
  ]);
  const tokens = tok.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmountString), 0);
  return { tokens, sol: sol.value / 1e9 };
}
