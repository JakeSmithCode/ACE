-- Stripe VIP (docs/PHASE2.md §12, §14 step 10): the webhook is the source of truth
-- for an account's VIP horizon. Stored as epoch SECONDS (bigint) to match the
-- store's number-based clock; null = free. VIP gates convenience/depth only —
-- the tick and the sim are identical for everyone (never pay-to-win).
alter table ace_account
  add column if not exists vip_until bigint;
