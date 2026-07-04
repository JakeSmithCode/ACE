import type { MapId, Vec2, SiteId } from '@ace/shared';

/** Per-map tactical anchors in minimap image space (0..1000).
 *  Derived from the official displayIcon; site centers from the asset pack,
 *  spawn/mid eyeballed against the contact sheet. The engine snaps any point to
 *  the nearest walkable cell, so these need only be roughly right.
 *  `sites.C` is opt-in: present only on genuinely three-site maps (Haven, Lotus). */
export interface MapAnchors {
  atkSpawn: Vec2;
  sites: { A: Vec2; B: Vec2; C?: Vec2 };
  mid: Vec2;
  /** PER-MAP DEFENSE DRESSING (optional): authored hold spots per site for the
   *  procedural defense — for rooms whose geometry defeats the generic
   *  jitter-around-the-anchor placement (sunset's B is a DONUT: the anchor
   *  centres an unwalkable island, so generically-placed bodies see nothing).
   *  When present, the read-stack / watchers / site convergence place onto
   *  these spots (same rng draw count — byte-identical when absent). */
  defSpots?: Partial<Record<'A' | 'B' | 'C', Vec2[]>>;
  /** PER-MAP DEFENSE SHAPE (optional): how many mid-pool bodies re-post as extra
   *  SITE watchers (alternating off-site → read stack, so 2 on a two-site map is
   *  the classic 2-2-1). The lever for rotation-poor interiors (fracture/abyss/
   *  bind/sunset class): their sites sit too far from mid for the default
   *  mid-heavy pool to contest a wrong read, so one watcher faces a five-man hit
   *  and the free plant follows. A hedge trades map-control flex for wrong-read
   *  insurance — WORSE on a map whose mid genuinely covers its sites (that's the
   *  measured 3-site read-floor null), so it's authored per map and MEASURED with
   *  `pnpm balance`, never defaulted. Absent = 0 = byte-identical. */
  defHedge?: number;
}

