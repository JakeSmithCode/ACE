// Player PERSONALITY traits (DESIGN §4 — the human behind the stat line). Each player has a
// stable trait DERIVED from their id (a deterministic FNV hash, like mapAffinity/clubAgeChar)
// — NOT a field on Player, so there's no contract change and the world stream is untouched.
// A trait bends the management layers (morale, fitness, the big-stakes match) the store
// already owns; the match ENGINE never sees it (the store scales attrs), so seed 42 is
// byte-identical. ~1/3 of players are "Balanced" (no pronounced trait), keeping it special.
export type TraitKey = 'bigGame' | 'leader' | 'hothead' | 'professional' | 'workhorse' | 'mercurial';
export interface PlayerTrait { key: TraitKey; label: string; blurb: string }

export const PLAYER_TRAITS: PlayerTrait[] = [
  { key: 'bigGame', label: 'Big-Game Player', blurb: 'rises for the derby — sharper when the stakes are highest' },
  { key: 'leader', label: 'Natural Leader', blurb: 'lifts the whole room — a steadying presence in the five' },
  { key: 'hothead', label: 'Hothead', blurb: 'takes losses hard — morale swings down further after a defeat' },
  { key: 'professional', label: 'Consummate Pro', blurb: 'unflappable — mood stays level through wins and losses' },
  { key: 'workhorse', label: 'Workhorse', blurb: 'an iron man — tires slower and picks up fewer injuries' },
  { key: 'mercurial', label: 'Mercurial', blurb: 'a streak player — mood (and form) swings hard either way' },
];
const BY_KEY: Record<TraitKey, PlayerTrait> = Object.fromEntries(PLAYER_TRAITS.map(t => [t.key, t])) as Record<TraitKey, PlayerTrait>;

/** A player's trait from their id — deterministic, no rng. ~1/3 return null (Balanced),
 *  so a pronounced personality is a real read, not noise. */
export function traitOf(id: string): PlayerTrait | null {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  const n = h % 9;                       // 0..5 → a trait, 6..8 → Balanced (no pronounced trait)
  return n < PLAYER_TRAITS.length ? PLAYER_TRAITS[n] : null;
}
export const traitKeyOf = (id: string): TraitKey | null => traitOf(id)?.key ?? null;
export const traitMeta = (key: TraitKey) => BY_KEY[key];
