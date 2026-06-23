# ACE

An asynchronous, server-authoritative **Valorant esports management simulation**. You own a club — forever — draft and develop players, build agent comps, set tactics, and a deterministic match engine resolves every scheduled match on a tick. There's no live play: everyone sets their plan ahead, the server resolves all matches, and you watch them back on a 2D viewer.

Because a match is a **pure function of `(rosters, tactics, patch, seed)`**, "watch live" and "watch replay" are the same stored data — and any round can be rewound, forked, and re-simulated. That re-runnability is the whole thesis: we don't compete with real games on fidelity, we compete on *interrogability*.

Full design doc: [`docs/DESIGN.md`](docs/DESIGN.md).

---

## Architecture

Monorepo (pnpm + turbo). **The engine is the keystone, not the backend.** Everything else is a consumer of the timeline it produces.

```
packages/
  shared/   the timeline contract + data models — the spine both sides import
  maps/     map assets + alpha→mask→navmesh pipeline + A* pathfinding
  engine/   deterministic seeded sim:  simulateMatch(input) → MatchTimeline
apps/
  web/      Vue 3 + Vite viewer — renders a MatchTimeline on the real map
```

### The contract — `packages/shared/src/timeline.ts`

The engine emits a `MatchTimeline`; the viewer reads one. Neither side knows anything about the other beyond this shape, which is what keeps the engine swappable and the viewer dumb:

```ts
interface MatchInput  { seed: number; map: MapId; teams: [Team, Team]; patch: PatchState }
interface MatchTimeline { version: 1; seed: number; map: MapId; finalScore: [number, number]; rounds: Round[]; /* … */ }

// every event t is normalized 0..1 WITHIN its round
type MatchEvent =
  | { t: number; arrive: number; kind: 'move'; agent: string; path: Vec2[] }  // navmesh path → viewer animates
  | { t: number; kind: 'kill';   killer: string; victim: string; weapon: string }
  | { t: number; kind: 'plant';  agent: string; site: 'A' | 'B' }
  | { t: number; kind: 'defuse'; agent: string }
  | { t: number; kind: 'ability'; agent: string; ability: string };
```

### Determinism is the contract's enforcement

The engine is **pure**: seeded PRNG only (`packages/engine/src/rng.ts`, mulberry32) — **no `Math.random()`, no `Date.now()`, no I/O.** Same input → byte-identical timeline, every time. This is what makes matches re-runnable (counterfactual replays), trivial to debug from a seed, and safe to resolve server-side at scale.

### The map pipeline — `packages/maps`

A map's official minimap (`displayIcon`) carries collision **for free**: its **alpha channel is the walkability mask** — opaque is floor, transparent is wall. `scripts/build-navmesh.ts` reads that alpha into a grid; the engine runs A\* on it (`src/navmesh.ts`), so every agent route follows real corridors and can't cross a wall. To add a map: drop in its `displayIcon`, rerun `pnpm navmesh`, done. No hand-tracing.

---

## Quickstart

```bash
pnpm install
pnpm navmesh      # alpha → walkable grid → packages/maps/data/ascent.navmesh.json
pnpm sim          # engine → timeline.json (+ apps/web/public/timeline.json)   add: -- --seed 42
pnpm dev          # open the viewer on the generated match
```

The loop, end to end: **roster + tactics + seed → engine → timeline → viewer.**

A sample `timeline.json` is committed under `apps/web/public/`, so a fresh clone can `pnpm install && pnpm dev` and immediately watch a match without running the engine first.

## Scripts

| command | what it does |
|---|---|
| `pnpm sim -- --seed N` | simulate a full match with a given seed |
| `pnpm navmesh` | rebuild the Ascent navmesh from its minimap |
| `pnpm typecheck` | typecheck every package |
| `pnpm build` | typecheck packages + build the web app |

> Packages are consumed as source via path mapping (`@ace/shared`, `@ace/maps`, `@ace/engine`) — tsx runs the engine, Vite bundles the app — so the packages have no separate compile step; their "build" is a typecheck.

---

## Status & roadmap

**Phase 0 — the keystone — is in:** a minimal but real deterministic engine that produces full matches (round loop, buy economy, attribute-driven duels resolved on the real navmesh), the map pipeline, and a viewer that renders it on the actual Ascent minimap.

**Vision / fog-of-war — in, both sides:** agents carry a facing (down their travel vector while moving, down a held angle once anchored) and a ~120° awareness cone. In the *engine*, a duel only happens when at least one agent sees the other through the alpha-mask LOS, and spotting an unaware enemy first is a decisive edge — so backstabs, off-angles, and post-plant retakes fall out of geometry rather than pure range (`packages/maps/src/navmesh.ts` → `inView()`). In the *viewer*, each living agent casts a wall-clipped vision cone raycast against that same navmesh, so you can watch *what each player could see* — and where two cones overlap is exactly where a duel is about to happen (toggle with the **Vision** button). The engine exposes only `move.hold` (the held heading) in the timeline; the viewer reconstructs facing-while-moving from the path.

**Utility — in:** abilities fire for real and bend duels through the same geometry. Controllers throw **smokes** that blind the *enemy's* sightline through them (directional — you play around your own), so a team can take space and execute; initiators (**recon**) and attacking duelists (**flash**) **pulse** the contested site to win the first shot on contact. Every effect's reach and duration scale with the caster's `utility` attribute, so the stat finally bites: with all else equal, a high-utility roster wins ~58% of matches. Side balance barely moves — utility shapes *how* you win, not a free win.

Next, in order (see `docs/DESIGN.md` §17):
1. **Richer match model (cont.)** — the rest of the three-layer player model: potential-behind-fog → current ability → match-night *form*/variance expressing through play.
2. **The persistent world** — scheduling, the resolution worker, accounts, clubs (NestJS + Supabase + Stripe, Phase 2).
3. **Tactics editor** — same map + navmesh, but you author the execute instead of watching it.
