import type { MapId, Vec2, PatchState, Team, Tactics, Comp } from './models.js';

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
export type MatchEvent =
  | { t: number; arrive: number; departT: number; kind: 'move'; agent: string; path: Vec2[]; hold: Vec2 }
  | { t: number; kind: 'kill'; killer: string; victim: string; weapon: string }
  | { t: number; kind: 'plant'; agent: string; site: 'A' | 'B' }
  | { t: number; kind: 'defuse'; agent: string }
  | { t: number; kind: 'ability'; agent: string; ability: string };

export interface RoundEconomy {
  buy: Record<'0' | '1', 'full' | 'force' | 'eco' | 'pistol'>;
  creds: Record<'0' | '1', number>;
}

export interface Round {
  n: number;                         // 1-based
  attacker: 0 | 1;                   // attacking side this round
  winner: 0 | 1;
  method: RoundMethod;
  site: 'A' | 'B';
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
