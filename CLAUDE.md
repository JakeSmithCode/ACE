Orientation and guardrails for working in this repo. Read this before changing engine or contract code.

## What ACE is

An asynchronous, server-authoritative Valorant esports management sim. You own a club; you set rosters/comps/tactics ahead of time; a deterministic engine resolves every scheduled match on a tick; you watch matches back on a 2D viewer. A match is a pure function of `(rosters, tactics, patch, seed)`, so "live" and "replay" are the same stored data, and any round can be rewound and re-simulated. Full design: `docs/DESIGN.md`.

The bet: we don't compete on 3D fidelity, we compete on **interrogability** — a tactical instrument you can rewind, fork, and x-ray.

## The one rule that everything depends on: determinism

The engine is pure. Same input → byte-identical output, forever.

- **No `Math.random()`. Ever.** Use the seeded PRNG in `packages/engine/src/rng.ts` (mulberry32). Thread the `Rng` instance through; never create a second source of randomness.
- **No `Date.now()`, no `performance.now()`, no wall-clock, no I/O** inside `simulateMatch` or anything it calls.
- **No iteration-order nondeterminism.** Don't rely on `Object.keys` order across engines, `Set`/`Map` insertion quirks, or floating-point that varies by platform in a way that branches the sim. Sort explicitly where order matters.
- If you add a system that needs "randomness," it draws from `rng`. If it needs "time," it uses the round's normalized `t` (0..1).

**How to verify after any engine change:** run `pnpm sim -- --seed 42` twice and diff the output — it must be byte-identical. Then run a spread of seeds and confirm every match completes (a side reaches 13) and the ending-method mix looks sane. Determinism breaking is the highest-severity bug in this codebase; it silently kills replays, debugging, and server resolution.

## The spine: the timeline contract

`packages/shared/src/timeline.ts` defines `MatchInput` → `MatchTimeline`. The engine emits it; the viewer reads it. Neither side may know anything about the other beyond this shape.

- Treat the contract as an API. Changing it is a real decision, not a convenience — it ripples to the engine (producer) and the viewer (consumer) at once.
- Adding a field is usually safe (consumers ignore unknowns). Changing/removing a field, or changing the meaning of `t`, is breaking — update both sides and bump thinking about `version`.
- Event `t` is normalized 0..1 within its round. Keep it that way.

## The map pipeline (and why it's elegant)

A map's official minimap (`displayIcon`) is also its collision data: the alpha channel is the walkability mask — opaque = floor, transparent = wall. `packages/maps`:

- `scripts/build-navmesh.ts` reads alpha → a coarse walkable grid → `data/<map>.navmesh.json`.
- `src/navmesh.ts` runs A* on that grid (`pathfind`), plus the LOS/vision primitives (`losClear`, `inView`).
- To add a map: drop its `displayIcon` in `assets/`, rerun `pnpm navmesh`. No hand-tracing. Everything downstream (routing, vision, future heatmaps) operates in the same 1000×1000 image space, so it all lines up for free.

When you touch geometry, reuse these primitives — don't write a second raycaster or a second notion of "walkable."

## Current state

Phase 0 (the keystone) works: a real deterministic engine producing full matches, the map pipeline, and a viewer rendering it on the actual Ascent minimap.

Vision is now wired end to end (roadmap step 1, done): agents have a facing and a ~120° awareness cone; `inView()` composes that cone onto the alpha-mask LOS; a duel only resolves if someone sees the other, and spotting an unaware enemy first is decisive. The viewer renders each agent's wall-clipped vision cone by raycasting the same navmesh. This is correct — keep building on it. Backstabs, off-angles, and retakes should emerge from geometry, never from hand-authored exceptions.

Utility is in (roadmap step 2): abilities fire for real and bend duels through the same geometry — no hand-authored exceptions. Controllers throw `Smoke`s (vision-blocking circles over time); initiators/attacking-duelists throw `Pulse`s (recon/flash that grant the first shot in an area-window). **Smokes are directional: an enemy smoke on the sightline blinds that viewer, never the side that threw it** (`blindedThrough()`). This is the load-bearing decision — it's what makes the `utility` attribute a net positive instead of self-harm (an earlier symmetric model made higher utility *lose* more). Reach/duration scale with the caster's `utility` (0..1), so the stat expresses through play. If you extend utility, preserve that invariant: more utility must help its owner.

Match-night form is in (the match-expression layer of the three-layer model). Each player draws one form edge per match (`FORM_SWING`, in `simulateMatch` so it's held all match), added to their duel edge — same roster, different night. Drawn in a fixed team/player order to stay deterministic; if you add draws before it, the whole stream shifts (that's fine, just regenerate the sample). Keep it bounded and *fair* (DESIGN §2/§18: a bust is a risk you took, never the dice mugging you). The viewer shows it live via the scoreboard (K/D tallied from kill events — no contract change). The third layer's missing piece, *potential behind fog*, belongs to scouting/management (Phase 3), not the engine.

