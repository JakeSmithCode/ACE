// Player IDENTITY — the person behind the gamertag (DESIGN §4). Every player has a real
// NAME and a BIRTHDAY derived deterministically from their id (an FNV hash, like traitOf /
// mapAffinity), so there's NO Player contract change and NO world-stream impact — the engine
// never sees it, so seed 42 is byte-identical. The handle (gamertag) stays the competitive
// identity; this is the human under it, and the birthday reads against the in-game calendar
// so a player visibly turns a year older on their day.
import type { GameDate } from './calendar.js';
import { birthdayPassed } from './calendar.js';

// broad international pools (esports is global) — kept deliberately diverse
const FIRST = ['Marek', 'Tomas', 'Aleksander', 'Dae-hyun', 'Lucas', 'Mateus', 'Niko', 'Erik', 'Hiroshi', 'Owen',
  'Diego', 'Felix', 'Sven', 'Kai', 'Ravi', 'Anders', 'Pablo', 'Yuki', 'Liam', 'Bohdan', 'Mehmet', 'Jakub', 'Andre',
  'Sung-min', 'Theo', 'Mikkel', 'Carlos', 'Wei', 'Noah', 'Emir', 'Tariq', 'Joon-ho', 'Ethan', 'Luca', 'Dmitri',
  'Samir', 'Oscar', 'Hassan', 'Finn', 'Renato'];
const LAST = ['Novak', 'Berg', 'Costa', 'Park', 'Vasquez', 'Lindqvist', 'Mori', 'Kovac', 'Schmidt', 'Reyes',
  'Volkov', 'Tan', 'Halls', 'Adeyemi', 'Rossi', 'Dubois', 'Nilsen', 'Walsh', 'Ferreira', 'Singh', 'Yilmaz',
  'Kowalski', 'Santos', 'Choi', 'Andersen', 'Romano', 'Petrov', 'Haidar', 'Murphy', 'Wagner', 'Ozturk', 'Silva',
  'Nakamura', 'Becker', 'Moreau', 'Khan', 'Larsson', 'Greco', 'Ibrahim', 'Sorensen'];

export interface Person { first: string; last: string; name: string; birthday: { month: number; day: number } }

/** A 32-bit FNV-1a hash of an id with an optional salt — deterministic, no rng. */
function h32(id: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** The person behind a player id — real name + birthday, derived (no rng, no contract change). */
export function personOf(id: string): Person {
  const first = FIRST[h32(id, 0x1f) % FIRST.length];
  const last = LAST[h32(id, 0x2c) % LAST.length];
  const doy = h32(id, 0x9d) % 365;                 // birthday as a day-of-year → month/day
  const MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let d = doy + 1, m = 0;
  while (d > MONTHS[m]) { d -= MONTHS[m]; m++; }
  return { first, last, name: `${first} ${last}`, birthday: { month: m + 1, day: d } };
}

/** The age to SHOW: the engine's integer age is "age at the season's start"; the player
 *  turns a year older on their birthday, so once it's passed this season they read +1.
 *  (Development still uses the integer age — this is the player-facing number.) */
export const displayAge = (age: number, birthday: { month: number; day: number }, today: GameDate): number =>
  age + (birthdayPassed(birthday, today) ? 1 : 0);
