// The World Cup — national teams assembled from the league's talent by NATIONALITY
// (DESIGN §9, building on the identity layer). Every player has a real country; this
// gathers the best of each nation into a national five and runs a single-elim bracket
// for the world title — VALORANT-meets-international-football. Pure + deterministic:
// a function of the world state + a seed, the engine never sees it. The server full-sims
// the final (watchable) exactly like the international circuit.
import type { Player, Team } from '@ace/shared';
import { Rng } from '@ace/engine';
import { overall } from './develop.js';
import { personOf } from './identity.js';
import { fixtureSeed } from './season.js';
import type { WorldState } from './state.js';

const ROLE_NEED = { duelist: 2, initiator: 1, controller: 1, sentinel: 1 } as const;

export interface NationSquad {
  country: string; flag: string; code: string;
  five: Player[];        // 2 duelist + 1 init/ctrl/sentinel, IGL = the sentinel
  strength: number;      // mean overall of the five — seeds the bracket
  pool: number;          // how many players of this nationality exist (depth)
}

/** Assemble each nation's best VALID five from every player of that nationality across
 *  the whole world. A nation that can't field a full comp (a role with nobody) doesn't
 *  enter — like a country that can't qualify. Sorted strongest-first, ties by code so
 *  it's deterministic. */
export function nationalSquads(w: WorldState): NationSquad[] {
  const byNation = new Map<string, Player[]>();
  for (const c of w.clubs) for (const p of c.roster) {
    const country = personOf(p.id).nation.country;
    let arr = byNation.get(country);
    if (!arr) { arr = []; byNation.set(country, arr); }
    arr.push(p);
  }
  const squads: NationSquad[] = [];
  for (const players of byNation.values()) {
    const nat = personOf(players[0].id).nation;
    const five: Player[] = [];
    let ok = true;
    (['duelist', 'initiator', 'controller', 'sentinel'] as const).forEach(role => {
      const inRole = players.filter(p => p.role === role).sort((a, b) => overall(b) - overall(a) || a.id.localeCompare(b.id));
      if (inRole.length < ROLE_NEED[role]) ok = false;
      five.push(...inRole.slice(0, ROLE_NEED[role]));
    });
    if (!ok || five.length !== 5) continue;
    const fielded = five.map(p => ({ ...p, igl: p.role === 'sentinel' }));
    const strength = fielded.reduce((s, p) => s + overall(p), 0) / 5;
    squads.push({ country: nat.country, flag: nat.flag, code: nat.code, five: fielded, strength, pool: players.length });
  }
  return squads.sort((a, b) => b.strength - a.strength || a.code.localeCompare(b.code));
}

/** A national squad as an engine team (its five, tagged by country code). */
export const nationalTeam = (s: NationSquad): Team => ({ id: `NT-${s.code}`, tag: s.code, name: s.country, players: s.five });

export interface WorldCupMatch { round: number; a: NationSquad; b: NationSquad; winner: NationSquad; seed: number }
export interface WorldCupResult {
  seed: number;
  field: NationSquad[];          // the qualified nations, top seed first
  matches: WorldCupMatch[];      // every game, round by round
  champion: NationSquad;
  placement: NationSquad[];      // finish order (champion first)
}

/** Classic single-elim seeding (1 plays n, 2 plays n-1, …) so the top seeds spread. */
function bracketOrder(n: number): number[] {
  let order = [1, 2];
  while (order.length < n) {
    const len = order.length * 2;
    const next: number[] = [];
    for (const s of order) { next.push(s); next.push(len + 1 - s); }
    order = next;
  }
  return order;
}

/** A single bracket game by strength (the same logistic the dormant divisions use). */
function play(a: NationSquad, b: NationSquad, seed: number): NationSquad {
  return new Rng(seed >>> 0).next() < 1 / (1 + Math.exp(-(a.strength - b.strength) * 6)) ? a : b;
}

/** Run the World Cup: the top `slots` nations by squad strength qualify, are seeded,
 *  and play a single-elim bracket (field trimmed to a power of two for a clean draw).
 *  Every game seed is a stable hash, so it's reproducible. The server overrides the
 *  FINAL with a real engine sim so the champion is the engine's verdict (watchable). */
export function worldCup(squads: NationSquad[], opts: { seed: number; slots?: number }): WorldCupResult {
  const slots = opts.slots ?? 8;
  const ranked = squads.slice(0, slots);
  const N = 1 << Math.floor(Math.log2(Math.max(2, ranked.length)));
  const field = ranked.slice(0, N);
  const seeded = bracketOrder(N).map(s => field[s - 1]);

  const matches: WorldCupMatch[] = [];
  const eliminatedRound = new Map<NationSquad, number>();
  let alive = seeded, round = 0;
  while (alive.length > 1) {
    const next: NationSquad[] = [];
    for (let i = 0; i < alive.length; i += 2) {
      const a = alive[i], b = alive[i + 1];
      const seed = fixtureSeed(opts.seed, round, i);
      const winner = play(a, b, seed);
      matches.push({ round, a, b, winner, seed });
      eliminatedRound.set(winner === a ? b : a, round);
      next.push(winner);
    }
    alive = next; round++;
  }
  const champion = alive[0];
  eliminatedRound.set(champion, round);
  const placement = [...field].sort((a, b) => (eliminatedRound.get(b) ?? -1) - (eliminatedRound.get(a) ?? -1) || b.strength - a.strength);
  return { seed: opts.seed, field, matches, champion, placement };
}
