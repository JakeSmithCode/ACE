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

**Per-player roles — in:** tactics aren't just team dials. A plan names an **entry** (the player who leads the push — arrives first, takes opening contact; defaults to the best opening duelist) and optionally a **lurk** (a player who peels off the execute to hold a flank for picks on rotators and a late man-advantage). The lurk is a genuine *tradeoff* — a 4-player hit is a softer execute, paid back by flank pressure — so it's a real choice (~even win rate, different risk/reward), not a free win. This is the seed of the tactics editor: a play is ultimately per-player geometry on the same navmesh, which is exactly what an editor would let you draw.

**Trading — in (round dynamics, 1 of 3):** the single biggest realism gap was that every duel was isolated — nobody traded. Now a kill leaves the killer **exposed** for ~3s, and a teammate of the victim who can see them gets a moderate duel edge to punish it. ~37% of kills get traded back (real teams trade 40–60%), and you watch the chains in the kill feed (⇄). This is *why* spacing and support play matter: a stacked execute has the bodies to trade, a spread defense doesn't — so trading favours the grouped side.

**Info-gated rotations — in (round dynamics, 2 of 3):** defenders no longer pre-rotate from the whistle (secretly knowing the site). A rotator **holds its read** — watching its lane — until **contact** (the first kill, or an attacker reaching site), then rotates with purpose. This is the defense's answer to trading: it pulled balance back from ~52% to ~47% attacker and cut stall (time-expiry) rounds from ~11% to ~7%, with rotations now info-driven instead of clairvoyant. (The move event gained a `departT` so the viewer animates the hold-then-rotate — additive, version still `1`.)

**Modeled retake — in (round dynamics, 3 of 3):** the post-plant is now a real phase. A surviving defender who reaches the spike with no attacker contesting the site channels a **defuse** (the long-dormant `defuse` event finally fires; the viewer shows it) — so defense has a second win condition beyond a full elimination, and post-plant clutches like a 1v3 retake emerge. And the hold edge **inverts**: post-plant the *attackers* hold the crossfire on the spike, the defenders are the ones pushing in. That single change both models reality and lands the balance — with all three round-dynamics in, the engine sits at **~49% attacker, ~6% stalls**, with a believable spread of eliminations, detonations, and defuses.

**Comp — in (what you field):** the other half of the plan. `MatchInput.comp` sets which **agent** each player fields; a player with no pick defaults to their highest-mastery main, so every team always has a comp. The fielded agent decides the **kit** (a Viper comp throws smokes, a Sova comp throws recon — so the comp shapes a team's whole utility profile), carries a **duel edge** from the agent's patch tier × the player's **mastery** on it, and scales that player's utility by how well they play the agent. Picking mastered meta agents is a real edge: on identical rosters, fielding mains beats forcing off-pool picks **~88% of matches**. The fielded agent rides along on `PlayerMeta` (additive) so the viewer shows the comp on the scoreboard.

**Economy — in (the buy rhythm):** credits now have real pressure — a buy *spends* (full ~3900, force ~2300) and rounds *earn* (win 3000, escalating loss bonus 1900/2400/2900, +200 a kill, +300 for planting even in a lost round). So buys read the situation and teams **save**: when a full is out of reach and they're not desperate, they eco to bank for next round rather than half-buy into rifles. The pistol → bonus/eco → gun-round → force rhythm that drives Valorant strategy now falls out on its own, and weaker buys mean weaker guns mean harder rounds — an eco round shows up as a ~90% round for the full-buy side. The viewer shows each team's buy (FULL / FORCE / ECO) on the scoreboard.

**All 11 maps — in the pipeline:** every official map (ascent, abyss, bind, breeze, fracture, haven, icebox, lotus, pearl, split, sunset) drops through the same alpha→navmesh pipeline — `pnpm navmesh:all` builds them, `pnpm sim -- --map bind` resolves on any of them, and the viewer renders whichever map the timeline names. The "drop a `displayIcon`, get a playable map" thesis, proven 11×. Caveat: **Ascent is the tuned reference**; the others ship on first-pass eyeballed anchors, so they complete and render but don't yet *play* as balanced (far-apart-site maps like fracture/bind skew attacker-sided because rotation timing is tuned to Ascent's scale, and Haven/Lotus field two of their three sites until the engine models N sites). Per-map anchor tuning + 3-site support is the follow-up.