// Haven and Lotus are genuinely three-site — they now field all three (A/B/C).
// Abyss is 2-site (the 3rd detected point was a spawn artifact, dropped).
// `mid` sits between spawn and the sites — the chokepoint where the defense first
// contests the push. (Ascent's is hand-tuned; the rest are spawn↔sites midpoints.)
export const ANCHORS: Partial<Record<MapId, MapAnchors>> = {
  ascent:   { atkSpawn: [485, 60],  sites: { A: [310, 150], B: [270, 793] }, mid: [500, 470] },
  // THE ANCHOR LEVER IS EXHAUSTED for the maps still out of rotation — all
  // measured (toward-mid sweeps, 80-seed mirrors): abyss crosses over on a CLIFF
  // (in90 70.5%ATK/11.3%time -> in105 52.1/26.6 STALLY — no joint solution);
  // bind (in90 71.9/17.2) and fracture (in160 64.3/30.9) trade ATK for stalls
  // monotonically, the sunset signature. These interiors are LOS-scarce mazes:
  // sites far out = free plants, sites pulled in = mutual blindness. The fix
  // class is LOS-aware placement / defense shape (defSpots is the substrate),
  // not anchors. Icebox is separately DEF-lean (site probes 35-40.5%).
  //
  // THE DEFENSE-SHAPE PASS (defHedge) then delivered exactly that fix class —
  // and RESCUED TWO of them (hedge sweep, 80-seed mirrors, confirmed at 200):
  // bind hedge=3 76.6→57.3 ok (plant 95→72) and icebox hedge=2 41.0→51.6 ok
  // (its DEF lean was the mid pool over-intercepting a tiny map — re-posting it
  // on sites fixed a lean the site-anchor probes couldn't). Both now in
  // MAP_POOL. The rest are hedge-measured NULLS — don't re-run: fracture
  // plateaus 83.1→62.2 at hedge 3, abyss 83.4→64.5 (still ATK with ZERO mid
  // bodies left to shift), sunset's stall doesn't move (37.6→37.2 — it's LOS
  // starvation, not shape). Combos re-buy the stall coin: fracture hedge×in60-
  // 160 → 22-34% time, abyss hedge×in60-105 stays 66-73 ATK, sunset hedge3 +
  // cover-adjacent B-ring defSpots lands 56.3 ATK but 25% time (down from 37 —
  // closest yet; the residual is mutual-blindness geometry the alpha mask
  // gives these interiors). A light bind pull under the hedge is noise (in40
  // 55.4/1.5, in60 58.8/11.5 — non-monotonic), so its anchors stay put.
  abyss:    { atkSpawn: [840, 480], sites: { A: [408, 104], B: [392, 864] }, mid: [620, 482] },
  bind:     { atkSpawn: [595, 870], sites: { A: [288, 264], B: [720, 320] }, mid: [549, 581], defHedge: 3 },
  breeze:   { atkSpawn: [470, 870], sites: { A: [144, 288], B: [864, 456] }, mid: [487, 621] },
  fracture: { atkSpawn: [500, 120], sites: { A: [872, 504], B: [96, 520] },  mid: [492, 316] },
  // haven/lotus outer sites sit at the plaza MOUTHS (not centres): the raw centre
  // anchors put A↔C rotations ~700u apart — unrecoverable for a wrong read — and
  // both maps measured 60-62% ATK. Pulling the outer anchors toward the middle
  // (A +80/C +60 on haven; A +60/C +70 on lotus, all snapped walkable) shortens the
  // rotation tax and lands both `ok` on pnpm balance (54.2 / 54.3). Measured, not
  // eyeballed — re-sweep with the mirror harness before moving them again.
  haven:    { atkSpawn: [850, 520], sites: { A: [368, 216], B: [344, 470], C: [360, 772] }, mid: [607, 502] },
  icebox:   { atkSpawn: [850, 540], sites: { A: [608, 208], B: [720, 800] }, mid: [757, 522], defHedge: 2 },
  lotus:    { atkSpawn: [500, 850], sites: { A: [804, 320], B: [488, 372], C: [182, 464] }, mid: [494, 621] },
  // pearl's sites likewise pulled inward (±45 toward mid — 67.5%→51.6% ATK, the
  // same measured rotation-tax fix; ±90 overshoots STALLY). Icebox RESISTED the
  // site lever in three directions (35-40.5% DEF across toward-spawn/away/single-
  // site probes) — its lean is not site placement; it stays out of the pool.
  pearl:    { atkSpawn: [533, 860], sites: { A: [803, 328], B: [221, 412] }, mid: [522, 608] },
  split:    { atkSpawn: [130, 520], sites: { A: [320, 88],  B: [320, 816] }, mid: [225, 486] },
  // sunset DIAGNOSED but not fixable by anchors: its 38% stalls are B's DONUT
  // room — the anchor centres on an unwalkable island, so both sides arrange
  // around it with no mutual LOS (timeout rounds average 1.6 kills vs 7.3 on
  // ascent, arrivals normal). Moving B onto the open ring KILLS the stalls but
  // collapses the defense (83.8% ATK — the island IS their cover), and A-mouth
  // moves deepen the stall instead (47.7%). The stall and the balance are the
  // same coin; sunset needs per-map defense shapes, not an anchor nudge.
  // UPDATE: the defense-DRESSING machinery was built (defSpots — authored hold
  // spots the procedural defense places onto) and sunset was swept with ring/
  // mouth spot sets: every vision-restoring variant lands 80-85% ATK (ring3
  // 82.2, mouths 80.6) — the same signature as fracture/abyss/bind. Once a
  // sunset site is contestable it loses to the tucked fan; the remaining fix
  // is defense STRENGTH/shape on open-entry maps, not placement. defSpots stays
  // (dormant, byte-identical when absent) as the substrate for that pass.
  // UPDATE 2 (per-site diagnosis + the LOS-contest null): sunset is TWO broken
  // maps in one — A is the free-plant class (81.5% ATK, 94% plant, 0 stalls)
  // and B is the donut (76% timeouts at 1.6 kills, plant 24%: an island body
  // inside SITE_R freezes a plant it cannot SEE, and nobody can kill it
  // through the wall). Decoupling the coin was tried every way it can be
  // authored — plant point moved to the ring (east/south) x island-cover
  // defSpots x hedge2/3 x A-pulls — and B is BIMODAL in all of them: plants
  // blocked = 25-45% timeouts, plants unblocked = 69-95% ATK. An engine-level
  // LOS-gated contest (losClear + proximity exemption) was also swept and
  // REVERTED — it broke lotus/haven/pearl at every radius that helped B (the
  // null lives in sim.ts at the plant block). Sunset stays out until the
  // combat model gives a ring defense a way to WIN an open site.
  sunset:   { atkSpawn: [520, 860], sites: { A: [816, 368], B: [136, 432] }, mid: [498, 630] },
};

/** The site ids a map fields, in order (`['A','B']` or `['A','B','C']`). */
export function siteIds(a: MapAnchors): SiteId[] {
  return (['A', 'B', 'C'] as const).filter(s => a.sites[s]);
}

/** A site's anchor point (the id is always one the map fields). */
export const sitePt = (a: MapAnchors, s: SiteId): Vec2 => a.sites[s]!;
