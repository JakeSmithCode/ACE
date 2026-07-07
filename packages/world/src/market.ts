// The transfer market — what gives money a purpose and a developed player a
// price. Deterministic: the free-agent pool is a function of (seed, season).
import { Rng } from '@ace/engine';
import type { Player, Role, PatchState } from '@ace/shared';
import { makePlayer, genHandles } from './clubs.js';
import { overall } from './develop.js';
import { scoutedPotential, SCOUT_MAX } from './scouting.js';

/** A player's transfer value: ability is the floor, *scouted* potential (the
 *  market's fogged read, not the true ceiling) is the premium, and age past peak
 *  is a discount — so a young high-ceiling read is the dearest thing on the
 *  board and an ageing star is cheap. With a `patch`, a player who mains a
 *  buffed agent is worth more (specialists track the meta — DESIGN §7). */
export function playerValue(p: Player, patch?: PatchState, scoutLevel = 0): number {
  // ability is the floor; the potential PREMIUM carries a risk discount when the
  // player is unscouted (a buyer won't pay full for an unproven prospect) that YOUR
  // commissioned `scoutLevel` removes — so a scouting report DE-RISKS a player and
  // reliably lifts his sale value (never lowers it): the flip. The consensus center
  // stays fogged (others' read); only the proof discount moves with your scouting.
  const ovr = overall(p), pot = scoutedPotential(p, false);
  const upside = Math.max(0, pot - ovr);
  const youth = Math.max(0, (28 - p.age) / 12);          // prospects carry the premium
  const proof = 0.55 + 0.45 * Math.min(1, scoutLevel / SCOUT_MAX);   // unscouted premium discounted → scouting unlocks
  const base = Math.pow(ovr, 2.5) * 0.32;                // ability floor
  const premium = upside * youth * 2000 * proof;         // potential premium, de-risked by scouting
  const ageTax = p.age >= 27 ? Math.min(0.5, (p.age - 26) * 0.09) : 0;
  let v = (base + premium) * (1 - ageTax);
  if (patch) {
    const main = [...p.agents].sort((a, b) => b.level - a.level)[0]?.agent;
    const tier = main ? (patch.agentTier[main] ?? 1) : 1;
    v *= 0.55 + tier * 0.45;                             // tier ~0.85..1.15 → mult ~0.93..1.07
  }
  // ACCOLADES are proof: an MVP season is the market's strongest signal (a Young
  // Gun award a softer one) — a decorated player commands a premium, capped so a
  // trophy shelf never dwarfs current ability. Absent → ×1, byte-identical.
  if (p.accolades?.length) {
    const mvps = p.accolades.filter(a => a.startsWith('MVP')).length;
    const ygs = p.accolades.filter(a => a.startsWith('YG')).length;
    v *= 1 + Math.min(0.35, mvps * 0.12 + ygs * 0.06);
  }
  return Math.round(v);
}

// a comp-shaped spread of roles so the market always has options at each position
const ROLE_SPREAD: Role[] = ['duelist', 'duelist', 'initiator', 'controller', 'sentinel'];

/** A deterministic pool of free agents for a season — handles disjoint from the
 *  league (`exclude`), a spread of roles, and a spread of quality from journeymen
 *  to the occasional gem. */
export function freeAgents(seed: number, exclude: Set<string>, count = 16): Player[] {
  const rng = new Rng(seed >>> 0);
  const pool = genHandles(rng, count, exclude);   // unique handles, disjoint from the league
  const out: Player[] = [];
  for (let i = 0; i < count; i++) {
    const role = ROLE_SPREAD[i % ROLE_SPREAD.length];
    const strength = Math.max(0.2, Math.min(0.92, rng.range(0.28, 0.78) + (rng.chance(0.15) ? 0.2 : 0)));  // a few gems
    out.push(makePlayer(rng, role, pool[i], 'fa', strength));
  }
  return out;
}
