// The AI manager layer (Phase 5, DESIGN §17). An AI-run club is no longer a bag of
// random tactic dials — it plays to a coherent IDENTITY derived from its SQUAD: a roster
// of fraggers plays fast and aggressive, a cerebral roster plays patient and utility-led.
// A deterministic personality tilt (a club-id hash) breaks ties so two similar rosters
// still differ. Pure — a function of the roster + the club id, no rng — so it's stable,
// scoutable (the human can read an opponent's style), and the engine never sees it
// (tactics are a normal MatchInput, so seed 42 is untouched).
import type { Team, Tactics, Attributes } from '@ace/shared';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
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
