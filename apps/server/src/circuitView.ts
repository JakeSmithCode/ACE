// The international circuit, server-side (DESIGN §9): generate regional shards, run a
// season in each, qualify their best into a single-elim Masters bracket, and crown a
// global champion. The earlier rounds are quick-resolved (deterministic strength), and
// the FINAL is full-simmed with the real engine so it's watchable — the champion is
// the engine's verdict, and the snapshot ships so the client re-sims it in the viewer.
// Pure + deterministic from one seed; cached per seed (it's a few shard-seasons of work).
import { createCircuit, simulateSeason, internationalEvent, awardInternational, internationalTransfers, divisionTable, buildMatchInput, clubTeam, fixtureMap, DEFAULT_INTL_PRIZE, type WorldState, type IntlEntry, type CrossMove } from '@ace/world';
import { simulateMatch } from '@ace/engine';
import type { Navmesh } from '@ace/maps';
import type { MatchInput, MapId } from '@ace/shared';

const REGIONS = ['AMER', 'EMEA', 'PACIFIC', 'CHINA'];
const label = (e: IntlEntry) => ({ region: e.region, tag: e.tag });

export interface CircuitView {
  seed: number;
  regions: { region: string; champion: string; top: string[] }[];
  bracket: {
    field: { region: string; tag: string }[];
    rounds: { round: number; a: { region: string; tag: string }; b: { region: string; tag: string }; winner: { region: string; tag: string } }[][];
    champion: { region: string; tag: string; name: string };
  };
  final: { a: { region: string; tag: string }; b: { region: string; tag: string }; map: MapId; score: [number, number]; seed: number; snapshot: MatchInput; prize: number };
  transfers: CrossMove[];   // the international transfer window — talent flows cross-region to the qualifiers' winnings
}

export function buildCircuitView(seed: number, navOf: (m: MapId) => Navmesh): CircuitView {
  const worlds = createCircuit(seed, { regions: REGIONS, tiers: 3, size: 6, promo: 1 }).map(simulateSeason);
  const wOf = (region: string): WorldState => worlds.find(w => w.region === region)!;
  const ev = internationalEvent(worlds, { seed, slots: 2 });
  // the international transfer window: prize money funds cross-region raids by the qualifiers
  const paid = awardInternational(worlds, ev);
  const { moves } = internationalTransfers(paid, ev.field, { patch: worlds[0].patch, max: 6, minUpgrade: 2 });

  // group the bracket matches into rounds for display
  const byRound = new Map<number, CircuitView['bracket']['rounds'][number]>();
  for (const m of ev.matches) {
    const row = byRound.get(m.round) ?? [];
    row.push({ round: m.round, a: label(m.a), b: label(m.b), winner: label(m.winner) });
    byRound.set(m.round, row);
  }
  const rounds = [...byRound.keys()].sort((x, y) => x - y).map(r => byRound.get(r)!);

  // FULL-SIM the final (the last match's two contestants) → the engine crowns the champ
  const last = ev.matches[ev.matches.length - 1];
  const homeC = wOf(last.a.region).clubs[last.a.club], awayC = wOf(last.b.region).clubs[last.b.club];
  const map = fixtureMap(last.seed);
  const snapshot = buildMatchInput({
    seed: last.seed, map, patch: wOf(last.a.region).patch,
    home: clubTeam(homeC), away: clubTeam(awayC),
    tactics: [homeC.tactics, awayC.tactics], comp: [homeC.comp, awayC.comp],
  });
  const score = simulateMatch(snapshot, navOf(map), 0).finalScore;
  const championEntry = score[0] >= score[1] ? last.a : last.b;
  const championClub = wOf(championEntry.region).clubs[championEntry.club];

  return {
    seed,
    regions: worlds.map(w => {
      const t = divisionTable(w, 0, 0);
      return { region: w.region, champion: w.clubs[t[0].club].tag, top: t.slice(0, 4).map(s => w.clubs[s.club].tag) };
    }),
    bracket: { field: ev.field.map(label), rounds, champion: { region: championEntry.region, tag: championEntry.tag, name: championClub.name } },
    final: { a: label(last.a), b: label(last.b), map, score, seed: last.seed, snapshot, prize: DEFAULT_INTL_PRIZE.champion },
    transfers: moves,
  };
}
