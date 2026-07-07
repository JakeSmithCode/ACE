// The FANBASE — a club's commercial gravity (the income side of DESIGN §8 made
// living). Results grow it, star power holds it, and it prices the sponsor
// table: a club with a big following draws bigger cheques. Owner-scoped state
// (`WorldClub.fans`) with a strength/tier/titles-derived baseline for AI clubs;
// undefined everywhere → every multiplier is ×1 and worlds are byte-identical.
// Pure + deterministic (no rng — growth is a function of results and roster).

/** The baseline following a club of this stature would carry: stronger squads and
 *  higher tiers draw more, every league title adds a lasting bump. This is both
 *  the AI clubs' display value and a fresh owner's starting point. */
export function baseFans(strength: number, tier: number, titles: number): number {
  const quality = 400 + Math.max(0, strength * 100 - 50) * 380;   // ~400 .. ~13k by squad
  return Math.round(quality * Math.pow(0.55, tier) * (1 + titles * 0.35));
}

export const FAN_WIN = 0.012;    // +1.2% a win — winning builds the brand
export const FAN_LOSS = -0.005;  // −0.5% a loss — slower down than up (fans are sticky)
export const FAN_DERBY = 0.02;   // extra on a DERBY win (bragging gravity travels)
export const FAN_STAR = 0.0008;  // per roster accolade per match-day (star pull — an
                                 // MVP on the books keeps the shirts selling)
export const FAN_FLOOR = 200;    // nobody draws zero

/** One match-day of fan movement. `accolades` = total accolades on the roster. */
export function tickFans(fans: number, r: { won: boolean | null; derby?: boolean; accolades: number }): number {
  const result = r.won == null ? 0 : r.won ? FAN_WIN + (r.derby ? FAN_DERBY : 0) : FAN_LOSS;
  return Math.max(FAN_FLOOR, Math.round(fans * (1 + result + r.accolades * FAN_STAR)));
}

/** How the following prices the SPONSOR table: offers scale by the ratio of the
 *  club's real following to its stature baseline, square-rooted and bounded —
 *  a grown brand earns up to +60%, a neglected one bottoms at −20% (pressure,
 *  never a mugging — DESIGN §18). ×1 exactly when fans === base (or absent). */
export function fanSponsorMul(fans: number | undefined, base: number): number {
  if (fans == null) return 1;
  return Math.max(0.8, Math.min(1.6, Math.sqrt(Math.max(1, fans) / Math.max(1, base))));
}
