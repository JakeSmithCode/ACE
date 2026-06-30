// The World Cup, server-side: assemble national teams by nationality, DRAW them into a group
// stage, and resolve the WHOLE tournament with the real engine — every group game, every
// knockout tie, the third-place playoff, and the final are full-simmed, so results are the
// engine's verdict, an elected manager's authored plan drives their nation's entire run, and
// EVERY game is watchable (its snapshot is cached by id; the client re-sims to watch). A
// Golden Boot is tallied from the simmed timelines. Pure structure (@ace/world) + engine
// resolution here; deterministic from the world + season, cached per season.
import { nationalSquads, worldCupDraw, rankGroup, knockoutSeeding, buildMatchInput, fixtureMap, fixtureSeed, overall, soloRank, personOf, nationPools, pickFive, fiveStrength, type WorldState, type NationSquad, type GroupRow } from '@ace/world';
import { DEFAULT_TACTICS } from '@ace/shared';
import { simulateMatch } from '@ace/engine';
import type { Navmesh } from '@ace/maps';
import type { MatchInput, MapId, Tactics, Team, Player } from '@ace/shared';

const side = (s: NationSquad) => ({ code: s.code, country: s.country, flag: s.flag });
/** A player's highest-mastery agent (the engine's default pick; name tiebreak). */
const topAgentOf = (p: { agents: { agent: string; level: number }[] }) =>
  [...p.agents].sort((a, b) => b.level - a.level || (a.agent < b.agent ? -1 : 1))[0]?.agent ?? 'Jett';

interface WCSide { code: string; country: string; flag: string }
interface WCGame { id: string; a: WCSide; b: WCSide; score: [number, number]; map: MapId }
interface WCKO extends WCGame { round: number; winner: WCSide }

export interface WorldCupView {
  season: number;
  squads: {
    code: string; country: string; flag: string; strength: number; pool: number; manager: string | null; custom: boolean;
    five: { handle: string; name: string; role: string; overall: number; igl: boolean; agent: string; solo: string; soloTier: string }[];
  }[];
  groups: { name: string; rows: { code: string; country: string; flag: string; w: number; l: number; rd: number; pts: number; through: boolean }[]; games: WCGame[] }[];
  bracket: { field: WCSide[]; rounds: WCKO[][]; champion: WCSide };
  third: WCKO | null;                                                          // bronze game (winner = 3rd)
  boot: { handle: string; name: string; code: string; flag: string; kills: number; games: number } | null;   // Golden Boot
  final: { a: WCSide; b: WCSide; map: MapId; score: [number, number]; id: string };
}

/** An elected manager's authored plan for a nation — tactics, the chosen five (lineup), the
 *  comp, and a display name (injected by the server's election layer). */
export interface WorldCupHooks {
  tacticsOf?: (code: string) => Tactics | undefined;
  managerOf?: (code: string) => string | null;
  lineupOf?: (code: string) => string[] | undefined;
  compOf?: (code: string) => Record<string, string> | undefined;
}

