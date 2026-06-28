-- WorldStore / AccountStore tables (apps/server/src/pg.ts). These back the EXACT
-- async interfaces the in-memory stores implement, so the tick worker + HTTP layer
-- run unchanged against Postgres. The WorldState value object is stored verbatim as
-- jsonb (docs/PHASE2.md §5 — "jsonb holds the sim's value objects"); fixtures and the
-- tick-log are rows for the queryable record + DB-enforced idempotency.
--
-- This is the pragmatic store the current interface needs; 0001_init.sql is the fuller
-- NORMALIZED §5 schema (club/player rows for rich queries) — the two converge when the
-- store interface grows queries beyond load/save of the whole world.
--
-- Apply: psql "$DATABASE_URL" -f 0002_worldstore.sql  (after 0001). Not yet run in CI.

-- the whole WorldState as one jsonb blob, keyed by the store's opaque id
create table ace_world (
  id         text primary key,
  snapshot   jsonb not null,
  created_at timestamptz not null default now()
);

-- resolved fixtures (the FixtureRow value object as jsonb — index-keyed, as the
-- engine uses club indices within a match; insertion order preserved via the serial id)
create table ace_fixture (
  id        bigserial primary key,
  world_id  text not null references ace_world(id) on delete cascade,
  season    int not null,
  day       int not null,
  slot      int not null,
  data      jsonb not null
);
create index on ace_fixture (world_id, season);

-- the idempotency log: the PRIMARY KEY is the idempotency key, so a retried tick that
-- tries to record the same (world, season, day, kind) fails at the DB — never double-resolves
create table ace_tick_log (
  world_id  text not null references ace_world(id) on delete cascade,
  season    int not null,
  day       int not null,
  kind      text not null,                 -- matchday | rollover
  fixtures  int not null default 0,
  recorded_at timestamptz not null default now(),
  primary key (world_id, season, day, kind)
);

-- accounts span worlds (one login, many shards) — separate from the world tables
create table ace_account (
  id            text primary key,
  email         text unique not null,       -- lowercased by the store; unique = one account per email
  password_hash text not null,
  created_at    double precision not null   -- epoch seconds (the injectable clock)
);

-- refresh tokens, stored HASHED + rotated in place (revoked on use → single-use)
create table ace_refresh (
  token_hash text primary key,
  account_id text not null references ace_account(id) on delete cascade,
  expires_at double precision not null,
  revoked    boolean not null default false
);
create index on ace_refresh (account_id);
