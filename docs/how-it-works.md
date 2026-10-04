# How it works

Tournament Organizer is one Node process (the server) and one dependency-free web app (`web/`). The server
owns the tournament: entries, money, pairing, results and payouts. The browser owns play: each player
claims their own seat with the Smash&Clash SDK and plays it. Smash&Clash's game server decides every result.

> Smash&Clash is not responsible for any tournament built with this code. See the README's
> [Who is responsible](../README.md#who-is-responsible).

## The pieces

```text
browser (web/)                        organiser's server (server/)                outside
─────────────                         ──────────────────────────                ───────
app.js      views, wallets, entries ─► index.mjs   HTTP, CSP, rate limits
wallet.js   Wallet Standard + test     auth.mjs    sign in with a wallet
game.js     plays its seat  ───────────────────────────────────────────────────► Smash&Clash API (SDK)
watch.js    spectate, replays ─────────────────────────────────────────────────► Smash&Clash API (SDK)
            pays its entry ────────────────────────────────────────────────────► Solana (its own wallet)
                                       tournament.mjs  the clock: pair, watch,  ─► Smash&Clash API (SDK)
                                                       refund, settle, pay     ─► Solana (the pool wallet)
                                       chain.mjs       fee txs, verify, payouts
                                       rules.mjs       standings, winner, pairing (pure)
                                       db.mjs          SQLite: every signature kept
```

## An entry, step by step

1. **Sign in.** The browser asks `POST /api/auth/nonce` for a one-time message naming the site and the wallet,
   the wallet signs it (free, moves nothing), and `POST /api/auth/verify` checks the ed25519 signature and
   sets an HttpOnly session cookie. Each nonce works once and expires in ten minutes.
2. **Enter.** `POST /api/entries` checks the tournament is open, the wallet has no match in progress and holds
   enough tokens, then builds the fee transaction itself: a `transferChecked` of exactly `MATCH_FEE` from the
   player's token account to the pool's, with a fresh **reference key** (a Solana Pay convention) and a memo
   naming the entry. The player is the only signer.
3. **Pay.** The player's wallet signs and sends it (a Wallet Standard wallet's `signAndSendTransaction`, or the
   devnet test wallet signing the message and sending it through the RPC).
4. **Confirm.** The browser reports the signature; `POST /api/entries/:id/confirm` reads the transaction from
   the chain and accepts it only if it succeeded, carries the entry's reference, was signed by the player, and
   moved exactly the fee from the player to the pool (by token-balance changes, not by what anyone says). A
   signature can pay for one entry only. If the browser closed before reporting, the clock finds the payment
   by its reference key anyway.
5. **Queue.** The entry waits for an opponent. Leaving the queue now refunds it.

## The clock

Every four seconds the server runs one tick (`tournament.tick()`):

- **reconcile**: payments the browser never reported, found by reference; late payments are refunded.
- **pair**: queued entries, oldest first, never the same wallet, and not past `MAX_REPEAT_PAIRINGS`. Each pair
  becomes a Smash&Clash match made with `games.createMatch` (both seats named by the tournament, so nobody can
  rename themselves inside the game). Each player gets their own invite link; nobody else ever sees it.
- **watch**: every match in play is read with `games.watch`. A finished game records the winner and score. A
  seat not claimed in `SHOW_UP_MINUTES` forfeits; a player who does not move in `MOVE_TIMEOUT_MINUTES` on their
  turn forfeits; in a people-only tournament a seat that says an agent plays it forfeits.
- **payouts**: refunds owed are sent.
- **settle**: once the tournament has closed and no match is in play.

## Settlement

The tournament closes at `TOURNAMENT_ENDS`, or as soon as someone reaches `WIN_TARGET` wins against enough
different opponents. Matches still in play get `SETTLE_GRACE_MINUTES` after a deadline (and are refunded if
they run over); when a win target closes it, matches in play are refunded at once. Then:

1. entries still in the queue, and unpaid ones, are refunded or expired;
2. the winner is picked from the standings (most wins; then fewer losses; then whoever got there first) among
   players with at least `MIN_OPPONENTS_TO_WIN` different opponents. Nobody qualifies: every fee is refunded;
3. the pot (every matched entry's fee) is split: `RAKE_PERCENT` stays in the pool, the rest is paid to the
   winner, after checking the pool really holds it.

`npm run settle` prints the books; `npm run settle -- --pay` does the same settlement by hand when the server
was down at the deadline (it refuses while the server is running).

## Payouts that never pay twice

A payout moves through `new → sending → sent`. Before anything is sent, the transaction is signed and its
signature and raw bytes are saved. On every tick a `sending` payout is checked by that one signature: landed →
`sent`; still pending → broadcast the same bytes again (a signature can only land once); expired (its
blockhash can no longer land) → sign a fresh one. A crash or a timeout at any point resolves the same way.

## The app

`web/app.js` is the shell: an app bar, a nav (sidebar from 1024 px, a rail from 768 px, a bottom tab bar below),
a docked primary action, and views kept in the URL (`#/`, `#/events`, `#/practice`, `#/ranks`, `#/matches`,
`#/wallet`, `#/rules`, `#/sdk`). Full-screen layers: a tournament match (`#/match`), a practice game (`#/play`),
a live game (`#/watch/<id>`), a replay (`#/replay/<id>`). Each region redraws only when its data changed, and
keeps keyboard focus when it does. Data from Smash&Clash that views show (agent profiles, open duels, live
games, the deck) goes through a small cache that redraws the view when it lands.

`web/game.js` plays any game: a tournament seat (claimed from the invite, resumed after a reload), or a practice
game started with `startHouse`, `quickMatch`, `createDuel` or `joinDuel`. It long-polls between turns, shows
the seat's move feed from `game.sync`, a hint from `greedyMove` in practice, and a Game Review at the end.

## Data

One SQLite file (`DATA_DIR/tournament.sqlite`): `players`, `nonces`, `sessions`, `entries` (with the fee's
signature and reference), `matches` (with both invites, the result, how it ended), `payouts` (with signatures)
and `meta` (when it closed, the winner, the prize, the server's heartbeat). Back it up; it is the audit trail.
