// The in-game CALENDAR (DESIGN §4 — players are people on a clock). A season is one
// competitive YEAR: the off-season rollover advances the year, and the match-days are
// spread across a competition window so every fixture has a real DATE. Birthdays read
// against this calendar, so a player visibly turns a year older on their day. Pure +
// derived from (season, dayIdx) — no state, no rng — so the engine and CLIs are untouched.

export interface GameDate { year: number; month: number; day: number }   // month 1..12, day 1..31

const BASE_YEAR = 2025;                       // season 1 = 2025
const MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEASON_OPEN_DOY = 40;                   // competition opens ~9 Feb (day-of-year)
const MATCH_GAP = 14;                         // a fixture roughly every 2 weeks — the season spans
                                              // ~Feb→Oct so birthdays fall across the whole roster

export const seasonYear = (season: number): number => BASE_YEAR + season - 1;
/** Calendar days a full season's competition spans (the "/ Y" in Day X / Y). */
export const seasonLength = (totalMatchdays: number): number => Math.max(1, (totalMatchdays - 1) * MATCH_GAP + 1);
/** Which day of the season window a match-day falls on (1-based — the "X /" in Day X / Y). */
export const dayOfSeason = (dayIdx: number): number => dayIdx * MATCH_GAP + 1;

const toDOY = (month: number, day: number): number => MONTHS.slice(0, month - 1).reduce((s, n) => s + n, 0) + day;
function fromDOY(doy: number): { month: number; day: number } {
  let d = ((doy - 1) % 365) + 1, m = 0;
  while (d > MONTHS[m]) { d -= MONTHS[m]; m++; }
  return { month: m + 1, day: d };
}

/** The calendar date a season's match-day lands on. */
export function matchDate(season: number, dayIdx: number): GameDate {
  return { year: seasonYear(season), ...fromDOY(SEASON_OPEN_DOY + dayIdx * MATCH_GAP) };
}
/** Has a birthday (month/day) already passed by `date` this season? */
export const birthdayPassed = (bday: { month: number; day: number }, date: GameDate): boolean =>
  toDOY(bday.month, bday.day) <= toDOY(date.month, date.day);

export const fmtDate = (d: GameDate): string => `${d.day} ${MONTH_NAMES[d.month - 1]} ${d.year}`;
export const fmtDayMonth = (b: { month: number; day: number }): string => `${b.day} ${MONTH_NAMES[b.month - 1]}`;
