-- Email verification (docs/PHASE2.md §14 step 3): an account starts UNVERIFIED and must
-- confirm its email (via a single-use token, emailed in production) before it can claim a
-- club. The token is cleared on verification. Additive over 0002_worldstore.sql's
-- ace_account — existing rows default to unverified with no pending token (a backfill can
-- mark legacy accounts verified=true if desired).
alter table ace_account
  add column if not exists verified     boolean not null default false,
  add column if not exists verify_token text;

-- look up the pending account by its emailed token
create index if not exists ace_account_verify_token_idx on ace_account (verify_token);