export function buildWorldCupView(w: WorldState, navOf: (m: MapId) => Navmesh, hooks: WorldCupHooks = {}): { view: WorldCupView; games: Map<string, MatchInput> } {
  const seed = (w.seed ^ (w.season * 0x9e3779b1)) >>> 0;
  const squads = nationalSquads(w);
  const draw = worldCupDraw(squads, seed);
  const pools = nationPools(w);
  const games = new Map<string, MatchInput>();   // game id → snapshot (re-simmed to watch)
  const scorers = new Map<string, { handle: string; name: string; code: string; flag: string; kills: number; games: number }>();

  // a nation's fielded five (manager's lineup if valid, else best) — stable across the run
  const fieldCache = new Map<string, { five: Player[]; custom: boolean }>();
  const fieldedOf = (s: NationSquad) => {
    let f = fieldCache.get(s.code);
    if (!f) { const ids = hooks.lineupOf?.(s.code); const picked = ids ? pickFive(pools.get(s.code) ?? [], ids) : null; f = picked ? { five: picked, custom: true } : { five: s.five, custom: false }; fieldCache.set(s.code, f); }
    return f;
  };
  const teamOf = (s: NationSquad, five: Player[]): Team => ({ id: `NT-${s.code}`, tag: s.code, name: s.country, players: five });
  const register = (s: NationSquad, five: Player[]) => {
    for (const p of five) { let r = scorers.get(p.handle); if (!r) { r = { handle: p.handle, name: personOf(p.id).name, code: s.code, flag: s.flag, kills: 0, games: 0 }; scorers.set(p.handle, r); } r.games++; }
  };

  // resolve one game with the engine, store its snapshot + tally goals → the result
  const simGame = (a: NationSquad, b: NationSquad, gseed: number, id: string): { score: [number, number]; winner: NationSquad; map: MapId } => {
    const map = fixtureMap(gseed);
    const fa = fieldedOf(a), fb = fieldedOf(b);
    const input = buildMatchInput({
      seed: gseed, map, patch: w.patch,
      home: teamOf(a, fa.five), away: teamOf(b, fb.five),
      tactics: [hooks.tacticsOf?.(a.code) ?? DEFAULT_TACTICS, hooks.tacticsOf?.(b.code) ?? DEFAULT_TACTICS],
      comp: [hooks.compOf?.(a.code) ?? {}, hooks.compOf?.(b.code) ?? {}],
    });
    const tl = simulateMatch(input, navOf(map), 0);
    games.set(id, input);
    register(a, fa.five); register(b, fb.five);
    for (const rnd of tl.rounds) for (const e of rnd.events) if (e.kind === 'kill') { const r = scorers.get(e.killer); if (r) r.kills++; }
    const score = tl.finalScore;
    return { score, winner: score[0] >= score[1] ? a : b, map };
  };

  // GROUP STAGE — each group's round-robin, ranked, top two advance
  const groupsView: WorldCupView['groups'] = [];
  const winners: NationSquad[] = [], runners: NationSquad[] = [];
  for (const g of draw.groups) {
    const rows: GroupRow[] = g.teams.map(squad => ({ squad, w: 0, l: 0, rf: 0, ra: 0, pts: 0 }));
    const rowOf = (s: NationSquad) => rows.find(r => r.squad === s)!;
    const gGames: WCGame[] = [];
    g.fixtures.forEach((fx, i) => {
      const id = `g:${g.name}:${i}`;
      const r = simGame(fx.a, fx.b, fx.seed, id);
      const [sa, sb] = r.score, ra = rowOf(fx.a), rb = rowOf(fx.b);
      ra.rf += sa; ra.ra += sb; rb.rf += sb; rb.ra += sa;
      if (r.winner === fx.a) { ra.w++; ra.pts += 3; rb.l++; } else { rb.w++; rb.pts += 3; ra.l++; }
      gGames.push({ id, a: side(fx.a), b: side(fx.b), score: r.score, map: r.map });
    });
    const ranked = rankGroup(rows);
    winners.push(ranked[0].squad); runners.push(ranked[1].squad);
    groupsView.push({ name: g.name, rows: ranked.map((r, i) => ({ ...side(r.squad), w: r.w, l: r.l, rd: r.rf - r.ra, pts: r.pts, through: i < 2 })), games: gGames });
  }

  // KNOCKOUT — cross-bracketed from the qualifiers; full-simmed round by round
  const start = draw.groups.length ? knockoutSeeding(winners, runners) : draw.bracketSeeds;
  const totalRounds = Math.round(Math.log2(Math.max(2, start.length)));
  const koRounds: WCKO[][] = [];
  let alive = start, round = 0;
  const sfLosers: NationSquad[] = [];
  while (alive.length > 1) {
    const roundGames: WCKO[] = [], next: NationSquad[] = [];
    for (let i = 0; i < alive.length; i += 2) {
      const a = alive[i], b = alive[i + 1], id = `k:${round}:${i}`, gseed = fixtureSeed(seed, round, i);
      const r = simGame(a, b, gseed, id);
      roundGames.push({ id, round, a: side(a), b: side(b), winner: side(r.winner), score: r.score, map: r.map });
      if (round === totalRounds - 2) sfLosers.push(r.winner === a ? b : a);   // semifinal losers
      next.push(r.winner);
    }
    koRounds.push(roundGames);
    alive = next; round++;
  }
  const champion = alive[0];
  const finalGame = koRounds[koRounds.length - 1][0];

  // THIRD-PLACE PLAYOFF — the two semifinal losers play for bronze
  let third: WCKO | null = null;
  if (sfLosers.length === 2) {
    const r = simGame(sfLosers[0], sfLosers[1], fixtureSeed(seed, 900, 0), 'k:3p');
    third = { id: 'k:3p', round: -1, a: side(sfLosers[0]), b: side(sfLosers[1]), winner: side(r.winner), score: r.score, map: r.map };
  }

  // GOLDEN BOOT — the tournament's top fragger across every simmed game
  const boot = [...scorers.values()].filter(s => s.kills > 0).sort((a, b) => b.kills - a.kills || a.handle.localeCompare(b.handle))[0] ?? null;

  const view: WorldCupView = {
    season: w.season,
    squads: draw.field.map(s => {
      const { five, custom } = fieldedOf(s), comp = hooks.compOf?.(s.code);
      return {
        code: s.code, country: s.country, flag: s.flag, strength: Math.round(fiveStrength(five)), pool: s.pool,
        manager: hooks.managerOf?.(s.code) ?? null, custom,
        five: five.map(p => { const sr = soloRank(Math.round(overall(p))); return { handle: p.handle, name: personOf(p.id).name, role: p.role, overall: Math.round(overall(p)), igl: !!p.igl, agent: comp?.[p.id] ?? topAgentOf(p), solo: sr.label, soloTier: sr.tier }; }),
      };
    }),
    groups: groupsView,
    bracket: { field: draw.field.map(side), rounds: koRounds, champion: side(champion) },
    third, boot,
    final: { a: finalGame.a, b: finalGame.b, map: finalGame.map, score: finalGame.score, id: finalGame.id },
  };
  return { view, games };
}
