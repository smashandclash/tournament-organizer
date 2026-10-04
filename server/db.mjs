// The tournament's state, in one SQLite file (Node's built-in node:sqlite, so no native build).
// Every row that moves money keeps its on-chain signature, so the whole tournament can be audited.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
create table if not exists players (
  wallet text primary key,
  name text not null,
  created_at integer not null
);
create table if not exists nonces (
  nonce text primary key,
  wallet text not null,
  expires_at integer not null
);
create table if not exists sessions (
  token text primary key,
  wallet text not null,
  expires_at integer not null
);
-- one paid entry = one seat in one match
create table if not exists entries (
  id text primary key,
  wallet text not null,
  status text not null,            -- pending | queued | matched | refund-due | refunded | expired
  amount text not null,            -- base units
  reference text not null unique,  -- the Solana Pay reference key that ties the payment to this entry
  fee_signature text unique,
  created_at integer not null,
  queued_at integer,
  match_id text
);
create table if not exists matches (
  id text primary key,             -- the Smash&Clash game id
  wallet_a text not null,
  wallet_b text not null,
  entry_a text not null,
  entry_b text not null,
  invite_a text not null,
  invite_b text not null,
  status text not null,            -- waiting | active | finished | forfeit | void
  winner text,                     -- a wallet, or 'draw'
  reason text,                     -- how it ended: game | no-show | stalled | deadline | abandoned
  score text,
  move_count integer not null default 0,
  last_change_at integer not null,
  created_at integer not null,
  finished_at integer,
  watch_url text,
  replay_url text
);
-- every token transfer out of the pool. A payout is signed before it is sent and its signature saved first,
-- so a crash or a timeout can never pay twice: on restart the saved signature is checked on chain.
create table if not exists payouts (
  key text primary key,            -- prize | refund:<entry id>
  kind text not null,              -- prize | refund
  wallet text not null,
  amount text not null,            -- base units
  status text not null,            -- new | sending | sent
  signature text,
  raw text,                        -- the signed transaction (base64), rebroadcast until it lands or expires
  last_valid integer,              -- the block height after which it can no longer land
  note text,
  created_at integer not null,
  sent_at integer
);
create table if not exists meta (
  key text primary key,
  value text not null
);
`;

export function openDb(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'tournament.sqlite'));
  db.exec('pragma journal_mode = wal;');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const get = (sql, ...a) => q(sql).get(...a);
  const all = (sql, ...a) => q(sql).all(...a);
  const run = (sql, ...a) => q(sql).run(...a);
  return {
    db,
    get,
    all,
    run,
    /** Run fn in one transaction (all or nothing). */
    tx(fn) {
      db.exec('begin immediate');
      try {
        const r = fn();
        db.exec('commit');
        return r;
      } catch (e) {
        db.exec('rollback');
        throw e;
      }
    },
    meta(key, value) {
      if (value === undefined) return get('select value from meta where key = ?', key)?.value ?? null;
      run('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value', key, String(value));
      return value;
    },
  };
}
