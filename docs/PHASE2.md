# Phase 2 — The World & Persistence: server architecture

> Concrete build target for the multi-tenant, async-PvP world. Aligns with
> `DESIGN.md` §3 (server-authoritative & async), §6 (the match function), §16
> (stack: NestJS, **self-owned auth**, plain Postgres, BullMQ, Stripe), and §17
> (roadmap). The thesis: **scale is cheap because the world is pure and
> deterministic and matches resolve on a tick, not live.**

## 0. The one idea everything rests on

A match is a pure function `simulateMatch(input, nav, forks) → timeline`, and the
league resolves on a **scheduled tick**, identical for everyone, watched or not.
That single decision (no live match netcode) is what makes a thousands-of-owners
browser sim viable on modest infra:

- **No live sessions to hold.** The expensive thing in real-time games — masses
  of concurrent authoritative sockets — does not exist here. We batch-resolve.
- **Embarrassingly parallel.** Every fixture is independent → fan out across workers.
- **Store seeds + tiny inputs, not timelines.** A result is a `finalScore`; the
  full match is re-simmed on demand (and the *client* can do that re-sim).
- **Relevance-scoped work.** Full-sim divisions someone will watch; quick-resolve
  the dormant rest. (We already do this in single-player.)

Everything below is plumbing around that core. **The engine, the timeline
contract, and `@ace/world` do not change.**

## 1. Monorepo shape

```
packages/
  shared/   @ace/shared   — the timeline + models contract           (reused as-is)
  maps/     @ace/maps     — navmesh + geometry                        (reused; nav loaded server-side)
  engine/   @ace/engine   — simulateMatch, rng, economy               (reused as-is)
  world/    @ace/world    — generation, schedule, season, playoffs,   (reused + EXTENDED, see §2)
                            develop, finance, market, divisions, meta
apps/
  web/      @ace/web      — Vue client (single-player today → talks to server in P2)
  server/   @ace/server   — NEW. NestJS API + BullMQ tick worker
infra/                    — NEW. Postgres migrations, docker-compose, deploy
```

The client keeps re-simming matches locally to watch them — so the **viewer is
unchanged** and watching costs the server nothing.

## 2. Prerequisite refactor: lift orchestration into `@ace/world`

Today `apps/web/src/world.ts` (the store) owns the *orchestration*: `buildInput`,
`resolveDay` (per-tier full/quick split), `advanceSeason` (settle → develop →
patch → promote/relegate), and the market resolution. The server worker must run
**the exact same logic**. So before any server code, extract the pure core into
`@ace/world`:

```ts
// @ace/world — pure, no Vue, no I/O. The store and the server both call these.
buildInput(world, fixture): MatchInput
resolveMatchday(world, day, resolve): MatchResult[]   // resolve = full sim | quickResult
quickResult(home, away, seed): MatchResult
advanceSeason(world): { world, ledgers, moves, patchNotes }   // settle/develop/meta/pro-rel
resolveListings(world): TransferResult[]
```

`world` here is a plain `WorldState` value object (clubs, division map, balances,
results, patch, season, …) — the same shape the store holds in refs and the
server holds in Postgres rows. The store becomes a thin reactive wrapper; the
server becomes a thin persistence wrapper. **One code path, two callers.** This
is worth doing even before the backend — it shrinks the store and proves the
boundary.

## 3. World structure at scale — fan out at the base

110 clubs is the *vertical* depth (Iron→Premier). Scale is *horizontal*: a tier
is not one division, it's **many parallel divisions**, more of them the lower you
go (like real football pyramids and VALORANT ranked).

```
Premier        1 division  ×10        (scarce → prestigious; the franchised top)
Challengers    2 divisions ×10
Radiant…Diamond   grows                (dozens at the mid)
Platinum…Iron     hundreds–thousands   (the wide base)
```

- A division is identified by `(world_id, tier, group, season)`. Today `group`
  is implicitly `0`; P2 makes it a real dimension. `divisionSchedule(members)`
  and `promoteRelegate(...)` already take arbitrary member lists — **they don't
  change.**
