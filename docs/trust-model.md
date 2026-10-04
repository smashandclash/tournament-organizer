# The trust model

Who has to trust whom, what the code makes checkable, and what it cannot fix.

> **Smash&Clash is not part of this.** It does not run, hold, guarantee or answer for any tournament built
> with this code, and it never touches the money. Everything below is between the organiser and the players.

## What players trust

**The organiser.** The prize pool is a Solana wallet the organiser controls (`POOL_KEYPAIR`). Whoever holds that
key can move the pool. Players trust the organiser to:

- run the code as published (or tell them what changed);
- pay the winner and the refunds;
- keep the pool key safe;
- run the tournament lawfully where it is offered.

**The Smash&Clash game server, for results only.** It plays the games and reports who won. It does not know a
tournament exists or that money is involved, and it makes no promise that a game will start, finish or be
available. The organiser's rules decide what happens when it is not (this code refunds matches cut off by the
deadline).

**Solana and the RPC** to carry the transactions.

## What the code makes checkable

- **The pool is public.** Anyone can watch the pool's token account on an explorer; the app links to it and shows
  its on-chain balance next to the pot.
- **Every token movement has a signature.** Entry fees, refunds and the prize are Solana transactions, saved
  with their signatures; payouts are listed in the app with explorer links, and `npm run settle` prints them all.
- **Entries are verified on chain**, by balance changes and a reference key, never by what a browser reports.
- **Results come from the game server.** The organiser's server reads them with the SDK; players' browsers
  cannot report a result.
- **Pairing is not chosen.** Oldest first, a repeat cap, and a minimum number of different opponents to win.
- **Payouts cannot double-pay**, even across crashes (signed first, then sent, then checked by signature).

## What it cannot do

- **Stop an organiser from taking the pool.** A custodial wallet means trusting its holder. If that is not
  acceptable, see "Making it trust-minimised" below.
- **Know who is behind a wallet.** No KYC, no age verification beyond a self-declared minimum age, no sanctions
  screening. Organisers who need these must add them.
- **Stop collusion completely.** The repeat cap and the opponent minimum blunt win-trading and sybil wallets but
  do not prevent them. Someone with many wallets can still try.
- **Prove a person played.** "People only" is an honour rule plus the seat's declared kind; an AI agent that
  lies about itself is not detected.
- **Survive a lost or leaked key.** Lose `keys/pool.json` and the pool is gone; leak it and anyone can take it.

## Making it trust-minimised

The tournament only talks to the pool through `chain.pool` (`address`, `tokenAccount`, `balance()`,
`prepare()`, `submit()`, `check()` in `server/chain.mjs`). Swap in:

- **A multisig** (for example Squads): payouts need several signers; nobody can take the pool alone.
- **An escrow program**: entry fees go to a program-owned account and only a settlement instruction can release
  them, to the winner the program can verify (for example from a signed result, or an oracle that replays the
  game from its public moves). This removes custody from the organiser, at the cost of writing and auditing a
  Solana program.

## The organiser's checklist

Keep the pool key offline or in a key manager, run the server on a machine you control, back up the database,
publish your rules and terms, keep the "run by the organiser, not by Smash&Clash" notice the app shows, and get
legal advice. See [going-to-mainnet.md](going-to-mainnet.md).
