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

**Match-night form — in:** the third layer of the player model. Every player draws a small form edge once per match, held all match — same roster, different night — so a star pops off or goes ice cold, deterministically. The viewer surfaces it with a **live scoreboard** (K/D through the current moment, top fragger highlighted), so you watch the night's form emerge round by round. The remaining layer — *potential behind fog* → current ability — is a scouting/management concern and lands with Phase 3.

**True Odds — in (the thesis, made literal):** because a match is a *pure function* of its inputs, the engine re-simulates every round's exact setup 120× on throwaway RNG to compute its real win chance — then the viewer shows which of your wins were robbery and which losses were chokes. No esports manager has done this, because no other match engine is deterministic enough to. The counterfactual forks never touch the match RNG, so the canonical timeline stays byte-identical; only an additive `winPct` rides along on each round (version still `1`). The viewer plots a per-round odds chart (favoured team, actual winner, upsets flagged) with a live verdict — *"79% NCT favoured · MRD stole it."*

**Tactics — in (the manager's lever):** `MatchInput` now carries a `Tactics` plan per team, and the round simulation *resolves* it — this is the bridge from the management game to the engine. Attackers pick a site weighted by their **site bias** and execute at their **tempo** (a fast hit reaches site before rotations land; a slow default takes map control). Defenders set up on a pre-round **read** — *not* the actual site — so a wrong read is paid for in rotation time (those bodies arrive late, the site falls), while **aggression** trades held-angle edge for forward picks. The attacker-site-vs-defender-read mind-game is real and measured: on identical rosters, reading the site correctly swings the round ~7 points, and it compounds over a match. Tactics live on the engine *input*, so none of this touches the timeline contract or the viewer.

**Comp — in (what you field):** the other half of the plan. `MatchInput.comp` sets which **agent** each player fields; a player with no pick defaults to their highest-mastery main, so every team always has a comp. The fielded agent decides the **kit** (a Viper comp throws smokes, a Sova comp throws recon — so the comp shapes a team's whole utility profile), carries a **duel edge** from the agent's patch tier × the player's **mastery** on it, and scales that player's utility by how well they play the agent. Picking mastered meta agents is a real edge: on identical rosters, fielding mains beats forcing off-pool picks **~88% of matches**. The fielded agent rides along on `PlayerMeta` (additive) so the viewer shows the comp on the scoreboard.

**Economy — in (the buy rhythm):** credits now have real pressure — a buy *spends* (full ~3900, force ~2300) and rounds *earn* (win 3000, escalating loss bonus 1900/2400/2900, +200 a kill, +300 for planting even in a lost round). So buys read the situation and teams **save**: when a full is out of reach and they're not desperate, they eco to bank for next round rather than half-buy into rifles. The pistol → bonus/eco → gun-round → force rhythm that drives Valorant strategy now falls out on its own, and weaker buys mean weaker guns mean harder rounds — an eco round shows up as a ~90% round for the full-buy side. The viewer shows each team's buy (FULL / FORCE / ECO) on the scoreboard.

Next, in order (see `docs/DESIGN.md` §17):
1. **The persistent world** — scheduling, the resolution worker, accounts, clubs (NestJS + Supabase + Stripe, Phase 2) — where these match inputs (roster, comp, tactics) come from real owners instead of the sample.
2. **More for the engine** — more maps through the same alpha→navmesh pipeline; an emergent meta where the patch's agent tiers shift and comps must adapt.