- **The funnel:** at a tier with `G` groups feeding a tier with `g < G` groups
  above, the group winners promote upward and are re-seeded into the fewer
  groups above; the relegated fan back out below. Promotion math stays "top/bottom
  `k` of each group"; only the regrouping step is new.
- **Regional shards.** Mirror the real circuit — Americas / EMEA / Pacific /
  China — each its own `world` row with its own pyramid. International events
  (Masters/Champions, §9 of DESIGN) connect shard tops. Shards also partition
  server load: each resolves independently.

## 4. Humans are a sparse overlay on an always-full world

You never need real users to fill the world — the deterministic generator already
fills every slot with an AI club. Real owners are a thin, shifting layer:

- **Claim:** a new signup is placed at the base (an open Iron slot) or *takes
  over* an existing AI club. `club.owner_account_id` flips from `NULL` to the
  account; nothing else moves.
- **Revert:** an owner who churns → `owner_account_id = NULL`, club reverts to
  AI. The world stays structurally complete.
- **Non-negotiable (DESIGN §6):** every club *always* has an active plan the tick
  can grab — a saved lineup + comp + tactics per map/side with real defaults — so
  a ghosting or AI club always fields a competent five, never idle bots. Stored
  as `club.plan jsonb`; AI clubs get a generated plan (`makeTactics` + top-mastery
  comp), humans author theirs.

## 5. Data model (Postgres)

