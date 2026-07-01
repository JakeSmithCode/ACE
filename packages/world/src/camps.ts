// Pre-season training camp — a one-time-per-season prep choice that shapes the whole campaign
// (a manager-game staple). Each camp plugs into a system you already manage: FITNESS slows
// fatigue (your stars stay fresh), CHEMISTRY gels the squad faster (fresh signings settle),
// SHARPNESS keeps the room buzzing (higher morale all season). Pickable only in the early-season
// window, then locked; reset each rollover. Owner-scoped + engine-blind, so a no-owner world is
// byte-identical. Mirrors the single-player store's camp.
export type Camp = 'fitness' | 'chemistry' | 'sharpness';

export const CAMP_META: Record<Camp, { label: string; icon: string; blurb: string }> = {
  fitness: { label: 'Fitness camp', icon: '⛰', blurb: 'slower fatigue all season — your stars stay fresh' },
  chemistry: { label: 'Team building', icon: '⬡', blurb: 'the squad gels faster — chemistry builds quicker' },
  sharpness: { label: 'Scrim block', icon: '◎', blurb: 'sharper out the gate — higher morale all season' },
};

export const CAMP_FAT = 0.82;    // fitness camp: fatigue-gain multiplier (a slower burn)
export const CAMP_CHEM = 1.6;    // chemistry camp: tenure-gain multiplier (gels faster)
export const CAMP_MOOD = 1.6;    // sharpness camp: the per-match-day morale add (in updateMorale's sharpnessCamp)
export const CAMP_WINDOW = 3;    // the early-season window (match-day ≤ this) — locked once the campaign's underway

export const canPickCamp = (day: number): boolean => day <= CAMP_WINDOW;

// --- team chemistry (mirrors the engine's CHEM_CAP): a player gels with shared play; a fresh
// signing (tenure 0) reads 0%, fully gelled at CHEM_CAP seasons. ------------------------------
export const CHEM_CAP = 1.5;
export const chemOf = (tenure: number | undefined): number => Math.min(1, Math.max(0, (tenure ?? 0) / CHEM_CAP));
/** A team's cohesion 0..1 = the mean chemistry of its five (the counterweight to the market —
 *  a settled core out-duels an equal-talent brand-new roster). */
export const teamCohesion = (tenures: (number | undefined)[]): number =>
  tenures.length ? tenures.reduce((s: number, t) => s + chemOf(t), 0) / tenures.length : 0;
