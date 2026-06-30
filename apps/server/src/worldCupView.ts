// The World Cup, server-side: assemble national teams from the live world's talent by
// nationality, run a single-elim bracket for the world title, and FULL-SIM the final with
// the real engine so it's watchable (the champion is the engine's verdict). Mirrors the
// circuit view's shape; pure + deterministic from the world + a seed, cached per season.
import { nationalSquads, worldCup, buildMatchInput, fixtureMap, overall, soloRank, personOf, nationPools, pickFive, fiveStrength, type WorldState, type NationSquad } from '@ace/world';
import { DEFAULT_TACTICS } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import type { Navmesh } from '@ace/maps';
import type { MatchInput, MapId, Tactics, Team, Player } from '@ace/shared';

const side = (s: NationSquad) => ({ code: s.code, country: s.country, flag: s.flag });
/** A player's highest-mastery agent (the engine's default pick; name tiebreak). */
const topAgentOf = (p: { agents: { agent: string; level: number }[] }) =>
  [...p.agents].sort((a, b) => b.level - a.level || (a.agent < b.agent ? -1 : 1))[0]?.agent ?? 'Jett';

export interface WorldCupView {
  season: number;
  squads: {
    code: string; country: string; flag: string; strength: number; pool: number; manager: string | null; custom: boolean;
    five: { handle: string; name: string; role: string; overall: number; igl: boolean; agent: string; solo: string; soloTier: string }[];
  }[];
  groups: { name: string; rows: { code: string; country: string; flag: string; w: number; l: number; rd: number; pts: number; through: boolean }[] }[];
  bracket: {
    field: { code: string; country: string; flag: string }[];
    rounds: { round: number; a: { code: string; country: string; flag: string }; b: { code: string; country: string; flag: string }; winner: { code: string; country: string; flag: string } }[][];
    champion: { code: string; country: string; flag: string };
  };
  final: { a: { code: string; country: string; flag: string }; b: { code: string; country: string; flag: string }; map: MapId; score: [number, number]; seed: number; snapshot: MatchInput };
}

/** An elected manager's authored plan for a nation — tactics, the chosen five (lineup),
 *  and a display name (injected by the server's election layer; defaults make the
 *  no-manager World Cup byte-identical). */
export interface WorldCupHooks {
  tacticsOf?: (code: string) => Tactics | undefined;
  managerOf?: (code: string) => string | null;
  lineupOf?: (code: string) => string[] | undefined;
  compOf?: (code: string) => Record<string, string> | undefined;
}

export function buildWorldCupView(w: WorldState, navOf: (m: MapId) => Navmesh, hooks: WorldCupHooks = {}): WorldCupView {
  const seed = (w.seed ^ (w.season * 0x9e3779b1)) >>> 0;
  const squads = nationalSquads(w);
  const ev = worldCup(squads, { seed });
  const pools = nationPools(w);
  // the group stage: each group's table (top 2 `through`)
  const groups = ev.groups.map(gr => ({
    name: gr.name,
    rows: gr.rows.map((r, i) => ({ code: r.squad.code, country: r.squad.country, flag: r.squad.flag, w: r.w, l: r.l, rd: r.rf - r.ra, pts: r.pts, through: i < 2 })),
  }));

  // the five a nation actually fields: the elected manager's chosen lineup if it's a valid
  // pick from the pool, else the default best five (so seeding stays on the talent ceiling
  // but the manager selects the XI within it — a real "second team" to run).
  const fieldedOf = (s: NationSquad): { five: Player[]; custom: boolean } => {
    const ids = hooks.lineupOf?.(s.code);
    const picked = ids ? pickFive(pools.get(s.code) ?? [], ids) : null;
    return picked ? { five: picked, custom: true } : { five: s.five, custom: false };
  };
  const teamOf = (s: NationSquad, five: Player[]): Team => ({ id: `NT-${s.code}`, tag: s.code, name: s.country, players: five });

  // group bracket matches into display rounds
  const byRound = new Map<number, WorldCupView['bracket']['rounds'][number]>();
  for (const m of ev.matches) {
    const row = byRound.get(m.round) ?? [];
    row.push({ round: m.round, a: side(m.a), b: side(m.b), winner: side(m.winner) });
    byRound.set(m.round, row);
  }
  const rounds = [...byRound.keys()].sort((x, y) => x - y).map(r => byRound.get(r)!);

  // FULL-SIM the final → the engine crowns the champion (national teams run default
  // tactics + their players' top agents, so it's a pure talent showcase)
  const last = ev.matches[ev.matches.length - 1];
  const map = fixtureMap(last.seed);
  // the finalists' ELECTED managers drive the engine-simmed final — author the read/tempo
  // and your nation plays your plan (no manager → the neutral default).
  const tacA = hooks.tacticsOf?.(last.a.code) ?? DEFAULT_TACTICS;
  const tacB = hooks.tacticsOf?.(last.b.code) ?? DEFAULT_TACTICS;
  const fA = fieldedOf(last.a), fB = fieldedOf(last.b);
  const snapshot = buildMatchInput({
    seed: last.seed, map, patch: w.patch,
    home: teamOf(last.a, fA.five), away: teamOf(last.b, fB.five),
    tactics: [tacA, tacB], comp: [hooks.compOf?.(last.a.code) ?? {}, hooks.compOf?.(last.b.code) ?? {}],
  });
  const score = simulateMatch(snapshot, navOf(map), 0).finalScore;
  const champ = score[0] >= score[1] ? last.a : last.b;

  return {
    season: w.season,
    squads: ev.field.map(s => {
      const { five, custom } = fieldedOf(s);
      const comp = hooks.compOf?.(s.code);
      return {
        code: s.code, country: s.country, flag: s.flag, strength: Math.round(fiveStrength(five)), pool: s.pool,
        manager: hooks.managerOf?.(s.code) ?? null, custom,
        five: five.map(p => {
          const sr = soloRank(Math.round(overall(p)));
          return { handle: p.handle, name: personOf(p.id).name, role: p.role, overall: Math.round(overall(p)), igl: !!p.igl, agent: comp?.[p.id] ?? topAgentOf(p), solo: sr.label, soloTier: sr.tier };
        }),
      };
    }),
    groups,
    bracket: { field: ev.field.map(side), rounds, champion: side(champ) },
    final: { a: side(last.a), b: side(last.b), map, score, seed: last.seed, snapshot },
  };
}
