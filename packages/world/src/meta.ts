// The living meta (DESIGN §7) — each off-season a patch buffs a few agents and
// nerfs a few, with tiers mean-reverting toward 1.0. Deterministic. A buffed
// agent's specialists gain transfer value and play a touch better; the sharp
// owner reads the patch and trades on it.
import { Rng } from '@ace/engine';
import type { PatchState } from '@ace/shared';

export interface MetaChange { agent: string; from: number; to: number; }

/** A full-coverage patch (every agent has a tier), starting from a base patch. */
export function fullPatch(base: PatchState, allAgents: string[]): PatchState {
  const agentTier: Record<string, number> = {};
  for (const a of allAgents) agentTier[a] = base.agentTier[a] ?? 1;
  return { version: base.version, agentTier };
}

/** Roll a new patch: ~3 buffs, ~3 nerfs, the rest drift toward 1.0. Returns the
 *  new patch and the notable changes (for the patch-notes feed). */
export function patchMeta(prev: PatchState, rng: Rng): { patch: PatchState; changes: MetaChange[] } {
  const agents = Object.keys(prev.agentTier);
  const tier: Record<string, number> = { ...prev.agentTier };
  const changes: MetaChange[] = [];
  const shuffled = [...agents];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = rng.int(0, i); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const touched = shuffled.slice(0, 6);
  touched.forEach((a, k) => {
    const cur = tier[a] ?? 1;
    const shock = (k < 3 ? 1 : -1) * rng.range(0.07, 0.16);
    const to = Math.max(0.82, Math.min(1.18, +(cur * 0.55 + 0.45 + shock).toFixed(2)));   // mean-revert + shock
    if (Math.abs(to - cur) >= 0.03) changes.push({ agent: a, from: +cur.toFixed(2), to });
    tier[a] = to;
  });
  for (const a of agents) if (!touched.includes(a)) tier[a] = +((tier[a] ?? 1) * 0.85 + 0.15).toFixed(2);  // gentle revert
  return { patch: { version: prev.version, agentTier: tier }, changes };
}
