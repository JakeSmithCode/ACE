// Scouting fog (DESIGN §4.1, §5.3) — the manager never sees a player's true
// potential, only a *scouted estimate* with a confidence that's higher for older
// players (their ceiling is closer to realised) and for players you own (you see
// them every day). The estimate is biased by a deterministic per-player noise
// scaled by how little you know — so the market's mispriced gems are the kids
// whose true ceiling sits outside the consensus read. Pure, like everything here.
import type { Player } from '@ace/shared';
import { overall, potentialOverall } from './develop.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Deterministic noise in [-1, 1) from a player id (FNV-1a). */
function noise(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 2000) / 1000 - 1;
}

/** How well the ceiling is known (0..1): older players are clearer, and owning a
 *  player adds confidence (your staff watch them daily). */
export function scoutConfidence(p: Player, owned = false): number {
  const realised = clamp((p.age - 15) / 13, 0, 1);
  return clamp(0.22 + realised * 0.5 + (owned ? 0.26 : 0), 0.15, 0.97);
}

/** The scouted potential overall — the true ceiling fogged by (1 − confidence).
 *  Never reads below current ability (you can always see what a player IS). */
export function scoutedPotential(p: Player, owned = false): number {
  const conf = scoutConfidence(p, owned);
  const band = (1 - conf) * 22;
  return clamp(Math.round(potentialOverall(p) + noise(p.id) * band), overall(p), 99);
}

/** Scouted potential as a 1–5 star rating (what the UI shows instead of truth). */
export const scoutedStars = (p: Player, owned = false): number =>
  Math.max(1, Math.min(5, Math.round((scoutedPotential(p, owned) - 44) / 9)));

/** The scouted ceiling **range** — the gamble made legible. Wide for an
 *  unresolved prospect (real plasticity `potVar` + observation error), tight for
 *  a settled veteran you own. `[lo, hi]` overall — "this kid could be 78 or 94". */
export function scoutedRange(p: Player, owned = false): [number, number] {
  const center = scoutedPotential(p, owned);
  const v = p.potVar ?? 0;
  const band = Math.round(v * 14 + (1 - scoutConfidence(p, owned)) * 7);
  return [clamp(center - band, overall(p), 99), clamp(center + band, overall(p), 99)];
}
