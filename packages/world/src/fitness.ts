// Fitness — fatigue + injuries for the PvP world, so squad DEPTH matters on match night
// (the payoff for the always-open depth market + the squad depth chart). Mirrors the tuned
// single-player model: a starter tires every match-day and dulls; high fatigue raises injury
// risk; an injured player sits out and a same-role reserve covers (no cover → he plays HURT).
// Pure + seeded — the server ticks it per match-day. It lives only for HUMAN-OWNED clubs
// (AI clubs stay abstract), so a world with no owners is byte-identical (no fitness, no debuff).
import type { Attributes, Player, Team } from '@ace/shared';
import { Rng } from '@ace/engine';
import { overall } from './develop.js';

export const FAT_GAIN = 26, FAT_RECOVER = 12, FAT_MAX = 100;   // played +gain, rested −recover
export const FAT_PEN = 0.10;                                    // attr loss at full fatigue (×0.90)
export const INJ_BASE = 0.012, INJ_FAT = 0.05;                  // injury chance = base + fatigue·fat
export const HURT_PEN = 0.20;                                   // forced to play injured (no cover)

/** Per-(owned)-player fitness state, keyed by player id. Carried on WorldState (jsonb). */
export interface Fitness { fat: Record<string, number>; inj: Record<string, number> }
export const emptyFitness = (): Fitness => ({ fat: {}, inj: {} });
export const fatigueOf = (f: Fitness | undefined, id: string): number => f?.fat[id] ?? 0;
export const injuryOf = (f: Fitness | undefined, id: string): number => f?.inj[id] ?? 0;
export const isInjured = (f: Fitness | undefined, id: string): boolean => injuryOf(f, id) > 0;

/** Match-night attribute multiplier: fatigue dulls; an injured player FORCED to play (no
 *  cover) takes a heavier hit. 1.0 = fresh. */
export function fitnessFactor(f: Fitness | undefined, id: string, playingHurt: boolean): number {
  const fat = 1 - FAT_PEN * (fatigueOf(f, id) / FAT_MAX);
  return fat * (playingHurt ? 1 - HURT_PEN : 1);
}

const scaleAttrs = (a: Attributes, f: number): Attributes => {
  const out = {} as Attributes;
  for (const k of Object.keys(a) as (keyof Attributes)[]) out[k] = Math.max(1, Math.round(a[k] * f));
  return out;
};

/** The five a club actually fields given injuries: start from the intended five (`baseFive`
 *  = `planFive`), and for each injured member swap in the best healthy same-role reserve —
 *  if none exists he plays HURT (kept in the five). Never fields fewer than five. */
export function fitFive(roster: Player[], baseFive: Player[], f: Fitness | undefined): { five: Player[]; hurt: Set<string> } {
  const used = new Set(baseFive.map(p => p.id));
  const hurt = new Set<string>();
  const five = baseFive.map(p => {
    if (!isInjured(f, p.id)) return p;
    const cover = roster.filter(r => r.role === p.role && !used.has(r.id) && !isInjured(f, r.id))
      .sort((a, b) => overall(b) - overall(a))[0];
    if (cover) { used.add(cover.id); used.delete(p.id); return { ...cover, igl: p.igl }; }
    hurt.add(p.id); return p;
  });
  return { five, hurt };
}

/** Build a fitness-adjusted team for an owned club: field `fitFive`, then scale each player's
 *  attributes by his `fitnessFactor`. Returns the team (for the engine) + the fielded five
 *  (so the tick fatigues exactly who played). `f` undefined → fresh team (byte-identical). */
export function fitTeam(c: { id: string; tag: string; name: string; roster: Player[] }, baseFive: Player[], f: Fitness | undefined): { team: Team; fielded: Player[] } {
  const { five, hurt } = fitFive(c.roster, baseFive, f);
  const players = five.map(p => {
    const igl = p.role === 'sentinel';
    const factor = fitnessFactor(f, p.id, hurt.has(p.id));
    return factor >= 1 ? { ...p, igl } : { ...p, igl, attr: scaleAttrs(p.attr, factor) };
  });
  return { team: { id: c.id, tag: c.tag, name: c.name, players }, fielded: five };
}

/** Post-match update for one roster: heal injuries a day, tire the five who played (+ roll a
 *  new injury at the fatigue they played), recover the rest. Pure + seeded; `horse(id)` flags
 *  the workhorse trait (tires slower, hurt less). Returns the new state + any fresh injury. */
export function tickFitness(prev: Fitness | undefined, roster: Player[], fielded: Set<string>, rng: Rng, horse: (id: string) => boolean): { fitness: Fitness; injured: { id: string; days: number } | null } {
  const fat: Record<string, number> = { ...(prev?.fat ?? {}) };
  const inj: Record<string, number> = { ...(prev?.inj ?? {}) };
  for (const id of Object.keys(inj)) { if (inj[id] - 1 > 0) inj[id] -= 1; else delete inj[id]; }   // heal a match-day
  let injured: { id: string; days: number } | null = null;
  for (const p of roster) {
    const cur = fat[p.id] ?? 0;
    if (fielded.has(p.id)) {
      const h = horse(p.id);
      if (!(p.id in inj) && rng.chance((INJ_BASE + INJ_FAT * (cur / FAT_MAX)) * (h ? 0.7 : 1))) {
        inj[p.id] = rng.int(2, 4); fat[p.id] = 20;        // sidelined; rests while out
        if (!injured || overall(p) > overall(roster.find(r => r.id === injured!.id) ?? p)) injured = { id: p.id, days: inj[p.id] };
      } else {
        fat[p.id] = Math.min(FAT_MAX, cur + FAT_GAIN * (h ? 0.8 : 1));
      }
    } else {
      fat[p.id] = Math.max(0, cur - FAT_RECOVER);          // bench/rest recovers
    }
  }
  return { fitness: { fat, inj }, injured };
}
