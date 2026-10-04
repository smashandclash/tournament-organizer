# Going to mainnet

The example runs on devnet with a worthless test token. Running it with real $SMASH makes it a real-money
contest, with real legal duties and real losses if anything goes wrong.

> **Smash&Clash is not responsible for any tournament you run, in any way**, and gives no warranty for this code.
> You run it alone. Read the README's [Who is responsible](../README.md#who-is-responsible) and the developer
> section of the [Smash&Clash Terms](https://www.smashandclash.in/terms#developers).

## 1. The law, first

- Get legal advice for where **you** are and where **your players** are. Paid contests, prize pools and token
  payments are regulated or banned in many places (gambling and gaming law, skill-game rules, money
  transmission, anti-money-laundering, sanctions, consumer protection, tax).
- **The Smash&Clash Terms require**: $SMASH only for every entry, stake, prize and organiser cut; no paid
  tournaments for anyone in India; a minimum age you state and enforce (18, or what the law requires); and a
  clear notice that the tournament is run by you, not by Smash&Clash. The server enforces the first two on
  mainnet and asks players to confirm the age before their first paid entry.
- Add every other restricted region to `BLOCKED_REGIONS`, and make sure your host or CDN sets `COUNTRY_HEADER`
  (a header can be wrong or missing: it is a filter, not a guarantee).
- Publish your own rules, terms and privacy policy, and link them in the app.

## 2. The settings

```dotenv
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC=https://<your own RPC provider>
SOLANA_PUBLIC_RPC=https://<an RPC your players' browsers may use>
# SMASH_MINT defaults to $SMASH (4VkfpAfHWFkBsVoSrAp4bos4yzWmJYj3z1LPNm1Dxory); any other mint is refused
POOL_KEYPAIR=/secure/path/pool.json
DEV_FAUCET=0
MIN_AGE=18
BLOCKED_REGIONS=IN,<every other region you must block>
PUBLIC_URL=https://<your domain>
```

`SOLANA_COMMITMENT` becomes `finalized` on mainnet by default.

## 3. The pool wallet

- Create a fresh wallet just for this tournament. Fund it with a little SOL for transaction fees and the
  token-account rent of winners who have none yet.
- Keep its key out of git, off shared machines, and backed up offline. Better: a multisig or an escrow program
  (see [trust-model.md](trust-model.md)).
- After settlement, move what is left (the rake, any stray tokens) to cold storage.

## 4. The server

- Your own RPC provider: the public ones rate-limit, and an RPC that drops your requests delays entries.
- HTTPS, a persistent disk, backups of `DATA_DIR`, logs you keep, and monitoring that the clock is running.
- One process per tournament, always on through the deadline and settlement. If it was down at the deadline,
  `npm run settle -- --pay` finishes the job.

## 5. Test, then audit

- Run the whole thing on devnet with real people: entries, a no-show, a stall, leaving the queue, the deadline,
  a win target, settlement, a refund. `npm run simulate` helps with volume.
- Read the code. It has not been audited. Get a security review before real money, especially of
  `server/chain.mjs` and `server/tournament.mjs`.
- Start small: a low entry, a short window, a pool you could afford to lose.

## 6. Tell players the truth

Say who runs the tournament (you), who holds the pool (you), how the winner is decided and paid, what happens
if something breaks, the minimum age, and that Smash&Clash is not involved or responsible. The app's notices
say most of this; keep them, and add your own terms.
