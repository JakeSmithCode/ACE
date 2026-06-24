// Deterministic club & league generation. Every club is a pure function of the
// world seed, so a season is reproducible and (later) the server worker rebuilds
// the same world the client previewed.
import type { Team, Player, Role, Attributes, Tactics } from '@ace/shared';
import { Rng } from '@ace/engine';
import { CLUB_IDENTITIES, HANDLES } from './names.js';

// A standard comp: two duelists, an initiator, a controller, a sentinel.
const COMP: Role[] = ['duelist', 'duelist', 'initiator', 'controller', 'sentinel'];

// Per-role attribute deltas (on top of the club's base). A duelist lives on
// aim/entry; a sentinel on gameSense/clutch; a controller on utility — so a
// club's identity is legible in its stat shape, not just its overall level.
const ROLE_SHAPE: Record<Role, Partial<Attributes>> = {
  duelist:    { aim: 9, movement: 8, entry: 13, utility: -15, gameSense: -4, clutch: -3 },
  initiator:  { utility: 11, gameSense: 8, aim: 3, entry: -2, clutch: -1, movement: 0 },
  controller: { utility: 15, gameSense: 10, aim: -6, entry: -15, movement: -4, clutch: 2 },
  sentinel:   { gameSense: 12, clutch: 13, utility: 6, entry: -17, aim: -6, movement: -5 },
};

/** Agents by role — the comp builder picks from these per player. */
export const ROLE_AGENTS: Record<Role, string[]> = {
  duelist:    ['Jett', 'Raze', 'Neon', 'Yoru', 'Phoenix', 'Reyna'],
  initiator:  ['Sova', 'Fade', 'Breach', 'Skye', 'KAY/O', 'Gekko'],
  controller: ['Omen', 'Brimstone', 'Viper', 'Astra', 'Harbor', 'Clove'],
  sentinel:   ['Killjoy', 'Cypher', 'Chamber', 'Sage', 'Deadlock', 'Vyse'],
};
const AGENTS = ROLE_AGENTS;

const clamp = (v: number, lo = 35, hi = 95) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Build one club. `strength` (0..1) sets the talent floor; role shape + a small
 *  per-attribute roll give each player a believable, distinct profile. Handles
 *  are pulled from `pool` (consumed, so a league never repeats a handle). */
export function makeClub(rng: Rng, identity: { name: string; tag: string }, strength: number, pool: string[]): Team {
  const base = 42 + strength * 46;                 // ~42..88 talent center
  const iglIdx = 4;                                // the sentinel calls (like the sample veterans)
  const players: Player[] = COMP.map((role, i) => {
    const shape = ROLE_SHAPE[role];
    const roll = (k: keyof Attributes) => clamp(base + (shape[k] ?? 0) + rng.range(-6, 6));
    const attr: Attributes = {
      aim: roll('aim'), movement: roll('movement'), gameSense: roll('gameSense'),
      utility: roll('utility'), clutch: roll('clutch'), entry: roll('entry'),
    };
    // duelists skew young, anchors skew veteran — flavour, and the hook for aging
    const age = role === 'duelist' ? rng.int(18, 24) : role === 'sentinel' ? rng.int(22, 30) : rng.int(20, 27);
    // potential = current + age-scaled headroom × a per-player gift; the young
    // carry real upside, a veteran is ~already there. The development tick grows
    // current toward this ceiling. (Hidden from the manager — Phase-3 scouting.)
    const youth = Math.max(0, (24 - age) / 8);     // 1 at ≤16 .. 0 at ≥24
    const gift = rng.range(0.6, 1.5);              // some players have more upside than others
    const head = (k: keyof Attributes) => clamp(attr[k] + Math.round(youth * gift * (9 + rng.range(0, 14))), attr[k], 99);
    const potential: Attributes = {
      aim: head('aim'), movement: head('movement'), gameSense: head('gameSense'),
      utility: head('utility'), clutch: head('clutch'), entry: head('entry'),
    };
    const handle = pool.pop()!;
    // a role-appropriate main + 1–2 secondary agents, mastery scaling with talent
    const roster = [...AGENTS[role]];
    const main = roster.splice(rng.int(0, roster.length - 1), 1)[0];
    const second = roster.splice(rng.int(0, roster.length - 1), 1)[0];
    const agents = [
      { agent: main, level: clamp(70 + strength * 22 + rng.range(-4, 6), 50, 99) },
      { agent: second, level: clamp(55 + strength * 18 + rng.range(-6, 6), 40, 90) },
    ];
    return {
      id: `${identity.tag.toLowerCase()}-${handle.toLowerCase()}`,
      handle, role, igl: i === iglIdx, age, attr, potential, agents,
    };
  });
  return { id: identity.tag.toLowerCase(), tag: identity.tag, name: identity.name, players };
}

/** A club's house tactics — varied around the defaults so AI orgs feel distinct
 *  (one rushes B, one plays slow A defaults), but always sane. */
export function makeTactics(rng: Rng, team: Team): Tactics {
  const entry = [...team.players].sort((a, b) => b.attr.entry - a.attr.entry)[0].id;
  // ~30% of clubs run a dedicated lurker (their second duelist)
  const lurk = rng.chance(0.3) ? team.players.find(p => p.role === 'duelist' && p.id !== entry)?.id : undefined;
  return {
    attack: {
      siteBias: +rng.range(-0.5, 0.5).toFixed(2),
      tempo: +rng.range(0.25, 0.8).toFixed(2),
      entry, lurk,
    },
    defense: {
      read: +rng.range(-0.4, 0.4).toFixed(2),
      aggression: +rng.range(0.2, 0.7).toFixed(2),
    },
  };
}

export interface Club { team: Team; tactics: Tactics; strength: number }

/** Generate a league of `n` clubs with a believable talent hierarchy (top clubs
 *  stronger, with noise so the table isn't a foregone ladder). Deterministic
 *  from `seed`. `n` should be even for a clean round-robin. */
export function makeLeague(seed: number, n = 8): Club[] {
  const rng = new Rng(seed >>> 0);
  // shuffle identities and handles (Fisher–Yates) so each seed yields a fresh world
  const ids = [...CLUB_IDENTITIES];
  const pool = [...HANDLES];
  const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = rng.int(0, i); [a[i], a[j]] = [a[j], a[i]]; } };
  shuffle(ids); shuffle(pool);

  const chosen = ids.slice(0, n);
  return chosen.map((identity, i) => {
    // strength descends across the field with a little noise — a hierarchy, not a ladder
    const tier = 1 - i / (n - 1);                  // 1.0 (top) .. 0 (bottom)
    const strength = Math.max(0.3, Math.min(0.9, 0.42 + tier * 0.42 + rng.range(-0.06, 0.06)));
    const team = makeClub(rng, identity, strength, pool);
    return { team, tactics: makeTactics(rng, team), strength };
  });
}