True Odds is in — the determinism thesis turned into a feature. The round resolution is now a pure function, `resolveRound(agents, smokes, pulses, nav, …, rng)`, split out from setup. `simulateRound` runs it once canonically on the **match rng**, then `FORKS` (120) more times on *throwaway* agent copies seeded by `forkSeed(seed, n, i)` to measure how often the attacker wins — the round's `winPct`. **The forks must never draw from the match rng** (that's why they get their own `new Rng`); this is what keeps the canonical timeline byte-identical. `winPct` is additive on `Round` (version stays `1`); the viewer plots it. If you change setup-time rng draw order, regenerate the sample.

Tactics is in — the manager's lever, and the bridge to the management game. `MatchInput.tactics?: [Tactics, Tactics]` (the type lives in `@ace/shared/models`). The round *resolves* it: attacker `siteBias` weights site choice; `tempo` scales attacker arrival + execute timing; defender `read` decides where bodies pre-commit (they set up on the read, **not** the actual site, so a wrong read is paid for in rotation time — rotators move at 0.6 speed and arrive late); `aggression` pushes mids forward and trades the held-angle `holdBonus` for early picks. The attacker-site-vs-defender-read mind-game is real (~7pt round swing on identical rosters; verify by holding rosters equal and flipping only the read). **Every team always has tactics**: owners author their own; a club/bot without them falls back to `DEFAULT_TACTICS` (in `@ace/shared`, so the engine and the future management layer share one default). Tactics is an engine *input* — it does not touch the `MatchTimeline` contract or the viewer. Since this changed the canonical stream, the committed sample was regenerated (seed 42 is now 22 rounds / 156 kills).

## A settled contract decision (don't relitigate by accident)

Rendering vision needed facing in the timeline. The decision made: expose **only `move.hold`** — the unit heading an agent looks down once it reaches the end of its path. Facing *while moving* is the path's own direction, so a consumer reconstructs facing at any `t` from `path` + `arrive` + `hold` (see `facingOf()` in the viewer, which mirrors the engine's `facingAt()`). This was chosen over a per-tick facing track because the engine doesn't model look-arounds — sampling would just store a function the viewer can already derive. It's additive, so `version` stayed `1`. If you ever add genuine mid-path look mechanics, that's when a sampled track earns its keep — and its own `version` bump.

The viewer fetches `apps/web/public/<map>.navmesh.json` (emitted by `pnpm navmesh` alongside the engine's copy) and reuses the engine's exact LOS sampling to clip cones, so what you see matches what the engine resolved. Don't write a second raycaster.

## Tuning knobs (gameplay feel, not correctness)

These shape how lethal getting caught off-guard feels; expect to dial them after watching matches back. Keep them named constants, not magic numbers scattered in logic:

- `FOV` (cone half-angle, ~60°) — how much peripheral awareness an agent has.
- `FIRST_SHOT` — the edge for seeing an unaware enemy first; the single biggest lever on backstab/retake lethality.
- `SMOKE_R` / `SMOKE_R_UTIL`, `SMOKE_DUR` / `SMOKE_DUR_UTIL` — smoke size/duration and how hard they scale with utility; the bigger lever on how much space utility buys.
- `PULSE_R` / `PULSE_R_UTIL`, `PULSE_DUR` / `PULSE_DUR_UTIL` — recon/flash reach and window; the lever on how decisive entries are.
- `FORM_SWING` — match-night form band (± duel edge per player). Bigger = more star/dud variance night to night; keep it fair and legible, never a mugging.
- `HOLD_BONUS` + the defender rotation speed (`arriveTime(path, 0.6)`) — together the lever on how hard a wrong defensive read is punished; the heart of the tactics mind-game. Bigger hold / slower rotation = reads matter more.

To re-balance or measure a tuning change, an A/B is easy: gate utility generation, or set every non-utility attribute equal across two rosters and vary only `utility` to confirm the high-utility side wins (~58% of matches at 92 vs 18).

## Conventions

- Monorepo: pnpm + turbo. Packages are consumed as source via path mapping (`@ace/shared`, `@ace/maps`, `@ace/engine`) — tsx runs the engine, Vite bundles the app — so packages have no separate compile step; their "build" is a typecheck (`tsc --noEmit`). Don't add `rootDir`/`outDir` emit back to them, and don't commit `.js`/`.d.ts` next to `.ts` source (the web build is `vue-tsc --noEmit && vite build` specifically to avoid emitting those).
- Commit artifacts that make a cold clone work: the committed sample `apps/web/public/timeline.json` and `packages/maps/data/*.navmesh.json` are intentional so `pnpm install && pnpm dev` works without running the engine first. Regenerate them when their inputs change.
- Before opening a PR / finishing a task: `pnpm typecheck` green, `pnpm sim` deterministic across two runs and complete across several seeds, `pnpm build` green.
- TypeScript strict is on (incl. `noUnusedLocals`) — no dead variables.

## Roadmap (see `DESIGN.md` §17 for detail)

1. **Vision / fog-of-war** — done, both engine and viewer (see above).
2. **Richer match model** — abilities/utility firing and affecting duels: done. Match-night form expressing through play: done (scoreboard surfaces it). Remaining piece — *potential behind fog* — is Phase 3 (scouting), not the engine.
3. **The persistent world** — scheduling, resolution worker, accounts, clubs (NestJS + Supabase + Stripe, Phase 2).
4. **Tactics editor** — same map + navmesh, but you author the execute instead of watching it.
