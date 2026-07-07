-- Password-reset tokens: stored hashed (a DB leak grants nothing), single-use,
-- TTL'd. A consumed reset also revokes every live refresh token for the account.
create table if not exists ace_reset (
  token_hash text primary key,
  account_id text not null references ace_account(id),
  expires_at bigint not null,
  used       boolean not null default false
);
create index if not exists ace_reset_account on ace_reset(account_id);
