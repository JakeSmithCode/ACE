-- ACE Phase-2 schema (docs/PHASE2.md §5). Plain Postgres, self-hostable, no BaaS —
-- a "your club, forever" promise can't sit on a vendor (DESIGN §16). UUID PKs, jsonb
-- for the sim's value objects (rosters/tactics/comp/plan/patch are stored verbatim
-- so the row IS the WorldState the pure @ace/world functions already take). The
-- WorldStore / AccountStore interfaces in apps/server map onto these tables 1:1, so
-- the PgStore that executes this migration changes NO resolution code.
--
-- This file is the schema artifact; it has NOT been run against a live database in
-- this environment (no Postgres here). Apply with `psql -f` (see infra/README.md).

create extension if not exists "uuid-ossp";
create extension if not exists "citext";

-- ── identity (self-owned auth — our own tables, never a vendor) ──────────────
create table account (
  id            uuid primary key default uuid_generate_v4(),
  email         citext unique not null,
  password_hash text not null,                 -- scrypt `salt:hash` (auth.ts), argon2id later
  email_verified boolean not null default false,
  vip_until     timestamptz,                   -- Stripe sets this; null = free (never pay-to-win)
  region        text,
  status        text not null default 'active',
  created_at    timestamptz not null default now()
);

create table refresh_token (
  id          uuid primary key default uuid_generate_v4(),
  account_id  uuid not null references account(id) on delete cascade,
  token_hash  text not null unique,            -- sha256 of the opaque token (never the token itself)
  expires_at  timestamptz not null,
  revoked_at  timestamptz,                     -- set on rotation → single-use refresh
  created_at  timestamptz not null default now()
);
create index on refresh_token (account_id);

-- ── a shard: one region's pyramid, one seed, one clock ──────────────────────
create table world (
  id             uuid primary key default uuid_generate_v4(),
  region         text not null,
  seed           bigint not null,
  season         int not null default 1,
  day            int not null default 0,
  layout         jsonb not null,               -- groups-per-tier (the fan-out pyramid, e.g. [1,2,4])
  tiers          int not null,
  size           int not null,
  promo          int not null default 2,
  patch          jsonb not null,               -- PatchState (the living meta), pinned per world
  engine_version text not null,                -- §7 reproducibility: the build that produced its fixtures
  status         text not null default 'live',
  created_at     timestamptz not null default now()
);

-- ── clubs: AI by default, a human owner is an overlay (§4) ───────────────────
create table club (
  id               uuid primary key default uuid_generate_v4(),
  world_id         uuid not null references world(id) on delete cascade,
  slug             text not null,              -- public club page key (the tag, lowercased)
  name             text not null,
  tag              text not null,
  tier             int not null,
  grp              int not null default 0,     -- the (tier, grp) division dimension
  owner_account_id uuid references account(id),-- null = AI-run (revert sets it back to null)
  strength         real not null,
  balance          bigint not null default 0,
  titles           int not null default 0,
  plan             jsonb not null,             -- (tactics, comp, lineup) — ALWAYS present (§4); lineup optional
  created_at       timestamptz not null default now(),
  unique (world_id, slug),
  unique (world_id, tag)
);
create index on club (world_id, tier, grp);
create index on club (owner_account_id);

-- ── rosters (depth ≥ 5; the matchday five is derived, as in @ace/world) ──────
create table player (
  id         uuid primary key default uuid_generate_v4(),
  world_id   uuid not null references world(id) on delete cascade,
  club_id    uuid references club(id) on delete set null,   -- null = free agent
  handle     text not null,
  role       text not null,
  age        int not null,
  attr       jsonb not null,                  -- the live attribute block
  potential  jsonb not null,                  -- per-attribute ceilings (fogged by scouting)
  agents     jsonb not null,                  -- mastery per agent
  contract   jsonb,                           -- { wage, years } locked at signing (optional)
  value      bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (world_id, handle)                   -- the engine assumes unique handles per match
);
create index on player (world_id, club_id);

-- ── fixtures: the canonical record (the schedule itself is pure, not stored) ─
create table fixture (
  id             uuid primary key default uuid_generate_v4(),
  world_id       uuid not null references world(id) on delete cascade,
  season         int not null,
  tier           int not null,
  grp            int not null default 0,
  day            int not null,
  slot           int not null,
  home_club_id   uuid not null references club(id),
  away_club_id   uuid not null references club(id),
  seed           bigint not null,             -- stable fixture seed (re-sim to watch)
  status         text not null default 'scheduled',  -- scheduled | live | resolved
  home_score     int,
  away_score     int,
  winner_club_id uuid references club(id),
  kickoff_at     timestamptz,                 -- the live broadcast window (live.ts) …
  broadcast_secs int,                         -- … fixed duration → reveal at kickoff_at + this
  engine_version text,
  input_snapshot jsonb,                       -- present only for WATCHABLE fixtures (§7), a few KB
  resolved_at    timestamptz,
  unique (world_id, season, tier, grp, day, slot)
);
create index on fixture (world_id, season, tier, grp);

-- ── market: live board + history ────────────────────────────────────────────
create table listing (
  id         uuid primary key default uuid_generate_v4(),
  world_id   uuid not null references world(id) on delete cascade,
  club_id    uuid not null references club(id) on delete cascade,
  player_id  uuid not null references player(id) on delete cascade,
  ask        bigint not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table transfer (
  id           uuid primary key default uuid_generate_v4(),
  world_id     uuid not null references world(id) on delete cascade,
  season       int not null,
  player_id    uuid not null references player(id),
  from_club_id uuid references club(id),
  to_club_id   uuid references club(id),
  fee          bigint not null,
  kind         text not null,                 -- buy | sell | free | release
  created_at   timestamptz not null default now()
);

-- ── history (public club page) + idempotent ticks ───────────────────────────
create table honor (
  id        uuid primary key default uuid_generate_v4(),
  world_id  uuid not null references world(id) on delete cascade,
  club_id   uuid not null references club(id) on delete cascade,
  season    int not null,
  kind      text not null,                    -- champion | promoted | relegated | intl-champion
  tier      int not null
);
create index on honor (club_id);

create table tick_log (
  id          uuid primary key default uuid_generate_v4(),
  world_id    uuid not null references world(id) on delete cascade,
  kind        text not null,                  -- matchday | rollover
  season      int not null,
  day         int not null,
  status      text not null default 'done',
  fixtures    int not null default 0,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (world_id, season, day, kind)        -- THE idempotency key (a retried tick is a no-op)
);

-- Standings are DERIVED (standings() over a division's resolved fixtures), never
-- stored stale — compute on read / cache per (world, season, tier, grp), bust on
-- resolve. The live window's embargo is enforced in app code (live.ts), so a
-- mid-broadcast standings query simply filters status = 'resolved'.
