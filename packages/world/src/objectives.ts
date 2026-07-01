// The board's season objective + job security (a manager-game staple, made fair — DESIGN §18).
// At season start the board sets a target from the club's PRE-SEASON strength rank within its
// division: a favourite is told to win promotion (or, in the top tier, challenge for the title),
// a mid club to make the top half, an underdog to survive. Meeting it pays a bonus; the board's
// confidence moves with how you did — never a punishment beyond the standing itself. Pure +
// deterministic (a function of the rank), owner-scoped in the PvP world.

export interface Objective { kind: 'title' | 'promote' | 'tophalf' | 'survive'; label: string; needRank: number; bonus: number; seed: number }
export interface BoardOutcome { met: boolean; label: string; bonus: number; finish: number }

export const CONF_START = 60;

/** The brief from a club's pre-season strength rank in its division (`rank` 1 = strongest). */
export function computeObjective(rank: number, tier: number, divSize: number, promo: number): Objective {
  if (rank <= promo) return tier === 0
    ? { kind: 'title', label: 'Challenge for the title', needRank: 4, bonus: 9000, seed: rank }
    : { kind: 'promote', label: 'Win promotion', needRank: promo, bonus: 9000, seed: rank };
  if (rank <= divSize / 2) return { kind: 'tophalf', label: 'Finish top half', needRank: Math.floor(divSize / 2), bonus: 4500, seed: rank };
  return { kind: 'survive', label: 'Avoid relegation', needRank: divSize - promo, bonus: 2500, seed: rank };
}

/** How the board's confidence (0..100) moves at season's end: smashing the brief backs you,
 *  bombing it mounts pressure. Forgiving from the neutral start — a near-miss costs little. */
export function confDelta(objMet: boolean, needRank: number, finish: number): number {
  const reqGap = needRank - finish;   // >0 = you beat the required finish
  return objMet ? 6 + Math.min(9, Math.max(0, reqGap) * 3)   // met: +6 (scraped) .. +15 (smashed)
                : Math.max(-16, -3 + reqGap * 3);            // missed: −6 a near-miss .. −16 a disaster
}

export function confidenceStatus(c: number): { key: string; label: string } {
  if (c >= 75) return { key: 'secure', label: 'the board backs you fully' };
  if (c >= 45) return { key: 'stable', label: 'the board is satisfied' };
  if (c >= 20) return { key: 'shaky', label: 'under pressure — results needed' };
  return { key: 'brink', label: 'on the brink — your job is at risk' };
}
