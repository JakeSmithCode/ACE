-- OAuth identity linkage: (provider, subject) → account. A subject is the
-- provider's permanent user id; one account can hold many identities
-- (sign in with Google AND Discord). The PK is the idempotency key.
create table if not exists ace_oauth_identity (
  provider   text not null,
  subject    text not null,
  account_id text not null references ace_account(id),
  primary key (provider, subject)
);
create index if not exists ace_oauth_identity_account on ace_oauth_identity(account_id);
