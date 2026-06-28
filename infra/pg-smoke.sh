#!/usr/bin/env bash
# Real-Postgres smoke test (docs/PHASE2.md §14.2 "the only residual is real-Postgres SQL
# parsing"). Spins up a throwaway Postgres 16 cluster (no docker — the server binaries are
# present), applies the real migrations, and runs the exact statements PgStore/PgAccountStore
# issue (jsonb world round-trip, fixture rows, the tick_log idempotency PK, account +
# email-verify) — proving the SQL parses + behaves on a real engine, not just the FakeQueryable.
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d /tmp/ace-pg.XXXXXX)
PGDATA="$WORK/data"
SOCK="$WORK/sock"
mkdir -p "$PGDATA" "$SOCK"
chown -R postgres:postgres "$WORK"

cleanup() { su postgres -c "$PGBIN/pg_ctl -D '$PGDATA' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "  init        : initdb a throwaway cluster"
su postgres -c "$PGBIN/initdb -D '$PGDATA' -A trust" >/dev/null 2>&1
su postgres -c "$PGBIN/pg_ctl -D '$PGDATA' -o \"-k '$SOCK' -c listen_addresses=''\" -w start" >/dev/null 2>&1
# pipe SQL via stdin (not -c) so JSON/quotes survive the su layer cleanly
psql() { printf '%s\n' "$1" | su postgres -c "$PGBIN/psql -h '$SOCK' -d ace -v ON_ERROR_STOP=1 -qtA"; }
su postgres -c "$PGBIN/createdb -h '$SOCK' ace"

echo "  migrations  : apply 0002_worldstore.sql + 0003_email_verify.sql on real PG"
su postgres -c "$PGBIN/psql -h '$SOCK' -d ace -v ON_ERROR_STOP=1 -q -f '$ROOT/infra/migrations/0002_worldstore.sql'" >/dev/null
su postgres -c "$PGBIN/psql -h '$SOCK' -d ace -v ON_ERROR_STOP=1 -q -f '$ROOT/infra/migrations/0003_email_verify.sql'" >/dev/null

fail=0
# ── ace_world: a WorldState stored verbatim as jsonb, read back ──
psql "insert into ace_world (id, snapshot) values ('world-1', '{\"seed\":7,\"season\":1,\"day\":0}'::jsonb)" >/dev/null
GOT=$(psql "select snapshot->>'seed' from ace_world where id = 'world-1'")
[ "$GOT" = "7" ] && echo "  world jsonb : round-tripped (seed=$GOT) ✓" || { echo "  world jsonb : FAIL ($GOT)"; fail=1; }

# ── ace_fixture rows ──
psql "insert into ace_fixture (world_id, season, day, slot, data) values ('world-1', 1, 0, 0, '{\"home\":0,\"away\":1,\"homeScore\":13}'::jsonb)" >/dev/null
FX=$(psql "select count(*) from ace_fixture where world_id='world-1' and season=1")
[ "$FX" = "1" ] && echo "  fixtures    : row inserted + queried ✓" || { echo "  fixtures    : FAIL ($FX)"; fail=1; }

# ── ace_tick_log: the idempotency PK rejects a duplicate (world, season, day, kind) ──
psql "insert into ace_tick_log (world_id, season, day, kind, fixtures) values ('world-1', 1, 0, 'matchday', 5)" >/dev/null
if psql "insert into ace_tick_log (world_id, season, day, kind, fixtures) values ('world-1', 1, 0, 'matchday', 5)" >/dev/null 2>&1; then
  echo "  idempotency : DUPLICATE ACCEPTED — PK missing ✗"; fail=1
else
  echo "  idempotency : duplicate tick rejected by PK ✓"
fi

# ── ace_account + email verification (0003 columns) ──
psql "insert into ace_account (id, email, password_hash, created_at, verified, verify_token) values ('acct-1','jake@ace.gg','deadbeef',1000000,false,'vtok123')" >/dev/null
V0=$(psql "select verified from ace_account where id='acct-1'")
LOOKUP=$(psql "select id from ace_account where verify_token='vtok123'")
psql "update ace_account set verified=true, verify_token=null where id='acct-1'" >/dev/null
V1=$(psql "select verified from ace_account where id='acct-1'")
TOKN=$(psql "select coalesce(verify_token,'<null>') from ace_account where id='acct-1'")
[ "$V0" = "f" ] && [ "$LOOKUP" = "acct-1" ] && [ "$V1" = "t" ] && [ "$TOKN" = "<null>" ] \
  && echo "  email verify: unverified → token lookup → verified, token cleared ✓" \
  || { echo "  email verify: FAIL (v0=$V0 lookup=$LOOKUP v1=$V1 tok=$TOKN)"; fail=1; }

# ── unique(email) enforced ──
if psql "insert into ace_account (id,email,password_hash,created_at) values ('acct-2','jake@ace.gg','x',1)" >/dev/null 2>&1; then
  echo "  unique email: DUP ACCEPTED ✗"; fail=1
else
  echo "  unique email: duplicate email rejected ✓"
fi

echo ""
[ "$fail" = "0" ] && echo "  ✓ PgStore SQL verified against a real PostgreSQL 16 engine." || { echo "  ✗ real-Postgres verification FAILED."; exit 1; }
