// Every rule of the tournament, from the environment (see .env.example). One deployment runs one tournament.

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => {
  const v = Number(env(k, d));
  if (!Number.isFinite(v)) throw new Error(`${k} must be a number`);
  return v;
};
const time = (k, d) => {
  const t = Date.parse(env(k, d));
  if (!Number.isFinite(t)) throw new Error(`${k} must be an ISO date, e.g. 2026-10-05T12:00:00Z`);
  return t;
};

/** The official $SMASH mint on Solana mainnet (a classic SPL token, 6 decimals). */
export const SMASH_MAINNET_MINT = '4VkfpAfHWFkBsVoSrAp4bos4yzWmJYj3z1LPNm1Dxory';

export function loadConfig() {
  const cluster = env('SOLANA_CLUSTER', 'devnet');
  if (!['devnet', 'mainnet-beta', 'testnet', 'localnet'].includes(cluster)) throw new Error('SOLANA_CLUSTER: devnet, mainnet-beta, testnet or localnet');
  const now = Date.now();
  const cfg = {
    name: env('TOURNAMENT_NAME', 'Smash Cup (example)'),
    startsAt: time('TOURNAMENT_STARTS', new Date(now).toISOString()),
    endsAt: time('TOURNAMENT_ENDS', new Date(now + 24 * 3600_000).toISOString()),
    /** > 0: the first player to this many wins ends the tournament early. */
    winTarget: num('WIN_TARGET', 0),
    ruleset: env('RULESET', 'mutators'),

    cluster,
    rpc: env('SOLANA_RPC', cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : `https://api.${cluster}.solana.com`),
    /** The RPC the browser sends signed transactions through (a public one by default). */
    publicRpc: env('SOLANA_PUBLIC_RPC', env('SOLANA_RPC', cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : `https://api.${cluster}.solana.com`)),
    commitment: env('SOLANA_COMMITMENT', cluster === 'mainnet-beta' ? 'finalized' : 'confirmed'),
    mint: env('SMASH_MINT', cluster === 'mainnet-beta' ? SMASH_MAINNET_MINT : ''),
    decimals: num('SMASH_DECIMALS', 6),
    poolKeypairPath: env('POOL_KEYPAIR', './keys/pool.json'),

    /** What one match entry costs, in whole tokens; all of it goes into the prize pool. */
    matchFee: num('MATCH_FEE', 10),
    /** The organizer's cut of the pool at settlement, in percent (0 = winner takes it all). */
    rakePercent: num('RAKE_PERCENT', 0),

    /** The most times two players may be paired in one tournament (blunts win-trading). */
    maxRepeatPairings: num('MAX_REPEAT_PAIRINGS', 2),
    /** The fewest different opponents a player must have beaten or played to be eligible to win. */
    minOpponentsToWin: num('MIN_OPPONENTS_TO_WIN', 2),
    /** Does a win by forfeit (no-show or stalling) count toward the standings? */
    forfeitsCount: env('FORFEITS_COUNT', '1') === '1',
    /** A seat not taken this many minutes after the match is made forfeits it. */
    showUpMinutes: num('SHOW_UP_MINUTES', 5),
    /** A player who doesn't move for this many minutes on their turn forfeits. */
    moveTimeoutMinutes: num('MOVE_TIMEOUT_MINUTES', 5),
    /** After the deadline, matches in play get this long to finish; then they're void. */
    settleGraceMinutes: num('SETTLE_GRACE_MINUTES', 20),
    /** 'person' asks entrants to play themselves (an honor rule); 'any' welcomes AI agents too. */
    playerKind: env('PLAYER_KIND', 'person'),

    /** ISO country codes that may not enter (checked against COUNTRY_HEADER, set by your host/CDN). */
    blockedRegions: env('BLOCKED_REGIONS', 'IN').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    countryHeader: env('COUNTRY_HEADER', 'x-vercel-ip-country').toLowerCase(),

    port: num('PORT', 8787),
    publicUrl: env('PUBLIC_URL', `http://localhost:${num('PORT', 8787)}`),
    dataDir: env('DATA_DIR', './data'),
    /** devnet only: a faucet route that mints test tokens and sends a little SOL to testers. */
    devFaucet: env('DEV_FAUCET', cluster === 'mainnet-beta' ? '0' : '1') === '1' && cluster !== 'mainnet-beta',
    smashApi: env('SMASH_API', 'https://www.smashandclash.in'),
    /** Other tournaments to show next to this one (their URLs: other deployments of this example). */
    peers: env('PEER_TOURNAMENTS', '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter((s) => /^https?:\/\//.test(s)),
    organizer: env('ORGANIZER_NAME', ''),
    /** A look (night, candy, sunset, forest, mono; empty = the default blue) and your platform's name in place of the logo. */
    theme: env('THEME', ''),
    brand: env('BRAND_NAME', ''),
  };
  // The Smash&Clash Terms (section 14A): a tournament with entry fees or prizes uses $SMASH only, states and
  // enforces its own minimum age, and is not offered in India. Devnet test tokens have no value, so a devnet
  // tournament is free to differ.
  if (cfg.cluster === 'mainnet-beta') {
    if (cfg.mint !== SMASH_MAINNET_MINT) throw new Error(`On mainnet a tournament may only use $SMASH (mint ${SMASH_MAINNET_MINT}): see the Smash&Clash Terms, section 14A.`);
    if (!cfg.blockedRegions.includes('IN')) cfg.blockedRegions.push('IN');
  }
  /** The minimum age to enter: 18, or what the law where you and your players are requires. Asked before the first paid entry. */
  cfg.minAge = num('MIN_AGE', 18);
  cfg.ageCheck = cfg.cluster === 'mainnet-beta' || env('AGE_CHECK', '0') === '1';
  if (cfg.endsAt <= cfg.startsAt) throw new Error('TOURNAMENT_ENDS must be after TOURNAMENT_STARTS');
  if (cfg.rakePercent < 0 || cfg.rakePercent > 100) throw new Error('RAKE_PERCENT must be 0-100');
  if (!['person', 'any'].includes(cfg.playerKind)) throw new Error("PLAYER_KIND must be 'person' or 'any'");
  return cfg;
}

/** Whole tokens -> base units (bigint), exactly. */
export function toUnits(amount, decimals) {
  const [whole, frac = ''] = String(amount).split('.');
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals in ${amount}`);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Base units -> a display string in whole tokens. */
export function fromUnits(units, decimals) {
  const u = BigInt(units);
  const neg = u < 0n;
  const a = neg ? -u : u;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / base}${frac ? `.${frac}` : ''}`;
}

export const explorerTx = (cfg, sig) => `https://explorer.solana.com/tx/${sig}${cfg.cluster === 'mainnet-beta' ? '' : `?cluster=${cfg.cluster}`}`;
export const explorerAddress = (cfg, addr) => `https://explorer.solana.com/address/${addr}${cfg.cluster === 'mainnet-beta' ? '' : `?cluster=${cfg.cluster}`}`;
