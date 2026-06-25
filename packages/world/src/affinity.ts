// Map affinity — each club is a little stronger on some maps and weaker on
// others (their comfort pool), so map veto in the playoffs is a real strategic
// battle, not a coin-flip. Pure: a deterministic hash of (club id, map), no
// stored state, so it never perturbs the world.
import type { MapId } from '@ace/shared';

/** A club's comfort modifier on a map, ~[-3, +3) overall points. Deterministic. */
export function mapAffinity(teamId: string, map: MapId): number {
  let h = 2166136261 >>> 0;
  const s = `${teamId}@${map}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return (h % 1000) / 1000 * 6 - 3;
}

/** A club's pool ranked best-comfort first (for UI + AI veto). */
export const rankedMaps = (teamId: string, pool: MapId[]): MapId[] =>
  [...pool].sort((a, b) => mapAffinity(teamId, b) - mapAffinity(teamId, a));
