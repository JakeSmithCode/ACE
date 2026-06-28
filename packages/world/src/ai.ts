// The AI manager layer (Phase 5, DESIGN §17). An AI-run club is no longer a bag of
// random tactic dials — it plays to a coherent IDENTITY derived from its SQUAD: a roster
// of fraggers plays fast and aggressive, a cerebral roster plays patient and utility-led.
// A deterministic personality tilt (a club-id hash) breaks ties so two similar rosters
// still differ. Pure — a function of the roster + the club id, no rng — so it's stable,
// scoutable (the human can read an opponent's style), and the engine never sees it
// (tactics are a normal MatchInput, so seed 42 is untouched).
import type { Team, Tactics, Attributes, Player, Comp, PatchState, Role } from '@ace/shared';
import { overall } from './develop.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ROLE_NEED: Record<Role, number> = { duelist: 2, initiator: 1, controller: 1, sentinel: 1 };
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Deterministic personality in [-1, 1) from a club id (FNV-1a) — the manager's tilt. */
function tilt(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 2000) / 1000 - 1;
}

const meanOf = (team: Team, keys: (keyof Attributes)[]) =>
  team.players.reduce((s, p) => s + keys.reduce((a, k) => a + p.attr[k], 0) / keys.length, 0) / team.players.length;

export type Archetype = 'Aggressive' | 'Balanced' | 'Tactical' | 'Stifling';
export interface AiStyle { archetype: Archetype; label: string; lean: number }

const STYLE_LABEL: Record<Archetype, string> = {
  Aggressive: 'fast executes, early picks',
  Balanced: 'adaptable, map-control',
  Tactical: 'patient, utility-led',
  Stifling: 'slow, defensive holds',
};

/** The AI manager's tactical identity — `lean` is + for aggressive, − for control. The
 *  archetype is mostly the squad's makeup (mechanical fraggers vs cerebral controllers)
 *  with a personality tilt. Scoutable: the public club page shows it for AI clubs. */
export function aiStyle(team: Team): AiStyle {
  const aggro = meanOf(team, ['entry', 'aim', 'movement']);     // mechanical / aggressive attrs
  const control = meanOf(team, ['gameSense', 'utility', 'clutch']); // cerebral / control attrs
  // squads skew slightly control-heavy (3 support roles vs 2 duelists), so centre with a
  // small offset and lean on the personality tilt — gives a 4-way spread across the league.
  const lean = (aggro - control) / 42 + 0.06 + tilt(team.id) * 0.32;
  const archetype: Archetype = lean > 0.16 ? 'Aggressive' : lean < -0.2 ? 'Stifling' : lean < -0.05 ? 'Tactical' : 'Balanced';
  return { archetype, label: STYLE_LABEL[archetype], lean: r2(lean) };
}

/** Tactics that FIT the squad + the manager's style — the Phase-5 replacement for the
 *  old random dials. Deterministic (a pure function of the roster + club id), so an AI
 *  club plays a coherent style the human can scout and counter. */
export function aiTactics(team: Team): Tactics {
  const { lean } = aiStyle(team);
  const t = tilt(team.id);
  const duelists = team.players.filter(p => p.role === 'duelist').sort((a, b) => b.attr.entry - a.attr.entry);
  const entry = (duelists[0] ?? [...team.players].sort((a, b) => b.attr.entry - a.attr.entry)[0]).id;
  // lean on a lurker only with a genuine second duelist + a personality inclined to it
  const second = duelists[1];
  const lurk = second && second.attr.entry > 55 && t > -0.2 ? second.id : undefined;
  return {
    attack: {
      siteBias: r2(t * 0.5),                                   // a deterministic side preference (the read mind-game)
      tempo: r2(clamp(0.5 + lean * 0.45, 0.25, 0.85)),         // aggressive → fast execute, control → slow map play
      entry, lurk,
    },
    defense: {
      read: r2(-t * 0.4),                                      // pre-commit opposite their attack lean (variety, not a tell)
      aggression: r2(clamp(0.45 + lean * 0.32, 0.2, 0.75)),    // aggressive → forward holds / early picks
    },
  };
}

