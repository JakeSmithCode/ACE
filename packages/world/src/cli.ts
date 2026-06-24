// Resolve a full generated season and print the table — the proof that the
// world core produces a believable, deterministic league.
//   pnpm season -- --seed 7 --clubs 8
import { loadNavmesh } from '../../maps/src/load.js';
import { PATCH } from '@ace/engine';
import { makeLeague } from './clubs.js';
import { doubleRoundRobin } from './schedule.js';
import { resolveMatchday, standings, type MatchResult } from './season.js';

const arg = (flag: string, def: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const seed = parseInt(arg('--seed', '7'), 10);
const clubCount = parseInt(arg('--clubs', '8'), 10);
const map = 'ascent';

const nav = loadNavmesh(map);
const clubs = makeLeague(seed, clubCount);
const schedule = doubleRoundRobin(clubCount);

const results: MatchResult[] = [];
schedule.forEach((day, i) => results.push(...resolveMatchday(clubs, day, i, PATCH, nav, map, seed)));

const table = standings(clubCount, results);
const name = (i: number) => `${clubs[i].team.tag} ${clubs[i].team.name}`.padEnd(22);

console.log(`\n  ${map} · seed ${seed} · ${clubCount} clubs · ${schedule.length} match-days · ${results.length} matches\n`);
console.log('  #  CLUB                    P   W   L   RF   RA  DIFF  PTS  str');
console.log('  ' + '─'.repeat(66));
table.forEach((s, rank) => {
  const str = clubs[s.club].strength.toFixed(2);
  console.log(
    `  ${String(rank + 1).padStart(2)} ${name(s.club)} ${String(s.played).padStart(2)} ` +
    `${String(s.won).padStart(3)} ${String(s.lost).padStart(3)} ${String(s.rf).padStart(4)} ` +
    `${String(s.ra).padStart(4)} ${(s.diff >= 0 ? '+' : '') + s.diff}`.padEnd(6) +
    ` ${String(s.points).padStart(4)}  ${str}`,
  );
});

// a spearman-ish sanity line: how well final rank tracks generated strength
const byStrength = [...clubs.keys()].sort((a, b) => clubs[b].strength - clubs[a].strength);
const rankOf = new Map(table.map((s, r) => [s.club, r]));
let inversions = 0;
for (let i = 0; i < byStrength.length; i++) for (let j = i + 1; j < byStrength.length; j++) {
  if (rankOf.get(byStrength[i])! > rankOf.get(byStrength[j])!) inversions++;
}
const pairs = (clubCount * (clubCount - 1)) / 2;
console.log(`\n  strength→rank agreement: ${pairs - inversions}/${pairs} pairs ordered (upsets are healthy)\n`);
