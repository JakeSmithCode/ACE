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
  potential?: Attributes; // per-attribute ceilings the development tick grows toward (behind fog to the manager)
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
    play?: Play;        // authored execute: per-player routes/holds + lineups; forces the site
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

/** An authored play: per-player positions on the map, with an optional **route**
 *  (the path walked to the hold) and conditional **kill points** — a player
 *  holds `pos`, then rotates to `rotate.pos` when the named teammate dies
 *  (`rotate.onDeathOf`, a player id). This is the cs-manager-style "tell players
 *  exactly where to go", reactive: lose the bait, the team collapses. A route is
 *  the ordered waypoints travelled *before* reaching `pos` — `[...route, pos]` is
 *  the full path, so an empty/absent route means they start already on the hold.
 *  A longer route is a real tradeoff: the player is set up later. */
/** What releases a kill-point rotation. `death` = a named teammate dies (the
 *  classic bait); `contact` = the first contact on site (a kill, or an attacker
 *  reaching the site); `time` = the round clock passes `t` (0..1) — the timing
 *  lever that makes a staggered hold ("hold mid until 0.4, then fall to site")
 *  expressible. */
export type RotateTrigger =
  | { kind: 'death'; player: string }   // a teammate (player id) dies
  | { kind: 'contact' }                 // first contact on the contested site
  | { kind: 'time'; t: number };        // round time reaches t (0..1)

export interface PlayerPlan {
  player: string;                                 // player id
  pos: Vec2;                                      // where they set up / hold (the destination)
  face?: Vec2;                                    // a point to watch from the hold (sets the held angle)
  route?: Vec2[];                                 // optional waypoints walked before reaching pos
  rotate?: {                                      // kill point: rotate when the trigger fires
    pos: Vec2;                                    //   the spot to collapse onto
    trigger: RotateTrigger;                       //   what releases the rotation
    route?: Vec2[];                               //   optional authored path for the rotation itself
  };
}
export interface Play {
  plans: PlayerPlan[];                            // one entry per player on this side
  lineups?: Lineup[];                             // authored utility (smokes / flashes / recon)
  site?: 'A' | 'B';                               // attack plays: which site this execute targets (forces the round site)
}

/** An authored utility lineup: a caster throws a smoke/flash/recon to land at
 *  `at` at round-time `t`. It feeds the same smoke/pulse geometry the procedural
 *  utility uses (reach/duration still scale with the caster's utility stat), and
 *  *replaces* that caster's automatic cast — authoring is taking manual control.
 *  Smokes blind the enemy through the cloud; flash/recon grant the first shot in
 *  an area-window. Defensive by side (it lives on `Tactics.defense.play`). */
export type UtilKind = 'smoke' | 'flash' | 'recon';
export interface Lineup {
  player: string;     // caster (player id)
  kind: UtilKind;
  at: Vec2;           // where it lands
  t: number;          // when it deploys (0..1)
}

/** Cap on authored waypoints per route. A play is a *sketch*, not turn-by-turn
 *  micro: a handful of points routes a player around the map without letting an
 *  owner script every footstep (and keeps the engine's path arrays bounded). The
 *  editor enforces it; the hold route and a kill-point's rotation route each get
 *  their own budget. */
export const MAX_ROUTE_WAYPOINTS = 5;
