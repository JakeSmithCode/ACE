# infra — Phase-2 persistence + scheduling

Self-hostable Postgres + Redis for the async-PvP server (`docs/PHASE2.md` §5/§6).
No BaaS — DESIGN §16: a "your club, forever" promise can't sit on a vendor.

## Layout

- `migrations/0001_init.sql` — the full schema (the §5 tables). `jsonb` holds the
  sim's value objects verbatim, so a `world` row + its `club`/`player` rows **are**
  the `WorldState` the pure `@ace/world` functions already take. The
  `WorldStore`/`AccountStore` interfaces in `apps/server` map onto these 1:1.
- `docker-compose.yml` — local Postgres 16 + Redis 7.

## Run it locally

```sh
cd infra
docker compose up -d
export DATABASE_URL="postgres://ace:ace@localhost:5432/ace"
psql "$DATABASE_URL" -f migrations/0001_init.sql
```

## Status

The schema + compose are concrete artifacts; they have **not** been applied against
a live database in CI yet. The remaining half of build-order step 2 is the
`PgStore` / `PgAccountStore` — the **same** `WorldStore` / `AccountStore` interfaces
the `MemoryStore` already implements (`apps/server/src/store.ts`, `accounts.ts`),
backed by these tables. Because the tick worker, the live embargo, auth, the
ownership overlay, and the fan-out are all written against those interfaces and
proven headless against the in-memory impls (`pnpm run server`, `pnpm run
server:live`), swapping in the Pg-backed impls changes **no** resolution code — it
is mechanical wiring (a row read → `loadWorld`, a transform → save).

## Reproducibility (§7)

`engine_version` is pinned per `world` and per `fixture`. A stored `finalScore` is
history; re-sim-to-watch must reproduce it byte-for-byte, so a fixture is only
replayed by the engine build that produced it. The engine (and the meta `patch`)
change only at the season boundary, which falls out of the design for free — the
meta already re-patches each off-season. `pnpm sim:check` is the golden test that
guards this in CI.
