// Seed a world into the store (docs/PHASE2.md §14 step 2): generate a fresh
// `WorldState` from a seed and persist it. The Pg version writes the same value
// object to `world`/`club`/`player` rows; here it lands in the MemoryStore.
import { createWorld } from '@ace/world';
import type { WorldStore } from './store.js';

export function seedWorld(store: WorldStore, opts: { seed: number; region?: string; tiers?: number; size?: number; promo?: number; layout?: number[] }): Promise<string> {
  return store.createWorld(createWorld(opts.seed, {
    region: opts.region ?? 'AMER', tiers: opts.tiers, size: opts.size, promo: opts.promo, layout: opts.layout,
  }));
}
