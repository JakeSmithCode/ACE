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

/** A team's pre-match plan — the manager's lever, resolved by the engine (DESIGN §6).
 *  Every field is a normalized dial; the engine reads them into round play. */
export interface Tactics {
  attack: {
    siteBias: number;   // -1 always B · 0 balanced · +1 always A
    tempo: number;      //  0 slow default (take map control) .. 1 fast execute (rush)
    entry?: string;     // player id who leads the push (defaults to the best opening duelist)
    lurk?: string;      // player id who peels off to lurk a flank for picks + late info
  };
  defense: {
    read: number;       // -1 stack B · 0 spread · +1 stack A  (pre-round site read)
    aggression: number; //  0 passive anchors .. 1 aggressive picks / forward holds
    play?: Play;        // authored positions + kill points; overrides the procedural setup
  };
}

/** The house default play set. Every team always has tactics — an owner authors
 *  their own, and a club with none (or a bot-run club) falls back to this so a
 *  match never lacks a plan. Balanced and unsurprising on purpose. */
export const DEFAULT_TACTICS: Tactics = {
  attack: { siteBias: 0, tempo: 0.5 },
  defense: { read: 0, aggression: 0.4 },
};

/** A team's comp for a match: which agent each player fields, keyed by player id.
 *  A player not listed defaults to their highest-mastery agent (their main), so
 *  — like tactics — every team always has a comp even if the owner sets nothing. */
export type Comp = Record<string, string>;

/** An authored play: per-player positions on the map, with conditional **kill
 *  points** — a player holds `pos`, then rotates to `rotate.pos` when the named
 *  teammate dies (`rotate.onDeathOf`, a player id). This is the cs-manager-style
 *  "tell players exactly where to go", reactive: lose the bait, the team
 *  collapses. v1 is a hold + one conditional rotation; it grows from here. */
export interface PlayerPlan {
  player: string;                                 // player id
  pos: Vec2;                                      // where they set up / hold
  rotate?: { pos: Vec2; onDeathOf: string };      // kill point: rotate here when onDeathOf dies
}
export interface Play {
  plans: PlayerPlan[];                            // one entry per player on this side
}