/** Matchup-aware tactics — a SMART AI manager scouts the opponent and pre-commits its
 *  defensive read toward where that opponent's roster *likes* to hit. It reads the
 *  opponent's roster-fixed BASE siteBias (`aiTactics(opp).attack.siteBias`), NOT their full
 *  matchup tactics, so it's non-circular (a fixed point, not a chase) — the manager is
 *  scouting tendencies, exactly the kind of pre-round read a human authors. A control-leaning
 *  manager (lower `aggression`) trusts the read harder; an aggressive one weights its own
 *  instinct more (it would rather make a play than sit on a read). Pure + deterministic, so
 *  the world CLIs stay reproducible; the engine never sees it, so seed 42 is untouched. */
export function aiMatchupTactics(myTeam: Team, oppTeam: Team): Tactics {
  const base = aiTactics(myTeam);
  const oppBias = aiTactics(oppTeam).attack.siteBias;          // where the opponent's roster prefers to hit
  // a patient manager (low aggression) commits to the scouted read; an aggressive one trusts instinct.
  const trust = clamp(0.75 - base.defense.aggression * 0.5, 0.35, 0.65);
  const read = clamp(base.defense.read * (1 - trust) + oppBias * trust, -1, 1);
  return { ...base, defense: { ...base.defense, read: r2(read) } };
}

// ── AI comp + lineup: read the LIVING META, don't blindly field your main ──────────
// The engine values an agent pick as `compEdge = (tier−1)·60 + (mastery−75)·0.1` — tier
// (the patch) dominates comfort. So a sharp manager re-picks its comp each patch: field a
// buffed agent you have decent mastery on over your highest-mastery off-meta main. This
// makes the agent meta LIVING for AI clubs too (CS-manager has no such patch lever).

/** The engine's valuation of a player on a specific agent (mirrors `addLoadouts`). */
function agentValue(level: number, agent: string, patch?: PatchState): number {
  const tier = patch?.agentTier[agent] ?? 1.0;
  return (tier - 1) * 60 + (level - 75) * 0.1;
}

/** The agent from a player's pool the engine would value most on this patch (id-stable
 *  tiebreak). The patch-aware "main" — a manager reading the meta, not a fixed pick. */
function bestAgent(p: Player, patch?: PatchState): { agent: string; value: number } {
  const pool = p.agents.length ? p.agents : [{ agent: 'Jett', level: 45 }];
  let best = pool[0], bestV = agentValue(best.level, best.agent, patch);
  for (const a of pool) {
    const v = agentValue(a.level, a.agent, patch);
    if (v > bestV || (v === bestV && a.agent < best.agent)) { best = a; bestV = v; }
  }
  return { agent: best.agent, value: bestV };
}

/** A meta-aware comp for an AI club: each player fields the agent the engine values most
 *  on the live patch. Only emits a pick where it differs from the engine's default (the
 *  highest-mastery agent) would be — but emitting the explicit map is harmless and keeps
 *  the resolver simple. Pure + deterministic; the engine treats it as a normal `Comp`. */
export function aiComp(team: Team, patch?: PatchState): Comp {
  const comp: Comp = {};
  for (const p of team.players) comp[p.id] = bestAgent(p, patch).agent;
  return comp;
}

/** A player's effective strength to the AI selector: base overall plus the patch value of
 *  their best agent pick (so a specialist on a hard-buffed agent is worth fielding even a
 *  touch below another's raw overall — the meta promotes them off the bench). */
function lineupRating(p: Player, patch?: PatchState): number {
  return overall(p) + bestAgent(p, patch).value;
}

/** The five an AI club fields, chosen by patch-aware effective strength — so a buffed-agent
 *  specialist gets promoted over a marginally-higher-overall reserve when the meta favours
 *  him. Reduces EXACTLY to `startingFive`'s best-overall pick when no patch (or a flat
 *  patch) makes a difference, so the world/season CLIs stay byte-identical. */
export function aiBestFive(roster: Player[], patch?: PatchState): Player[] {
  const five: Player[] = [];
  (['duelist', 'initiator', 'controller', 'sentinel'] as const).forEach(role => {
    const inRole = roster.filter(p => p.role === role)
      .sort((a, b) => lineupRating(b, patch) - lineupRating(a, patch) || (a.id < b.id ? -1 : 1));
    five.push(...inRole.slice(0, ROLE_NEED[role]));
  });
  return five.map(p => ({ ...p, igl: p.role === 'sentinel' }));
}
