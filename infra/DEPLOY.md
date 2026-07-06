# Deploying the ACE live server

The zero-dep `node:http` server (`apps/server`) is production-shaped: durable
stores are injected, the world **resumes** across restarts (verified by the
restart-resume suite), and every heavy seam already has its production adapter
slot. One process serves thousands of users (measured: 1000 SSE clients +
620 req/s, p95 82ms).

## Quick start (single node + Postgres)

```sh
# 1. Postgres: apply the migrations in order
psql "$DATABASE_URL" -f infra/migrations/0001_init.sql       # (reference schema)
psql "$DATABASE_URL" -f infra/migrations/0002_worldstore.sql # world/fixtures/ticks/accounts
psql "$DATABASE_URL" -f infra/migrations/0003_email_verify.sql
psql "$DATABASE_URL" -f infra/migrations/0004_account_data.sql
psql "$DATABASE_URL" -f infra/migrations/0005_vip.sql

# 2. the one optional dependency (PgStore takes an injected Queryable; `pg` provides it)
pnpm add pg

# 3. run
PORT=8787 \
DATABASE_URL=postgres://… \
ACE_JWT_SECRET=$(openssl rand -hex 32) \
ACE_AUTO=1200 \
STRIPE_WEBHOOK_SECRET=whsec_… \
pnpm run server:serve
```

- `ACE_JWT_SECRET` **must** be stable — with the Pg account store it keeps every
  issued session valid across restarts/deploys.
- `ACE_AUTO` is the scheduled tick worker (seconds between match-days). **The
  world clock is server-owned**: this tick is the only thing that advances a
  match-day. Omitted → defaults to 900s. `POST /advance` is always refused
  (403) unless `ACE_DEV_ADVANCE=1` / `--dev-advance` — a dev/demo flag that must
  never ship: one player must not move time for everyone.
- `STRIPE_WEBHOOK_SECRET` arms `POST /billing/webhook` with Stripe's exact
  signature scheme — point a real Stripe endpoint at it and VIP flows with no
  code change (the hosted-checkout session creation is the one remaining SDK call).
- On boot with an existing world the server logs `resumed at match-day N` —
  standings, ownership, academies, mail, friendlies, playoff brackets and the
  Hall of Fame all come back (the `__social__` + per-account blobs hydrate).

## Scaling beyond one process

The seams are built; each swap is an adapter, not a rewrite:

| Seam                         | In this slice            | At scale                        |
|------------------------------|--------------------------|---------------------------------|
| `WorldStore`/`AccountStore`  | Memory / `PgStore`       | the same `PgStore`              |
| `Scheduler` (tick cadence)   | `IntervalScheduler`      | BullMQ repeatable job (Redis)   |
| event bus (`emit`/backlog)   | in-process fan-out       | Redis pub/sub fan-in per node   |
| live frame hubs              | per-process shared frame | same, behind a sticky balancer  |
| HTTP framing                 | `node:http`              | NestJS controllers (same routes)|

Multiple regions = multiple worlds (`docs/PHASE2.md` §3): each shard is its own
world row ticked by its own job — the circuit code already proves the shape.