Plain Postgres, self-hostable, **no BaaS** (DESIGN §16: a "your club, forever"
promise can't sit on a vendor). UUID PKs, `jsonb` for the sim's value objects
(attrs/potential/agents/plan/patch), partition the hot tables by `world_id` /
`season`.

```sql
-- identity (self-owned auth — our own tables, never a vendor)
account(
  id uuid pk, email citext unique not null, password_hash text not null,
  email_verified bool default false, vip_until timestamptz, region text,
  status text default 'active', created_at timestamptz default now())
refresh_token(
  id uuid pk, account_id uuid fk, token_hash text not null,
  expires_at timestamptz, revoked_at timestamptz, created_at timestamptz)

-- a shard: one pyramid, one seed, one clock
world(
  id uuid pk, region text not null, seed bigint not null,
  season int not null default 1, day int not null default 0,
  patch jsonb not null, engine_version text not null,   -- pinned for reproducibility (§7)
  status text default 'live', created_at timestamptz)

-- clubs: AI by default, a human owner is an overlay
club(
  id uuid pk, world_id uuid fk, slug text unique,
  name text, tag text, tier int not null, grp int not null default 0,
  owner_account_id uuid fk null,        -- null = AI-run
  strength real, balance bigint default 0, titles int default 0,
  plan jsonb not null,                  -- lineup + comp + tactics (always present)
  created_at timestamptz,
  unique(world_id, tier, grp, slug))
create index on club(world_id, tier, grp);
create index on club(owner_account_id);

-- rosters (depth ≥ 5; the matchday five is derived, as in the store)
player(
  id uuid pk, world_id uuid fk, club_id uuid fk null,   -- null = free agent
  handle text not null, role text, age int,
  attr jsonb, potential jsonb, agents jsonb, value bigint,
  created_at timestamptz,
  unique(world_id, handle))             -- engine assumes unique handles per match

-- the schedule is PURE (divisionSchedule) → not stored; fixtures are the record
fixture(
  id uuid pk, world_id uuid fk, season int, tier int, grp int,
  day int, slot int, home_club_id uuid, away_club_id uuid,
  seed bigint not null, status text default 'scheduled',  -- scheduled|resolved
  home_score int, away_score int, winner_club_id uuid,
  engine_version text, input_snapshot jsonb,   -- present only for WATCHABLE fixtures (§7)
  resolved_at timestamptz,
  unique(world_id, season, tier, grp, day, slot))
create index on fixture(world_id, season, tier, grp);

-- market: live board + history
listing(id uuid pk, world_id uuid fk, club_id uuid, player_id uuid,
        ask bigint, created_at, expires_at)
transfer(id uuid pk, world_id uuid fk, season int, player_id uuid,
         from_club_id uuid, to_club_id uuid null, fee bigint, kind text, created_at)

-- history for the public club page + idempotent ticks
honor(club_id uuid fk, world_id uuid, season int, kind text, tier int)   -- champion|promoted|relegated
tick_log(id uuid pk, world_id uuid fk, kind text, season int, day int,
         status text, fixtures int, started_at, finished_at,
         unique(world_id, season, day, kind))   -- the idempotency key
```

Standings are **derived** (`standings()` over a division's `fixture` rows) — a
view or a computed-on-read query, never stored stale. Cache per `(world,season,
tier,grp)` and bust on resolve.

## 6. The tick — scheduled resolution (BullMQ + Redis)

A cron-like scheduler enqueues work; workers consume. Matchdays within a season
are **sequential** (economy/streaks carry), fixtures within a matchday are
**parallel** (each club plays once → independent).

```
scheduler (nightly / per cadence)
  └─ for each live world: enqueue tick:{world, season, day}
       worker tick(world, day):
         guard: tick_log unique(world,season,day) → skip if done   (idempotent)
         for each division (tier,grp) in world:           ── fan out, parallel
           members ← clubs where (tier,grp)
           schedule ← divisionSchedule(members)           (pure, regenerated)
           for slot, fx in schedule[day]:
             watchable ← division has a human owner OR a live spectator
             result ← watchable ? simulateMatch(buildInput(...), nav, 0)   (full)
                                 : quickResult(home, away, seed)           (cheap)
             persist fixture(result); if watchable persist input_snapshot
           update economy/streaks for these clubs
         advance world.day; if day == lastDay → enqueue season-rollover
       worker season-rollover(world):
         runPlayoffs (per division with a human, or just the top tier)
         advanceSeason: settle finances (divMult by tier) · develop squads ·
                        patchMeta · promote/relegate across all boundaries ·
                        regroup the funnel · backfill AI for vacated slots
         write honors, ledgers, patch notes; season++ ; day=0
```

Properties:

- **Idempotent & resumable.** `tick_log` unique key + per-fixture `status` guard
  → a retried/crashed job never double-resolves. Safe to re-run.
- **Parallel where it pays.** Per-division jobs across workers; a world of N
  divisions is N independent jobs. Add workers → scale linearly.
- **Cheap.** `forks: 0` for league resolution (the canonical `finalScore` is
  fork-independent — proven in single-player). A full match ≈ ~100 ms CPU;
  quick-resolve ≈ microseconds. See §10.
- **Plans always exist** (§4) so the worker never blocks on an absent owner.

## 7. Reproducibility across deploys (the subtle one)

A stored `finalScore` is **history** — it must not silently change when we patch
the engine. But re-sim-to-watch must reproduce it *byte-for-byte*. Two rules:

1. **`engine_version` + `patch` are pinned per `world`/`fixture`.** A fixture is
   reproducible only by the engine build that produced it. We ship versioned
   engine bundles; the client loads the matching one to replay.
2. **The engine is frozen within a season; it (and the meta patch) may only
   change at the season boundary.** This falls out *for free* from the design we
   already have — the meta already re-patches each off-season (`patchMeta`), so
   the engine version bumps at the same seam. Within a season every fixture is
   reproducible; across seasons, history is immutable because each season's rows
   carry their own `engine_version`.

`finalScore` is canonical truth; the timeline is a *derivation* of
`(input_snapshot, seed, engine_version)`. Store the snapshot only for watchable
fixtures (a few KB each) — dormant all-AI divisions store just the score.

## 8. Watching costs the server ~nothing

The client already re-sims to watch (the single-player viewer does exactly this).
So:

```
GET /fixtures/:id/replay → { input_snapshot, seed, engine_version }
client: load engine@version + nav → simulateMatch(...) → render timeline
```

The CPU is the *viewer's*. The server ships a few KB. "Watch live at tick time"
and "watch the replay next week" are the same request — the only difference is
*when* the row turns `resolved`. Tick-night (§11) just pushes "resolved" events
as they land and the client pulls replays.

## 8.5 The live window — result embargo (no spoilers until it's over)

The engine resolves a match in ~100 ms, so the result *exists* the instant the
tick runs. But a match scheduled for 8pm must **play out live** and its result
must stay **sealed until the broadcast actually finishes** — like a real esports
match. The model (`apps/server/src/live.ts`, in):

- Each fixture carries a **`kickoffAt`** (8pm) and a **FIXED `broadcastSecs`** →
  `revealAt = kickoffAt + broadcastSecs`. Fixed on purpose: a 13-3 stomp and a
  13-11 thriller take the same slot, so the *duration leaks nothing* about how
  close it was.
- **Status is derived from wall-clock `now`:** `scheduled` (pre-kickoff), `live`
  (playing out), `resolved` (past reveal). `publicView(fixture, now)` is
  spoiler-safe by construction — before reveal it carries **no score and no
  `input_snapshot`** (so a client can't re-sim ahead), only the live position.
- **During the window the server streams the match gated to the live position**
  (`liveMatchState(timeline, frac)`): the running score from *completed* rounds
  only, never the final, until `frac` reaches 1. Everyone watching is synced to
  the same wall-clock moment (a real stream, not a per-viewer replay). The server
  re-sims the snapshot as the live source; the client renders up-to-now.
- **At `revealAt`** the row flips `resolved`: the snapshot + final score go public
  and watching reverts to the cheap client-side replay (§8). Standings only count
  `resolved` fixtures, so the table never moves mid-broadcast.

This is the one place the "watching costs the server nothing" rule (§8) is
relaxed — *live* watching costs a bounded re-sim + a synced stream, but only for
matches in their window. Replay (after reveal) stays free. Proven headless by
`pnpm run server`: a Premier match sealed through its window (running score
advancing 0–0 → … → 12–7), the final 13–7 released only at reveal.

## 9. API surface (NestJS modules)

```
auth      POST /auth/register · /auth/login · /auth/refresh · /auth/verify   (self-owned, §10 DESIGN)
me        GET  /me · PATCH /me/plan            (your club's lineup/comp/tactics)
world     GET  /worlds/:id · /worlds/:id/standings?tier&grp · /schedule
clubs     GET  /clubs/:slug  (public club page) · POST /clubs/:id/claim
market    GET  /market?tier · POST /market/buy · /market/sell · /market/list
fixtures  GET  /fixtures?... · GET /fixtures/:id/replay
billing   POST /billing/checkout · POST /billing/webhook  (Stripe → vip_until)
realtime  WS   /live  (subscribe: division resolutions, market pings, notifications)
```

All mutations are **server-authoritative**: the client proposes (buy, sell, set
plan), the server validates against state + balance + the valid-five floor, the
tick resolves. No sim logic on the client except read-only replay.

## 10. Capacity & cost envelope

Async + deterministic makes the numbers small:

- **CPU.** 10,000 clubs ≈ 5,000 fixtures/matchday. If 5% of divisions are
  watchable (full-sim) and 95% quick-resolve: ~250 full × 100 ms = 25 CPU-s +
  ~5,000 quick × ~50 µs ≈ negligible. Run once per tick (nightly/weekly),
  parallel across a couple of workers → **seconds of wall-clock**. Even
  full-simming *everything* is ~500 CPU-s — still a few cheap workers.
- **Storage.** Fixtures dominate. Scores are bytes; input snapshots (~2–4 KB)
  only for watchable fixtures. 5,000 fixtures/day × a season ≈ low-MB/season for
  the wide base; partition by `(world, season)` and archive cold seasons.
- **Real-time.** Only tick-night viewers + market pings hold sockets, and only
  while watching — not the sim.

The expensive axis is **AI text** (recaps/analysis at world scale, DESIGN §15) —
mitigated by running it *on the tick and on-demand*, cached against events,
tiered by VIP. Out of scope for the structural MVP.

## 11. Real-time, only where it earns it (DESIGN §16)

A NestJS WebSocket gateway for: **tick-night match center** (subscribe to a
division → push fixtures as they flip `resolved`, with a synced kill-feed ticker
driven by the client re-sim), **transfer-market pings**, and **notifications**.
Never the sim. Everything else is plain REST + the client re-sim.

## 12. Billing (Stripe, VIP — never pay-to-win)

F2P base (a deep PvP world needs a large free population to keep leagues full).
Stripe subscription sets `account.vip_until`; a webhook is the source of truth.
VIP gates convenience/depth — more saved tactics/replays, deeper analytics,
faster scouting — **never** competitive advantage. Feature checks read
`vip_until`; the tick and the sim are identical for everyone.

## 13. What's reused vs. new

| Reused unchanged | New in Phase 2 |
|---|---|
| `@ace/shared` timeline+models contract | `apps/server` (NestJS): auth, world, clubs, market, fixtures, tick, billing, realtime |
| `@ace/engine` `simulateMatch`/rng/economy | Postgres schema + migrations; partitioning |
| `@ace/maps` navmesh (loaded server-side) | BullMQ + Redis tick worker; scheduler |
| `@ace/world` generation/schedule/season/playoffs/develop/finance/market/divisions/meta | Self-owned auth (argon2id, JWT access + rotating refresh) |
| The Vue viewer (client re-sim to watch) | `(tier, grp)` fan-out + the funnel + regional shards |
| Determinism + relevance-scoped resolution | account↔club claim, AI takeover/revert, `club.plan` |

**Net:** the entire simulation and world-generation layer is already
server-ready. Phase 2 is persistence, identity, scheduling, and the fan-out —
not a sim rewrite.

## 14. Build order within Phase 2

1. **Extract orchestration into `@ace/world`** (§2) — store + server share one
   pure core. ✅ *Done — `@ace/world/resolve.ts` (`buildMatchInput`,
   `quickResult`, `resolveWorldDay`, `settleClub`).*
   - ✅ *Also done — `@ace/world/state.ts`: `WorldState` + `createWorld` /
     `simulateSeason` / `advanceWorld`, the headless world engine the tick worker
     runs. `pnpm world` proves it churns the full ladder deterministically with
     no Vue/DB/navmesh. (The store consolidating onto `WorldState` is the
     remaining half of this step.)*
2. **Postgres schema + migrations**; a `seedWorld(region, seed)` that writes a
   `createWorld(...)` `WorldState` to rows (the mapping is now mechanical — §5
   tables mirror `WorldClub`/`fixture`). 🟡 *Partial — `apps/server` defines the
   persistence boundary (`WorldStore`: world snapshot + `fixture` rows + the
   idempotency `tick_log`) and `seedWorld(store, …)`, with a `MemoryStore` impl.
   The `PgStore` (same interface) + migrations are the remaining half.*
3. **Self-owned auth** (register/verify/login/refresh). ✅ *Done — `auth.ts` +
   `accounts.ts`, **zero-dep** (node `crypto`: scrypt password hash, a hand-rolled
   HS256 JWT access token, an opaque rotating refresh token stored hashed). The
   NestJS version swaps in argon2id/passport but exposes the same tokens.
   `AuthService` over an `AccountStore` (`MemoryAccountStore` now, `PgAccountStore`
   the mechanical follow-up — accounts span worlds, so it's separate from
   `WorldStore`). Wired into `http.ts`: `POST /auth/register|login|refresh`, and the
   ownership routes now resolve the account from a verified **Bearer** access token
   (the `x-account` header demoted to a dev fallback). `pnpm run server:live` proves
   it: register issues access+refresh, no token / bad password → 401, refresh
   **rotates** (the old refresh is single-use → 401 on replay), and a club is claimed
   via the Bearer token. The KDF salt is the only randomness and it's auth-not-sim,
   so engine/world determinism is untouched; the `clock` is injectable so expiry is
   testable. Email verification + Stripe `vip_until` are the remaining account fields
   (steps 9/10).*
4. **The tick worker** resolving one world end-to-end (matchday → season rollover),
   idempotent. ✅ *Done — `apps/server/src/tick.ts` `runTick` resolves the current
   match-day (via the shared pure `resolveSeasonDay`) or rolls the season over
   (`advanceWorld`), guarded idempotent by `tick_log`. `pnpm run server` proves it
   headless: a 110-club world ticks day-by-day across seasons, **deterministic**
   (two runs byte-identical) and **idempotent** (a retried tick never
   double-resolves). Relevance-scoping is wired: `runTick(store, id, {full, navOf})`
   **full-sims** the watchable divisions with the real engine (`forks:0`) and
   quick-resolves the rest, persisting the `input_snapshot` per watchable fixture
   (§7). `pnpm run server` proves the watch loop: the Premier is engine-simmed
   (a real Valorant scoreline), and re-simming a stored snapshot reproduces the
   persisted score **byte-for-byte**. The BullMQ job is a thin async wrapper over
   this.*
5. **Claim + AI takeover/revert + `club.plan`** (the always-has-a-plan rule).
   ✅ *Done — the ownership overlay is pure `WorldState` transforms in
   `@ace/world/owner.ts` (`claimClub` / `revertClub` / `setClubPlan`, with
   `clubOf` / `planOf` / `ownedClubs`), wrapped for the store in
   `apps/server/src/owner.ts` (`claim` / `revert` / `savePlan` / `myClub` —
   load → transform → save; the Pg version runs the same transforms in a row
   UPDATE). `club.owner` flips null↔account (one owner per club, one club per
   account, enforced); the **plan** is `(tactics, comp, lineup)` and is always
   present — an AI/ghosting club runs its generated tactics + comp and the derived
   best five, a human authors theirs. `lineup` is additive/optional on `WorldClub`
   (undefined → `startingFive`), so generated worlds are byte-identical; `planFive`
   resolves an owner's explicit five when it's a `validFive` and **falls back**
   otherwise, so a stale/invalid lineup can never break the always-field-a-five
   rule (defense in depth alongside the `setClubPlan` write-time validation). On
   revert the plan **persists** — the AI keeps fielding the last saved five.
   `pnpm run server` proves it: claiming the Premier home club then authoring its
   read/tempo makes the **full-sim snapshot carry the authored tactics** (the
   human's plan drives the engine), a second claim is blocked, a bad lineup is
   rejected, revert returns the club to AI with its plan intact, and **every club
   still fields a valid five**. Auth (which account may call these) is the HTTP
   layer's job (step 3); the engine never sees ownership, so seed 42 is unchanged.*
6. **Fan-out `(tier, grp)` + the funnel.** ✅ *Done — `(tier, group)` is a real
   division dimension. `createWorld(seed, { layout })` takes a pyramid (`groups per
   tier`, e.g. `[1,2,4]`) and assigns the strength-descending field to `(tier,
   group)` slots (`assignDivisions`, snake-seeded by strength); the flat default
   (every tier one group) is **byte-identical** to before. `worldDivisions(w)` lists
   every division; `resolveSeasonDay` / `simulateSeason` schedule and resolve across
   all of them (per-fixture seed offset `tier·1000 + group·1e6`, which reduces to the
   old `tier·1000` at group 0 — so a flat world's fixture seeds are unchanged). The
   **funnel** (`funnelPromoteRelegate`) runs promotion/relegation across a pyramid
   where tiers have differing group counts: the bottom `k` of **each** group relegate,
   exactly that many promote up from the wider tier below (group winners first, ties
   by strength) so each tier's population is **conserved**, then each tier is
   **regrouped** (snake-seeded by strength) so groups stay full and balanced. Reduces
   exactly to `promoteRelegate` when every tier has one group. `pnpm run server`
   proves it: a `[1,2,4]×6` world → 42 clubs in 7 divisions, every division still full
   at 6 after 4 seasons (populations conserved, 6 moves/season), deterministic across
   two runs. `membersOf` / `promoteRelegate` / `divisionSchedule` are untouched (the
   single-player store still uses them flat); the engine never sees groups, so seed 42
   is byte-identical.*
7. **Re-sim-to-watch endpoint** + wire the existing viewer to it. 🟡 *Server half
   done — `GET /fixtures/:s/:d/:slot/replay` returns `{ seed, snapshot, score }`
   (425 until resolved, so a client can't pull it early to re-sim ahead), proven by
   `pnpm run server:live` (replay 200s with the full snapshot at reveal; a re-sim
   reproduces the score byte-for-byte per the CLI). What remains is the **web client**
   loading the snapshot into the existing viewer (the single-player viewer already
   re-sims; this just points it at the server's snapshot instead of the bundled
   sample).*
8. **Regional shards.** ✅ *Done — `@ace/world/circuit.ts`. A shard is one region's
   pyramid (a self-contained `WorldState` with its own seed + clock → its own `world`
   row, ticked independently, partitioning load). `createCircuit(seed, { regions })`
   generates one shard per region (each `createWorld` on a `shardSeed`, so a whole
   multi-region circuit is a function of one seed). The **international circuit**
   (`internationalEvent`, DESIGN §9) connects shard tops: each season the top `slots`
   of every region's Premier qualify, are seeded overall (region winners first, ties
   by strength), and play a single-elim bracket (the field trimmed to a power of two,
   classic spread seeding, every game seed a stable hash) — Masters/Champions. Pure +
   deterministic; the engine never sees it. `pnpm run server` proves it: 4 regional
   pyramids resolve independently (distinct Premier champions), an 8-team Masters
   bracket crowns a global champion each season, the region-cup tally accumulates, and
   the whole circuit is deterministic across two runs. (Awarding intl prize/prestige
   back to the shard is a cheap follow-up; the connector is read-only today.)*
9. **Tick-night realtime** (match center MVP) + **public club page**. 🟡 *Largely
   done over the `node:http` slice (`http.ts`): the SSE `GET /live/:s/:d` match-center
   streams the synced running score (step done earlier); the **public club page**
   `GET /clubs/:slug` (identity, division, fielded five, owned-or-AI) and
   **embargo-aware standings** `GET /standings/:season/:tier/:group` (derived from
   RESOLVED fixtures only, so the table never moves mid-broadcast) are in, plus the
   ownership write-path `POST /clubs/:id/claim` + `PATCH /me/plan` + `GET /me`
   (account via an `x-account` header — the stand-in step 3's JWT replaces).
   `pnpm run server:live` exercises all of it end to end: claim → 409 on a rival's
   second claim, author a plan and read it back, the club page, and standings showing
   0 games during the window then moving only after reveal. The NestJS controllers +
   WS gateway formalize these exact shapes.*
10. **Stripe VIP.**

Each step is shippable; the world is playable (vs AI) from step 4.

## 15. Risks & open questions

- **Determinism across deploys** — handled by §7 (version-pin + season-freeze),
  but it constrains how we ship engine changes: balance patches land at season
  boundaries, never mid-season. Worth enforcing in CI (a stored-replay golden test).
- **Economy integrity** — smurfs, multi-accounts, market collusion in a
  persistent economy (DESIGN §16). Needs detection + economic friction; design
  before open beta, not at the structural MVP.
- **AI plan quality** — AI clubs must field *competent* fives or the ladder feels
  hollow. `makeTactics` + top-mastery comp is the floor; tune against win-rate
  parity with human clubs of equal strength.
- **Tick cost growth** — linear in fixtures; mitigated by relevance-scoping and
  worker fan-out, but monitor as worlds grow and shard aggressively.
- **DB hotspots** — the `fixture` table is the firehose; partition by
  `(world, season)` from day one and archive cold seasons to keep the live set small.
