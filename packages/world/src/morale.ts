// Morale + team talks + captaincy — the human-management layer for the PvP world (the
// counterpart to fitness). Each owned club's players carry a MOOD (0..100) that drifts each
// match-day from results, minutes, the captain, a psychologist, and the manager's team talk;
// high morale lifts match performance a touch, low morale drags. Before a match the manager
// picks a TEAM TALK tone — the right one for the situation (favourite vs underdog, room up or
// flat) gives a one-match edge + a mood bump, the wrong one backfires. Pure + engine-blind
// (it scales an owned club's attrs at build time), owner-scoped — a no-owner world never
// carries morale, so it's byte-identical. Mirrors the tuned single-player model.
import type { Attributes, Player, Team } from '@ace/shared';
import { traitKeyOf, type TraitKey } from './traits.js';

export const MORALE_BASE = 65;      // the mood a fresh room sits at
const MORALE_PEN = 0.08;            // match-attr swing across the band (~±3%)

/** Per-(owned)-player morale, keyed by player id. Carried on WorldState (jsonb). */
export interface Morale { mood: Record<string, number> }
export const emptyMorale = (): Morale => ({ mood: {} });
export const moodOf = (m: Morale | undefined, id: string): number => m?.mood[id] ?? MORALE_BASE;
/** Match-night attribute multiplier from a player's mood (1.0 at ~60). */
export const moraleFactor = (m: Morale | undefined, id: string): number => 1 + ((moodOf(m, id) - 60) / 100) * MORALE_PEN;
/** The squad's average mood (for the team-talk read + a UI readout). */
export const squadMood = (m: Morale | undefined, ids: string[]): number =>
  ids.length ? Math.round(ids.reduce((s, id) => s + moodOf(m, id), 0) / ids.length) : MORALE_BASE;

// --- team talks --------------------------------------------------------------
export type Talk = 'calm' | 'rally' | 'demand';
export const TALK_META: Record<Talk, { label: string; icon: string }> = {
  calm: { label: 'Stay calm', icon: '○' }, rally: { label: 'Rally them', icon: '▲' }, demand: { label: 'Demand more', icon: '✦' },
};
/** Read the room: how well a tone fits the situation. `favEdge` = my strength − opp's (+ =
 *  favourite), `mood` = the squad's current average. Returns a one-match attr edge + a mood
 *  nudge. Same shape the single-player store uses. */
export function talkFit(tone: Talk, favEdge: number, mood: number): { fit: 'great' | 'ok' | 'poor'; edge: number; mood: number } {
  let score = 0;
  if (tone === 'calm') score = (favEdge > 0.03 ? 0.6 : -0.3) + (mood >= 65 ? 0.4 : -0.4);           // keep a confident favourite loose
  if (tone === 'rally') score = (favEdge < 0.03 ? 0.6 : 0.1) + (mood >= 40 && mood < 80 ? 0.3 : -0.2); // lift an underdog / a flat room
  if (tone === 'demand') score = (mood >= 60 ? 0.5 : -0.6) + (favEdge > -0.02 ? 0.3 : -0.3);         // push a good room; piling on a low one backfires
  const fit = score >= 0.6 ? 'great' : score <= -0.2 ? 'poor' : 'ok';
  const edge = fit === 'great' ? 0.03 : fit === 'poor' ? -0.025 : 0.005;
  const nudge = fit === 'great' ? 5 : fit === 'poor' ? -5 : 1;
  return { fit, edge, mood: nudge };
}

// --- captaincy ---------------------------------------------------------------
export const leadership = (p: Player): number => (p.attr.gameSense + p.attr.clutch) / 2;
/** The effective captain of a fielded five: the explicit pick if he's in it, else the best
 *  natural leader among them — so there's always an armband. */
export function captainOf(five: Player[], captainId?: string | null): Player | null {
  if (!five.length) return null;
  const picked = captainId ? five.find(p => p.id === captainId) : null;
  return picked ?? [...five].sort((a, b) => leadership(b) - leadership(a))[0];
}

const scaleAttrs = (a: Attributes, f: number): Attributes => {
  const out = {} as Attributes;
  for (const k of Object.keys(a) as (keyof Attributes)[]) out[k] = Math.max(1, Math.round(a[k] * f));
  return out;
};

/** Apply match-night morale + team talk to an owned club's team. Each player is scaled by his
 *  mood; a chosen `talk` adds a team-wide edge (read against `favEdge`/`mood`); a Big-Game
 *  player sharpens in a derby. Factor 1 → unchanged, so no morale state is byte-identical. */
export function moraleTeam(team: Team, m: Morale | undefined, opts: { talk?: Talk; favEdge?: number; mood?: number; derby?: boolean } = {}): Team {
  const talkEdge = opts.talk ? talkFit(opts.talk, opts.favEdge ?? 0, opts.mood ?? MORALE_BASE).edge : 0;
  const players = team.players.map(p => {
    let f = moraleFactor(m, p.id) * (1 + talkEdge);
    if (opts.derby && traitKeyOf(p.id) === 'bigGame') f *= 1.04;   // a big-game player rises for the derby
    return f === 1 ? p : { ...p, attr: scaleAttrs(p.attr, f) };
  });
  return { ...team, players };
}

/** Post-match mood drift for one owned club's roster: the result lifts/drops the whole room,
 *  minutes reward starters and frustrate the benched, the captain steadies + lifts, a
 *  psychologist helps, the one-shot team talk lands, then slow reversion to base. Traits bend
 *  the swing (hothead/mercurial/professional). A derby win/loss hits harder. No rng — pure. */
export function updateMorale(prev: Morale | undefined, roster: Player[], fielded: Set<string>, won: boolean | null, opts: {
  captain?: Player | null; talk?: Talk; favEdge?: number; psych?: number; derby?: boolean; injured?: (id: string) => boolean; sharpnessCamp?: boolean;
} = {}): Morale {
  const cap = opts.captain ?? null;
  const curMood = squadMood(prev, roster.map(p => p.id));
  const talkMood = opts.talk ? talkFit(opts.talk, opts.favEdge ?? 0, curMood).mood : 0;
  const psych = opts.psych ?? 0;
  const derbySwing = opts.derby ? (won ? 5 : won === false ? -5 : 0) : 0;
  const capLift = cap ? ((leadership(cap) - 50) / 100) * 3 : 0;                      // a strong armband lifts, a weak one drags
  const capRevert = cap ? 0.06 * (0.7 + (leadership(cap) / 100) * 0.8) : 0.06;       // a leader steadies (faster reversion)
  const leaderLift = roster.filter(p => fielded.has(p.id) && traitKeyOf(p.id) === 'leader').length * 0.8;
  const mood: Record<string, number> = { ...(prev?.mood ?? {}) };
  for (const p of roster) {
    let v = mood[p.id] ?? MORALE_BASE;
    const tr: TraitKey | null = traitKeyOf(p.id);
    let result = won === true ? 6 : won === false ? -5 : 0;
    if (tr === 'hothead' && won === false) result *= 1.6;
    if (tr === 'mercurial') result *= 1.4;
    if (tr === 'professional') result *= 0.55;
    const revert = tr === 'professional' ? capRevert * 1.5 : capRevert;
    v += result + derbySwing;
    v += fielded.has(p.id) ? 1.5 : -2.5;                                             // minutes
    if (opts.injured?.(p.id)) v -= 3;
    v += psych + talkMood + capLift + leaderLift + (opts.sharpnessCamp ? 1.6 : 0) + (MORALE_BASE - v) * revert;
    mood[p.id] = Math.max(0, Math.min(100, v));
  }
  return { mood };
}
