// The transfer market — what gives money a purpose and a developed player a
// price. Deterministic: the free-agent pool is a function of (seed, season).
import { Rng } from '@ace/engine';
import type { Player, Role, PatchState } from '@ace/shared';
import { makePlayer } from './clubs.js';
import { HANDLES } from './names.js';
import { overall } from './develop.js';
import { scoutedPotential } from './scouting.js';

/** A player's transfer value: ability is the floor, *scouted* potential (the
 *  market's fogged read, not the true ceiling) is the premium, and age past peak
 *  is a discount — so a young high-ceiling read is the dearest thing on the
 *  board and an ageing star is cheap. With a `patch`, a player who mains a
 *  buffed agent is worth more (specialists track the meta — DESIGN §7). */
export function playerValue(p: Player, patch?: PatchState): number {
  const ovr = overall(p), pot = scoutedPotential(p, false);   // market consensus, fogged
  const upside = Math.max(0, pot - ovr);
  const youth = Math.max(0, (28 - p.age) / 12);          // prospects carry the premium
  const base = Math.pow(ovr, 2.5) * 0.32;                // ability floor
  const premium = upside * youth * 2000;                 // potential premium
  const ageTax = p.age >= 27 ? Math.min(0.5, (p.age - 26) * 0.09) : 0;
  let v = (base + premium) * (1 - ageTax);
  if (patch) {
    const main = [...p.agents].sort((a, b) => b.level - a.level)[0]?.agent;
    const tier = main ? (patch.agentTier[main] ?? 1) : 1;
    v *= 0.55 + tier * 0.45;                             // tier ~0.85..1.15 → mult ~0.93..1.07
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
  const pool = HANDLES.filter(h => !exclude.has(h));
  for (let i = pool.length - 1; i > 0; i--) { const j = rng.int(0, i); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const out: Player[] = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const role = ROLE_SPREAD[i % ROLE_SPREAD.length];
    const strength = Math.max(0.2, Math.min(0.92, rng.range(0.28, 0.78) + (rng.chance(0.15) ? 0.2 : 0)));  // a few gems
    out.push(makePlayer(rng, role, pool.pop()!, 'fa', strength));
  }
  return out;
}
