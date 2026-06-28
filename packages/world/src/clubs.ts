// Deterministic club & league generation. Every club is a pure function of the
// world seed, so a season is reproducible and (later) the server worker rebuilds
// the same world the client previewed.
import type { Team, Player, Role, Attributes, Tactics } from '@ace/shared';
import { Rng } from '@ace/engine';
import { CLUB_IDENTITIES, HANDLES, HANDLE_PRE, HANDLE_SUF, CLUB_ADJ, CLUB_NOUN } from './names.js';
import { aiTactics } from './ai.js';

const shuffle = <T,>(a: T[], rng: Rng): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = rng.int(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** A deterministic pool of `count` unique player handles, disjoint from `exclude`.
 *  The curated handles seed it; overflow appends a number (NOVA → NOVA2 → NOVA3),
 *  so the pool scales to a deep pyramid (and a server world) without collisions. */
export function genHandles(rng: Rng, count: number, exclude: Set<string> = new Set()): string[] {
  const out: string[] = [], used = new Set(exclude);
  const add = (h: string) => { if (out.length < count && !used.has(h)) { used.add(h); out.push(h); } };
  // 1. curated handles, 2. coined syllable combos, 3. numeric fallback — each unique
  for (const r of shuffle([...HANDLES], rng)) { if (out.length >= count) break; add(r); }
  const pre = shuffle([...HANDLE_PRE], rng), suf = shuffle([...HANDLE_SUF], rng);
  for (let i = 0; out.length < count && i < pre.length * suf.length; i++)
    add(pre[i % pre.length] + suf[Math.floor(i / pre.length) % suf.length]);
  for (let pass = 2; out.length < count && pass < 200; pass++)
    for (const r of HANDLES) { if (out.length >= count) break; add(r + pass); }
  return shuffle(out, rng);   // mix so any slice (a club's five) is varied
}

/** A deterministic pool of `count` unique club identities (name + 3-letter tag).
 *  Curated identities first, then procedural adjective+noun combos with a derived,
 *  de-duplicated tag — so the world can be as deep (or as large) as it needs. */
export function genClubIdentities(rng: Rng, count: number): { name: string; tag: string }[] {
  const out: { name: string; tag: string }[] = [];
  const usedNames = new Set<string>(), usedTags = new Set<string>();
  for (const c of shuffle([...CLUB_IDENTITIES], rng)) {
    if (out.length >= count) break;
    out.push(c); usedNames.add(c.name); usedTags.add(c.tag);
  }
  // every adjective×noun combo, shuffled, so consecutive clubs (a whole tier)
  // don't all share a noun — variety across the board
  const combos: [string, string][] = [];
  for (const a of CLUB_ADJ) for (const n of CLUB_NOUN) combos.push([a, n]);
  shuffle(combos, rng);
  for (let i = 0; out.length < count && i < combos.length; i++) {
    const [a, n] = combos[i];
    const name = `${a} ${n}`;
    if (usedNames.has(name)) continue;
    const cands = [a[0] + n.slice(0, 2), n.slice(0, 3), a.slice(0, 2) + n[0], a[0] + n[0] + n[n.length - 1]].map(s => s.toUpperCase());
    let tag = cands.find(t => !usedTags.has(t));
    for (let x = 0; !tag && x < 26; x++) { const t = (a[0] + n[0] + String.fromCharCode(65 + x)).toUpperCase(); if (!usedTags.has(t)) tag = t; }
    if (!tag) continue;
    usedNames.add(name); usedTags.add(tag); out.push({ name, tag });
  }
  return out;
}

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

/** A club's persistent age CHARACTER (−3..+3) — a deterministic hash of its id, so
 *  some orgs always run a veteran core (cycling prime → aging → rebuild) and some a
 *  young one (perpetually rising). It biases roster ages at generation AND the ages
 *  of players the club reloads, so the league's age mix stays spread season over
 *  season — keeping a healthy diversity of lifecycle stages (no synchronized wave). */
export function clubAgeChar(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 7) - 3;
}

/** Generate one player — role-shaped attributes, an age, age-scaled potential,
 *  and a mastered agent pool. Used for league squads and free agents alike, so
 *  a signing is the same kind of object as a homegrown player. `idPrefix` namespaces
 *  the id (a club tag, or 'fa' for a free agent). `ageOverride` forces the age (the
 *  Academy uses it for teenage prospects); when set, the role's age draw is skipped. */