**Tactics editor (v1) — in, and the engine runs *in your browser*:** the determinism thesis pays off again — `simulateMatch(input, nav)` is now pure (the navmesh is injected, no disk I/O), so the **same engine runs client-side**. The web app is now a live tactics editor: tune both teams' dials (site bias, tempo, read, aggression, entry, lurk) and the seed, and the match **re-simulates instantly in the page** — watch it back with the True Odds, no server round-trip. Seed 42 produces the identical 13–5 in the browser as on the CLI: determinism holds across runtimes. (v1 authors the *dials*; drawing per-player routes on the minimap is the next step.)

**Authored plays + kill points — in (the engine half of "draw the play"):** the first step toward the cs-manager-style editor isn't a UI, it's the *engine* learning to run an authored play. `Tactics.defense.play` lets an owner place each defender **exactly** — a `pos` to hold — instead of leaving them to the procedural read, and attach a **kill point**: a conditional rotation (`rotate: { pos, onDeathOf }`) that fires when a named teammate dies. Park a player to bait mid; the moment they trade out, the team **collapses onto the kill point**. It's reactive play that falls out of geometry, not a scripted exception — and it costs nothing new in the contract, because a kill point is just a held position whose release trigger is *a teammate's death* instead of *contact*, reusing the same `departT` hold-then-rotate machinery info-gated rotations already gave us (still timeline `version: 1`). v1 is hold + one conditional rotation.

**Drag-to-place editor — in (v2 begins):** the authored play now has a *canvas*. Open a team's defense play and the editor drops a draggable dot for each defender straight onto the minimap — and because the map renders in the engine's own 1000×1000 image space (the same coords A* pathfinds on), **a dot's position *is* its engine position**, no projection to keep in sync. Drag to place each hold; tick **kill point** on any player and a gold ↻ target appears with a dashed line from the hold, draggable too, plus a "rotate when ___ dies" trigger picker. Every edit clones the `Play` and re-sims live in the browser — move a defender across the map and watch the scoreline move with them (placing the bait at mid lands seed 42 at 13–3; dragging an anchor out of position swings it to 13–8). Clear the play and the team falls back to the procedural read. This is the cs-manager idea made literal: you draw the geometry, the engine resolves it.

**Routes — in (the path, not just the endpoint):** a hold is *where* a player ends up; a **route** is *how they get there*. `PlayerPlan.route` is the ordered waypoints walked into the hold (`[...route, pos]` is the full path), so the player now travels a drawn line at round start instead of materialising on their spot — and a **longer route is a genuine tradeoff: they're set up later** (a far defender route delays them past first contact). In the editor you pick a player, click the map to drop waypoints (spawn → hold, in travel order), drag them to refine, and click one to remove; the route draws as a live polyline and re-sims on every change. The elegant part: this needed *zero* new playback code — the engine's `posAt`/`facingAt` and the viewer's `posWithDepart`/`facingOf` already walk a `path` array, so a multi-point route just rides the existing `move` event (timeline still `version: 1`). Routes are the shared primitive both sides need, which is why they come before attack-side plays.

**Routed kill points + a waypoint budget — in:** a kill point now carries its *own* route, so you author not just where a player collapses but the exact path they take to get there (the engine walks it verbatim on the trigger, falling back to A\* when unrouted — so an old play stays byte-identical). And routes are **capped at five waypoints each** (`MAX_ROUTE_WAYPOINTS`): a play is a sketch, not turn-by-turn micro — enough to steer a player around a corner or through mid, not enough to script every footstep. The editor enforces the budget live (the counter turns red and the map shakes at the cap), with the hold route and the rotation route each getting their own five.

The three round-dynamics steps (trading, info-gated rotations, retake) are done — adaptive mid-round reads are parked as an **IGL** trait for the player model.

Next, in order (see `docs/DESIGN.md` §17):
1. **Tactics editor (v2) — keep drawing** — drag-to-place holds, kill points, routes, and routed kill-points (with a waypoint budget) are in; next are more triggers (on-contact, at-time, N-step chains), authored facing/crossfires, utility lineups, and **attack-side plays** (executes, lurks, defaults as authored geometry, built on the route primitive) — the big one, since the attack is half the game.
2. **The persistent world** — scheduling, the resolution worker, accounts, clubs (NestJS + Supabase + Stripe, Phase 2) — where these match inputs (roster, comp, tactics) come from real owners.
3. **Per-map tuning + N-site support** — all 11 maps are navmeshed and simulate; tune each map's anchors (and scale rotation timing to map size) so they play as balanced as Ascent, and teach the engine 3-site maps (Haven, Lotus). Staying 2D — a per-map height layer only if a vertical map needs it.
