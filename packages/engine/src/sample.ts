import type { Team, PatchState, Player, Role, Tactics } from '@ace/shared';

const mk = (
  id: string, handle: string, role: Role, age: number,
  a: number, m: number, g: number, u: number, c: number, e: number,
  agents: string[], igl = false,
): Player => ({
  id, handle, role, igl, age,
  attr: { aim: a, movement: m, gameSense: g, utility: u, clutch: c, entry: e },
  // first agent listed is the player's main (highest mastery); pool drops off after
  agents: agents.map((agent, i) => ({ agent, level: Math.max(45, 90 - i * 15 - (a % 6)) })),
});

// Team 0 — slightly higher ceiling, star entry duelist, veteran IGL sentinel.
export const NOCTURNE: Team = {
  id: 'nct', tag: 'NCT', name: 'Nocturne',
  players: [
    mk('nct-vesper', 'VESPER', 'duelist',    21, 88, 84, 74, 60, 72, 90, ['Jett', 'Raze']),
    mk('nct-wraith', 'WRAITH', 'duelist',    23, 82, 80, 78, 64, 76, 80, ['Raze', 'Neon']),
    mk('nct-karma',  'KARMA',  'initiator',  22, 79, 75, 82, 85, 74, 66, ['Sova', 'Fade']),
    mk('nct-static', 'STATIC', 'controller', 24, 76, 72, 84, 88, 78, 58, ['Omen', 'Brimstone']),
    mk('nct-oracle', 'ORACLE', 'sentinel',   27, 74, 70, 90, 82, 88, 52, ['Killjoy', 'Cypher'], true),
  ],
};

// Team 1 — solid, a touch lower on average; upsets still happen on variance.
export const MERIDIAN: Team = {
  id: 'mrd', tag: 'MRD', name: 'Meridian',
  players: [
    mk('mrd-cinder', 'CINDER', 'duelist',    20, 85, 82, 70, 58, 70, 86, ['Jett', 'Yoru']),
    mk('mrd-volt',   'VOLT',   'initiator',  22, 80, 76, 76, 80, 72, 70, ['Breach', 'Skye']),
    mk('mrd-hex',    'HEX',    'controller', 23, 77, 74, 80, 84, 75, 60, ['Viper', 'Astra']),
    mk('mrd-pulse',  'PULSE',  'sentinel',   25, 78, 72, 82, 80, 80, 56, ['Chamber', 'Killjoy'], true),
    mk('mrd-onyx',   'ONYX',   'duelist',    21, 81, 79, 72, 60, 71, 78, ['Raze', 'Phoenix']),
  ],
};

export const PATCH: PatchState = {
  version: '9.11',
  agentTier: { Jett: 1.05, Raze: 1.02, Sova: 1.0, Omen: 1.04, Killjoy: 1.0, Viper: 1.03 },
};

// Nocturne play fast and aggressive, leaning A; VESPER entries, WRAITH lurks.
export const NCT_TACTICS: Tactics = {
  attack: { siteBias: 0.4, tempo: 0.75, entry: 'nct-vesper', lurk: 'nct-wraith' },
  defense: { read: 0.35, aggression: 0.6 },
};
// Meridian play patient defaults, leaning B; CINDER entries, no lurk (standard 5-stack).
export const MRD_TACTICS: Tactics = {
  attack: { siteBias: -0.3, tempo: 0.3, entry: 'mrd-cinder' },
  defense: { read: -0.15, aggression: 0.25 },
};
