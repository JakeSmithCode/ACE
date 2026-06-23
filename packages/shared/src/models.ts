// Core data models. See docs/DESIGN.md.
export type Role = 'duelist' | 'initiator' | 'controller' | 'sentinel';
export type MapId =
  | 'ascent' | 'bind' | 'haven' | 'split' | 'lotus'
  | 'sunset' | 'breeze' | 'icebox' | 'pearl' | 'fracture' | 'abyss';
export type Vec2 = [number, number]; // minimap image space, 0..1000

/** Current-ability layer of the three-layer player model (DESIGN.md §4). */
export interface Attributes {
  aim: number;        // mechanical accuracy        (0..100)
  movement: number;   // counter-strafe / peeking
  gameSense: number;  // positioning, timing, crosshair placement
  utility: number;    // ability usage & lineups
  clutch: number;     // composure under pressure
  entry: number;      // aggression / opening duels
}
export interface AgentMastery { agent: string; level: number; } // 0..100

export interface Player {
  id: string;
  handle: string;
  role: Role;
  igl?: boolean;
  age: number;
  attr: Attributes;     // current ability
  agents: AgentMastery[];
}

export interface Team {
  id: string;
  tag: string;          // "NCT"
  name: string;         // "Nocturne"
  players: Player[];    // five
}

/** Live meta (DESIGN.md §7). Agent tier multipliers, etc. */
export interface PatchState {
  version: string;
  agentTier: Record<string, number>; // agent -> strength multiplier (~1.0)
}