export function makePlayer(rng: Rng, role: Role, handle: string, idPrefix: string, strength: number, ageOverride?: number, ageShift = 0): Player {
  const base = 42 + strength * 46;                 // ~42..88 talent center
  const shape = ROLE_SHAPE[role];
  const roll = (k: keyof Attributes) => clamp(base + (shape[k] ?? 0) + rng.range(-6, 6));
  const attr: Attributes = {
    aim: roll('aim'), movement: roll('movement'), gameSense: roll('gameSense'),
    utility: roll('utility'), clutch: roll('clutch'), entry: roll('entry'),
  };
  // duelists skew young, anchors skew veteran — flavour, and the hook for aging.
  // `ageShift` is the club's age character (veteran vs young core); 0 is unchanged.
  const age = ageOverride ?? Math.max(17, Math.min(33, (role === 'duelist' ? rng.int(18, 24) : role === 'sentinel' ? rng.int(22, 30) : rng.int(20, 27)) + ageShift));
  // potential = current + age-scaled headroom × a per-player gift; the young
  // carry real upside, a veteran is ~already there. (Hidden — Phase-3 scouting.)
  const youth = Math.max(0, (24 - age) / 8);       // 1 at ≤16 .. 0 at ≥24
  const gift = rng.range(0.6, 1.5);                // some players have more upside than others
  const head = (k: keyof Attributes) => clamp(attr[k] + Math.round(youth * gift * (9 + rng.range(0, 14))), attr[k], 99);
  const potential: Attributes = {
    aim: head('aim'), movement: head('movement'), gameSense: head('gameSense'),
    utility: head('utility'), clutch: head('clutch'), entry: head('entry'),
  };
  // a role-appropriate main + secondary agent, mastery scaling with talent
  const roster = [...AGENTS[role]];
  const main = roster.splice(rng.int(0, roster.length - 1), 1)[0];
  const second = roster.splice(rng.int(0, roster.length - 1), 1)[0];
  const agents = [
    { agent: main, level: clamp(70 + strength * 22 + rng.range(-4, 6), 50, 99) },
    { agent: second, level: clamp(55 + strength * 18 + rng.range(-6, 6), 40, 90) },
  ];
  // ceiling plasticity: a teen is a wide cloud (boom/bust), a developed player is
  // settled. Reps will drift the ceiling and narrow this to 0 (develop.ts).
  const potVar = Math.max(0, Math.min(1, (23 - age) / 7)) * rng.range(0.7, 1.1);
  // tenure 0 = a brand-new player (a free agent / a fresh signing hasn't gelled);
  // makeClub raises an established league roster to a gelled baseline.
  return { id: `${idPrefix}-${handle.toLowerCase()}`, handle, role, age, attr, potential, potVar, agents, tenure: 0 };
}

/** Build one club. `strength` (0..1) sets the talent floor; role shape + a small
 *  per-attribute roll give each player a believable, distinct profile. Handles
 *  are pulled from `pool` (consumed, so a league never repeats a handle). */
export function makeClub(rng: Rng, identity: { name: string; tag: string }, strength: number, pool: string[]): Team {
  const iglIdx = 4;                                // the sentinel calls (like the sample veterans)
  // a club's age CHARACTER — some orgs field a veteran core (an aging dynasty), some
  // a young project (rising/rebuilding). Derived from the id (not drawn), so the same
  // character governs this club's reloads forever, sustaining lifecycle diversity.
  const ageBias = clubAgeChar(identity.tag.toLowerCase());
  const players: Player[] = COMP.map((role, i) => {
    const handle = pool.pop()!;                    // (non-rng; draw order is identical to inline)
    const p = makePlayer(rng, role, handle, identity.tag.toLowerCase(), strength, undefined, ageBias);
    if (i === iglIdx) p.igl = true;
    p.tenure = 2;                                  // an established roster starts gelled (> the engine's CHEM_CAP)
    return p;
  });
  return { id: identity.tag.toLowerCase(), tag: identity.tag, name: identity.name, players };
}

/** A club's house tactics. Phase 5: the AI now plays to a coherent IDENTITY derived from
 *  its squad (`aiTactics`) instead of random dials — a roster of fraggers plays fast and
 *  aggressive, a cerebral one patient and utility-led — so AI orgs are distinct AND
 *  scoutable. Pure (no rng): an AI club's style is a stable function of its roster + id,
 *  and the engine still just receives a `MatchInput.tactics`, so seed 42 is untouched. */
export function makeTactics(_rng: Rng, team: Team): Tactics {
  return aiTactics(team);
}

export interface Club { team: Team; tactics: Tactics; strength: number }

/** Generate a league of `n` clubs with a believable talent hierarchy (top clubs
 *  stronger, with noise so the table isn't a foregone ladder). Deterministic
 *  from `seed`. `n` should be even for a clean round-robin. */
export function makeLeague(seed: number, n = 8): Club[] {
  const rng = new Rng(seed >>> 0);
  // procedurally generate identities + a handle pool sized to the league, so a
  // world of any depth (two divisions or the full rank ladder) generates cleanly
  const chosen = genClubIdentities(rng, n);
  const pool = genHandles(rng, n * 5 + 8);
  return chosen.map((identity, i) => {
    // strength descends across the field with a little noise — a hierarchy, not a ladder
    const tier = 1 - i / (n - 1);                  // 1.0 (top) .. 0 (bottom)
    const strength = Math.max(0.3, Math.min(0.9, 0.42 + tier * 0.42 + rng.range(-0.06, 0.06)));
    const team = makeClub(rng, identity, strength, pool);
    return { team, tactics: makeTactics(rng, team), strength };
  });
}
