import type { MapId, Vec2, PatchState, Team } from './models.js';

/** What the engine takes in. Deterministic given identical input. */
export interface MatchInput {
  seed: number;
  map: MapId;
  teams: [Team, Team];
  patch: PatchState;
}

export type RoundMethod = 'elimination' | 'detonation' | 'defuse' | 'time';

/** All event `t` values are normalized 0..1 WITHIN a round. */
export type MatchEvent =
  | { t: number; arrive: number; kind: 'move'; agent: string; path: Vec2[] }
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
  spawns: Record<string, Vec2>;      // agent handle -> spawn point
  events: MatchEvent[];
}

export interface PlayerMeta { id: string; handle: string; role: string; igl?: boolean; }
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
