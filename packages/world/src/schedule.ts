// Round-robin scheduling (the circle method). A season is a list of match-days;
// each match-day is a set of fixtures (pairs of club indices). Pure and
// deterministic — the fixture list is a function of the club count alone.

export interface Fixture { home: number; away: number }
export type Matchday = Fixture[];

/** Single round-robin: every club plays every other once over `n-1` match-days
 *  (n even). The circle method rotates all but one club around a fixed pivot, so
 *  each round is a clean parallel set of fixtures. */
export function roundRobin(n: number): Matchday[] {
  if (n % 2 !== 0) throw new Error('roundRobin needs an even club count');
  const idx = Array.from({ length: n }, (_, i) => i);
  const days: Matchday[] = [];
  for (let r = 0; r < n - 1; r++) {
    const day: Matchday = [];
    for (let i = 0; i < n / 2; i++) {
      const home = idx[i], away = idx[n - 1 - i];
      // alternate home/away by round so the schedule isn't lopsided
      day.push(r % 2 === 0 ? { home, away } : { home: away, away: home });
    }
    days.push(day);
    // rotate: keep idx[0] fixed, move the rest one step
    idx.splice(1, 0, idx.pop()!);
  }
  return days;
}

/** Double round-robin: the single schedule, then a mirror with sides flipped, so
 *  every pairing plays home and away (a full `2(n-1)` match-day season). */
export function doubleRoundRobin(n: number): Matchday[] {
  const first = roundRobin(n);
  const second = first.map(day => day.map(f => ({ home: f.away, away: f.home })));
  return [...first, ...second];
}
