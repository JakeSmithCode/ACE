// Scouting fog (DESIGN §4.1, §5.3) — the manager never sees a player's true
// potential, only a *scouted estimate* with a confidence that's higher for older
// players (their ceiling is closer to realised) and for players you own (you see
// them every day). The estimate is biased by a deterministic per-player noise
// scaled by how little you know — so the market's mispriced gems are the kids
// whose true ceiling sits outside the consensus read. Pure, like everything here.
import type { Player, Attributes } from '@ace/shared';
import { overall, potentialOverall } from './develop.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Deterministic noise in [-1, 1) from a player id (FNV-1a). */
function noise(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 2000) / 1000 - 1;
}

// Scouting is an INVESTMENT, not free knowledge: you commission reports on a player
// you own (or intake) to clear the fog on his ceiling — each level buys confidence.
// The flip: scout a hidden gem, his revealed potential lifts his value, sell high.
export const SCOUT_MAX = 3;
const SCOUT_CONF = 0.16;   // confidence gained per scouting level

/** How well the ceiling is known (0..1): older players are clearer, owning a player
 *  adds confidence (your staff watch them daily), and each commissioned `scoutLevel`
 *  buys more — but plasticity (`potVar`) is irreducible until the player develops. */
export function scoutConfidence(p: Player, owned = false, scoutLevel = 0): number {
  const realised = clamp((p.age - 15) / 13, 0, 1);
  return clamp(0.22 + realised * 0.5 + (owned ? 0.26 : 0) + scoutLevel * SCOUT_CONF, 0.15, 0.98);
}

/** The scouted potential overall — the true ceiling fogged by (1 − confidence).
 *  Never reads below current ability (you can always see what a player IS). */
export function scoutedPotential(p: Player, owned = false, scoutLevel = 0): number {
  const conf = scoutConfidence(p, owned, scoutLevel);
  const band = (1 - conf) * 22;
  return clamp(Math.round(potentialOverall(p) + noise(p.id) * band), overall(p), 99);
}

/** Scouted potential as a 1–5 star rating (what the UI shows instead of truth). */
export const scoutedStars = (p: Player, owned = false, scoutLevel = 0): number =>
  Math.max(1, Math.min(5, Math.round((scoutedPotential(p, owned, scoutLevel) - 44) / 9)));

/** A PER-SKILL scouted ceiling — the true per-attribute potential fogged like the
 *  overall, but each skill carries its OWN noise, so a player's aim ceiling can read
 *  clear while his utility ceiling stays murky. This is potential per skill, not as
 *  a lump: the spiky prospect (one elite ceiling, one capped) becomes legible, and
 *  role-fit is a real read. Never below the current value (you see what a skill IS). */
export function scoutedAttr(p: Player, attr: keyof Attributes, owned = false, scoutLevel = 0): number {
  const cur = Math.round(p.attr[attr]);   // ability is fractional in-season — round the floor so the ceiling never reads fractional
  const truePot = p.potential?.[attr] ?? cur;
  const band = (1 - scoutConfidence(p, owned, scoutLevel)) * 20;
  return clamp(Math.round(truePot + noise(`${p.id}:${attr}`) * band), cur, 99);
}

/** A per-skill scouted breakdown — `cur` (what the skill IS) + `ceil` (the fogged
 *  per-attribute ceiling) + `mech` (mechanical vs cerebral). This is potential per
 *  SKILL, not a lump: a spiky prospect (elite entry ceiling, capped utility) becomes
 *  legible and role-fit is a real read. The order is mechanical-first then cerebral. */
export interface AttrScout { key: keyof Attributes; cur: number; ceil: number; mech: boolean }
const ATTR_ORDER: (keyof Attributes)[] = ['aim', 'movement', 'entry', 'gameSense', 'utility', 'clutch'];
const MECH_ATTRS = new Set<keyof Attributes>(['aim', 'movement', 'entry']);
export function scoutedAttrs(p: Player, owned = false, scoutLevel = 0): AttrScout[] {
  return ATTR_ORDER.map(key => ({ key, cur: Math.round(p.attr[key]), ceil: scoutedAttr(p, key, owned, scoutLevel), mech: MECH_ATTRS.has(key) }));
}

/** The scouted ceiling **range** — the gamble made legible. Wide for an
 *  unresolved prospect (real plasticity `potVar` + observation error), tight for
 *  a settled veteran you own. `[lo, hi]` overall — "this kid could be 78 or 94". */
export function scoutedRange(p: Player, owned = false, scoutLevel = 0): [number, number] {
  const center = scoutedPotential(p, owned, scoutLevel);
  const v = p.potVar ?? 0;
  const band = Math.round(v * 14 + (1 - scoutConfidence(p, owned, scoutLevel)) * 7);
  return [clamp(center - band, overall(p), 99), clamp(center + band, overall(p), 99)];
}
