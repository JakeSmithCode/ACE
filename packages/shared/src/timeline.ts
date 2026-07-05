import type { MapId, Vec2, PatchState, Team, Tactics, Comp, SiteId } from './models.js';

/** What the engine takes in. Deterministic given identical input. */
export interface MatchInput {
  seed: number;
  map: MapId;
  teams: [Team, Team];
  patch: PatchState;
  tactics?: [Tactics, Tactics];  // per-team plan; a neutral default is used if absent
  comp?: [Comp, Comp];           // per-team agent picks; players default to their main
}

export type RoundMethod = 'elimination' | 'detonation' | 'defuse' | 'time';

/** All event `t` values are normalized 0..1 WITHIN a round.
 *  A `move` plays as: hold at `path[0]` until `departT` (a rotator waiting on
 *  info; 0 for everyone who moves at once), then travel `path` over `arrive`.
 *  `hold` is the unit heading the agent looks down while holding or once arrived;
 *  mid-path its facing is the path's own direction. path + departT + arrive +
 *  hold reconstruct position and facing at any t. Additive since v1. */
/** One journey segment for a MULTI-LEG move (additive since v1): an agent whose
 *  plan changed mid-round (a kill-point rotation, the post-plant re-setup) walks
 *  several legs. The move event's base fields ARE leg 0 (old consumers replay it
 *  and simply freeze at its end — graceful); `legs` are the journeys after it, in
 *  departure order. Each leg starts where the previous ended (`path[0]`), departs
 *  at its own absolute `departT`, and carries its own `pauses`/`hold`. The leg
 *  active at time t is the LAST one with departT ≤ t (none departed → leg 0,
 *  holding at its path[0]). */
export interface MoveLeg {
  path: Vec2[]; departT: number; arrive: number;
  pauses?: { t: number; dur: number }[]; hold?: Vec2;
}

export type MatchEvent =
  // `pauses` (additive): moments the agent HALTED mid-travel — winning a fight costs a
  // beat stationary at the kill spot. Each pause extends the effective journey: position
  // is path-progress over (t − departT − paused time so far) / arrive.
  // `legs` (additive): journeys AFTER the base one — see MoveLeg.
  | { t: number; arrive: number; departT: number; kind: 'move'; agent: string; path: Vec2[]; hold: Vec2; pauses?: { t: number; dur: number }[]; legs?: MoveLeg[] }
  // `hp` (additive): the winner's remaining health after the fight — duels chip the
  // victor, so a contested kill leaves a wounded player for the next contact to clean up.
  // `hs` (additive): the kill was a headshot — a clean one-tap (high-aim players land
  // them more), which is why the winner took almost no return damage.
  | { t: number; kind: 'kill'; killer: string; victim: string; weapon: string; hp?: number; hs?: boolean }
  // a non-lethal EXCHANGE (additive kind): a close duel that broke off without a kill —
  // `from` hit `to` for `dmg`, leaving them at `hp`. Emitted per direction (a graze wounds
  // both). Consumers that only know kills simply skip it.
  | { t: number; kind: 'dmg'; from: string; to: string; dmg: number; hp: number; dash?: boolean }
  // `face` (additive kind): the agent TURNED — an explicit facing override the
  // viewer can't derive from the path (a head-turn window `t..until`). The viewer
  // replays it into its fight-face windows; consumers that don't know it simply
  // skip it (facing falls back to the path/hold reconstruction). Currently
  // DORMANT: the footsteps/hearing producer measured out (see sim.ts) — the
  // contract + viewer support stay for the next facing producer.
  | { t: number; kind: 'face'; agent: string; dir: Vec2; until: number }
  | { t: number; kind: 'plant'; agent: string; site: SiteId }
  | { t: number; kind: 'defuse'; agent: string }
  // `at`/`r`/`until` give the ability its geometry on the map (a circle at `at` of
  // radius `r`, active from `t` to `until` in round-normalized time) so the viewer
  // can draw the smoke/flash/trap. Optional + additive: a consumer that ignores
  // them sees the old behaviour, so `version` stays 1. `side` (0|1) tints it.
  // `at2` (additive): the far endpoint of a WALL smoke — the cloud is a capsule
  // from `at` (the centre) mirrored through to `at2`'s opposite, radius `r`
  // (consumers without it draw the sphere at `at` as before).
  | { t: number; kind: 'ability'; agent: string; ability: string; side?: 0 | 1; at?: Vec2; at2?: Vec2; r?: number; until?: number };

export interface RoundEconomy {
  buy: Record<'0' | '1', 'full' | 'force' | 'eco' | 'pistol'>;
  creds: Record<'0' | '1', number>;
}

export interface Round {
  n: number;                         // 1-based
  attacker: 0 | 1;                   // attacking side this round
  winner: 0 | 1;
  method: RoundMethod;
  site: SiteId;
  economy: RoundEconomy;
  winPct: number;                    // P(attacker wins) for THIS setup, by re-simulating the round
  spawns: Record<string, Vec2>;      // agent handle -> spawn point
  events: MatchEvent[];
}

export interface PlayerMeta { id: string; handle: string; role: string; igl?: boolean; agent?: string; }
export interface TeamMeta { id: string; tag: string; name: string; players: PlayerMeta[]; }

/** The single most important artifact: engine output, viewer input. */
export interface MatchTimeline {
  version: 1;
  seed: number;
  map: MapId;
  patch: string;
  teams: [TeamMeta, TeamMeta];
  finalScore: [number, number];
  rounds: Round[];
}
