-- Per-account, per-world durable state (docs/PHASE2.md §14 follow-up): a human owner's
-- PRIVATE state — the academy youth pipeline, commissioned scout reports, the notification
-- inbox, mail — kept OUT of the shared WorldState snapshot so it doesn't bloat the world or
-- leak between owners. One jsonb blob per (world, account); the server owns the shape, so
-- the column stays schemaless (like ace_world.snapshot). Additive over 0002/0003.
create table if not exists ace_account_data (
  world_id   text not null references ace_world(id) on delete cascade,
  account_id text not null references ace_account(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  primary key (world_id, account_id)            -- one blob per (world, account); saveAccountData upserts on it
);
