import type {
  MatchInput, MatchTimeline, Round, MatchEvent, RoundMethod, Player, Vec2, Team, Tactics, Comp, Role, PatchState, RotateTrigger, RotateStep, SiteId,
} from '@ace/shared';
import { DEFAULT_TACTICS, MAX_ROTATE_STEPS } from '@ace/shared';
import { Rng, sigmoid } from './rng.js';
import { decideBuy, nextCreds, buildEconomy, type Buy } from './economy.js';
import { ANCHORS, pathfind, inView, posAlong, coverOf, seekCover, siteIds, sitePt as siteAnchor, type Navmesh, type MapAnchors } from '@ace/maps';

// ---- tuning ----------------------------------------------------------------
const STEP = 0.015;        // simulation tick (normalized round time)
const ENGAGE = 150;        // duel range in image units
const PLANT_R = 75;        // "on site" radius
const SITE_R = 130;        // "contesting site" radius
const SPIKE_TIME = 0.34;   // detonation timer after plant (normalized)
const DEFUSE_R = 90;       // how close a defender must be to the spike to defuse it
const DEFUSE_TIME = 0.10;  // uncontested time on the spike needed to defuse (normalized)
const POSTPLANT_HOLD = 10;  // post-plant the attackers hold the crossfire — the hold edge flips to them
const SPEED = 4200;        // path units traversed per unit round time (sets arrival)
const FOV = 1.05;          // half-angle of an agent's awareness cone (~60°, so 120° total)
const FIRST_SHOT = 11;     // duel edge for spotting an unaware enemy first
const FORM_SWING = 6;      // match-night form: per-player edge drawn once per match (±)
const CHEM_EDGE = 1.0;     // team chemistry: a fully-gelled team's per-duel edge over a brand-new one
                           // (small — a constant per-duel edge compounds hard over a match)
const CHEM_CAP = 1.5;      // seasons of shared play (mean tenure) to fully gel
// A team's chemistry edge from how long its five have played together. A new
// signing (tenure 0) drags the mean down until it gels; a settled core gets the
// full edge. NO tenure data (undefined — the engine sample) → 0, so seed 42 is
// byte-identical. Bounded (DESIGN §2/§18): synergy is a real factor, never the
// whole story.
function teamChem(players: { tenure?: number }[]): number {
  const ten = players.map(p => p.tenure).filter((t): t is number => t !== undefined);
  if (ten.length === 0) return 0;
  const mean = ten.reduce((s, t) => s + t, 0) / ten.length;
  return CHEM_EDGE * Math.min(1, Math.max(0, mean) / CHEM_CAP);
}
const HOLD_BONUS = 6;      // a held angle's duel edge (an anchor on their spot)
const COVER_EDGE = 8;      // duel edge for a fully-covered SET fighter (a corner peek = half);
                           // between FIRST_SHOT and HOLD_BONUS — position beats a held angle,
                           // loses to genuine surprise. Balance-sensitive: measure with pnpm balance.
const RETREAT_HP = 25;     // below this a wounded mid-travel graze survivor BREAKS OFF to cover
                           // (a new movement leg) instead of just hesitating — balance-sensitive
const TRADE_WINDOW = 0.03; // round-time a killer stays exposed to a trade after a kill (~3s)
const TRADE_EDGE = 7;      // a trade's duel edge — strong, but less than a clean first shot
// Fights are neither instant nor free (the "actual players" layer):
const FIGHT_PAUSE = 0.014; // round-t a duel WINNER halts at the kill spot (~1.4s) — fights take time,
                           // so a contested push arrives late, and a fresh killer is a stationary,
                           // known-position target for the trade window. Balance-sensitive: 0.018
                           // tipped split DEF-SIDED (41.8) — pauses tax the pushing side hardest.
const FIGHT_FACE = 0.03;   // round-t the winner stays focused down the kill line (tunnel vision —
                           // realistically flankable from their travel direction)
const WOUND_PEN = 0.08;    // duel-edge lost per missing HP — a 50hp fighter duels at −4
const CHIP_LO = 8, CHIP_HI = 70;  // return-damage band; scaled by how contested the duel was
// Wounded BEHAVIOUR (not just a stat penalty): a fighter who comes out of ANY exchange
// badly hurt hesitates — patches up, resets their crosshair, moves off more carefully —
// before continuing. Visible on the map as a hitch after a bloody fight, and a real cost:
// the wounded arrive later, out of sync with their team.
const WOUNDED_HP = 35;     // below this, a survivor is visibly playing hurt
const WOUND_PAUSE = 0.018; // the extra beat a badly wounded survivor takes before moving on
// Non-lethal EXCHANGES: a near-coin-flip duel can break off without a kill — both trade
// shots, take damage, and disengage for a beat. The wounds escalate the next exchange
// (WOUND_PEN), so firefights BUILD: poke → poke → kill, instead of every contact being
// instantly lethal. Graze chance scales with closeness (0 when the duel is lopsided).
const GRAZE_MAX = 0.38;    // graze chance at a perfect 50/50; ~0 for a dominant duel
const GRAZE_LO = 6, GRAZE_HI = 26;   // per-side graze damage band — LIGHT pokes (deep wounds let the
                           // grouped side clean up wounded defenders and tipped lotus ATK-SIDED)
const GRAZE_COOL = 0.015;  // round-t a poked matchup disengages (~1.5s) — then it concludes
const GRAZE_FACE = 0.02;   // both watch each other through the exchange (affects vision)
const ROTATE_SPEED = 0.85; // a rotator's travel speed once it has info and moves with purpose
const ATK_SPREAD = 18;     // lateral fan across the site entry — pushers hit distinct angles, not one stacked point

// utility — abilities express the `utility` attribute by bending duels through
// the same geometry. Reach/duration scale with the caster's utility (0..1), so
// a util-stacked comp buys space and entries. Tune after watching matches back.
const SMOKE_R = 58, SMOKE_R_UTIL = 46;       // smoke radius (image units): 58..104
const SMOKE_T0 = 0.15, SMOKE_JITTER = 0.10;  // when a smoke blooms (normalized t)
const SMOKE_DUR = 0.20, SMOKE_DUR_UTIL = 0.18;
const CTRL_RESMOKE_U = 0.5;                   // utility a controller needs to throw a SECOND smoke on the execute
const RESMOKE_T0 = 0.30;                      // the second smoke blooms just after the first — sustained coverage through the hit
const RESMOKE_R = 50, RESMOKE_R_UTIL = 38;    // a focused second wall on the connector (50..88)
const RESMOKE_DUR = 0.16, RESMOKE_DUR_UTIL = 0.12;
const RETAKE_SMOKE_U = 0.35;                  // utility a defense controller needs to have SAVED a retake smoke
const RETAKE_DELAY = 0.02;                    // beat after the plant before the retake smoke blooms on the spike
const PULSE_R = 84, PULSE_R_UTIL = 70;       // recon/flash reach: 84..154
const PULSE_DUR = 0.07, PULSE_DUR_UTIL = 0.10;
const TRAP_R = 60, TRAP_R_UTIL = 48;         // sentinel trap watch-zone reach: 60..108
const TRAP_T0 = 0.05, TRAP_DUR = 0.80;       // armed early, holds most of the round
const TRAP_SLOW = 0.055;                     // round-fraction an enemy is delayed crossing a trap (denial)

const WEAPONS: Record<Buy, string[]> = {
  full: ['Vandal', 'Phantom', 'Operator', 'Vandal', 'Phantom'],
  force: ['Spectre', 'Bulldog', 'Sheriff', 'Marshal'],
  eco: ['Classic', 'Ghost', 'Sheriff'],
  pistol: ['Ghost', 'Classic', 'Sheriff', 'Frenzy'],
};
const TIER: Record<string, number> = {
  Operator: 3.2, Vandal: 3, Phantom: 3, Bulldog: 2.2, Spectre: 2.1, Marshal: 2,
  Sheriff: 1.6, Ghost: 1.2, Frenzy: 1.1, Classic: 1,
};
// Weapons have a DAMAGE identity, not just a quality tier: graze damage scales with the
// SHOOTER's gun, and the winner's return-chip scales with the LOSER's gun — so beating an
// eco Classic is cheap, while trading up into a rifle (or eating an Op body-shot) hurts.
// Applied post-draw (same rng count) like every fairness-preserving multiplier here.
const W_DMG: Record<string, number> = {
  Operator: 1.5, Marshal: 1.2, Vandal: 1.15, Phantom: 1.1, Bulldog: 1.0,
  Spectre: 0.95, Sheriff: 1.05, Ghost: 0.8, Frenzy: 0.75, Classic: 0.7,
};
// Armor rides the BUY (a full buy includes heavy shields): incoming attrition damage is
// scaled by the shield tier, so a bought-up team SUSTAINS multi-fight rounds while an eco
// is fragile flesh. Applied to chip + graze damage only, never the duel win itself (the
// weapon TIER already carries buy quality there) — so it deepens the economy's stakes:
// winning a gun round leaves you healthier than winning the same fights on a save.
const ARMOR_MUL: Record<Buy, number> = { full: 0.72, force: 0.84, pistol: 0.92, eco: 1.0 };
// ...a HANDLING identity (rate of fire made real at this timescale): the post-kill
// recovery — re-chamber, reload, re-set — scales with the gun. An Op winner stands
// exposed longest; an SMG is instantly ready. Scales the winner's FIGHT_PAUSE.
const W_HANDLING: Record<string, number> = {
  Operator: 1.6, Marshal: 1.35, Vandal: 1.0, Phantom: 0.95, Bulldog: 1.0,
  Spectre: 0.8, Sheriff: 0.9, Ghost: 0.85, Frenzy: 0.75, Classic: 0.8,
};
const RELOAD_PEN = 6;      // duel edge lost while mid-recovery (reloading/re-chambering after a kill) —
                           // getting traded mid-reload is now mechanically true, not just narratively
// ...and HEADSHOTS: a clean one-tap, rolled per kill from the winner's AIM + how dominant
// the duel was. A headshot kill takes almost no return chip (the loser never got to spray
// back). Pro-level HS rates land ~25-35%; sharp aim pushes toward 45%+ on dominant duels.
const HS_BASE = 0.22, HS_AIM = 0.006, HS_DOM = 0.25;   // P(hs) = base + (aim−65)·aim + (q−0.5)·dom
const HS_CHIP = 0.3;       // a headshot's return-chip multiplier (near-instant kill)
// ...and a RANGE personality inside the engage envelope (0..ENGAGE): a sniper dominates
// a held max-distance angle and crumbles when rushed; SMGs/pistols invert. A pure
// function of the duel distance — no rng, and mirror-symmetric so the pool stays fair.
const W_RANGE: Record<string, { close: number; long: number }> = {
  Operator: { close: -7, long: 6 }, Marshal: { close: -4, long: 4 },
  Vandal: { close: 0, long: 1 }, Phantom: { close: 1, long: 0 }, Bulldog: { close: 0, long: 0 },
  Spectre: { close: 3, long: -3 }, Sheriff: { close: 1, long: -1 },
  Ghost: { close: 1, long: -2 }, Frenzy: { close: 3, long: -4 }, Classic: { close: 2, long: -4 },
};
const RANGE_CLOSE = 70, RANGE_LONG = 125;   // the bands (image units) within ENGAGE=150
/** A weapon's duel-edge adjustment at distance d — lerped between its close/long identity.
 *  The POSITIVE half only applies to a SET shooter (you can't scope on the run) — a moving
 *  Op keeps its rush penalty but loses its angle dominance, so the identity rewards holds. */
function rangeEdge(weapon: string, d: number, set: boolean): number {
  const w = W_RANGE[weapon];
  if (!w) return 0;
  const e = d <= RANGE_CLOSE ? w.close
    : d >= RANGE_LONG ? w.long
    : w.close + (w.long - w.close) * ((d - RANGE_CLOSE) / (RANGE_LONG - RANGE_CLOSE));
  return set ? e : Math.min(0, e);
}

// The fielded agent decides the kit (which utility fires). An agent off a
// player's pool defaults to the player's natural role.
const AGENT_ROLES: Record<string, Role> = {
  Jett: 'duelist', Raze: 'duelist', Neon: 'duelist', Yoru: 'duelist', Phoenix: 'duelist', Reyna: 'duelist', Iso: 'duelist',
  Sova: 'initiator', Fade: 'initiator', Breach: 'initiator', Skye: 'initiator', KAYO: 'initiator', Gekko: 'initiator',
  Omen: 'controller', Brimstone: 'controller', Viper: 'controller', Astra: 'controller', Harbor: 'controller', Clove: 'controller',
  Killjoy: 'sentinel', Cypher: 'sentinel', Chamber: 'sentinel', Sage: 'sentinel', Deadlock: 'sentinel', Vyse: 'sentinel',
};

/** A player's pick for the match: which agent, how strong it is on this patch,
 *  how well they play it. Folds into one duel edge + a utility multiplier. */
interface Loadout { agent: string; role: Role; mastery: number; compEdge: number; utilFactor: number; }

/** A player's main = their highest-mastery agent (name tiebreak, deterministic). */
function topAgent(p: Player): string {
  return [...p.agents].sort((a, b) => b.level - a.level || (a.agent < b.agent ? -1 : 1))[0]?.agent ?? 'Jett';
}

/** Default entry = the team's best opening duelist (entry attr, id tiebreak). */
function bestEntry(team: Team): string {
  return [...team.players].sort((a, b) => b.attr.entry - a.attr.entry || (a.id < b.id ? -1 : 1))[0].id;
}

/** The in-game leader's read: a rotation-speed multiplier for the defense's
 *  info-held rotators, scaled by the IGL's cerebral stats (gameSense + clutch).
 *  A sharp caller gets bodies into position faster on contact — and because only
 *  *out-of-position* rotators move, the edge scales with how wrong the read was,
 *  so it reads as adaptive mid-round recovery. Bounded both ways (~0.85..1.20)
 *  and fair: a wrong pre-round read is mitigated by a great IGL, never erased,
 *  and a weak caller is a roster gap you can fix, not a mugging. No IGL = neutral. */
function iglRotateMul(team: Team): number {
  const igl = team.players.find(p => p.igl);
  if (!igl) return 1;
  const sense = (igl.attr.gameSense + igl.attr.clutch) / 2;        // 0..100
  return 1 + Math.max(-0.15, Math.min(0.20, (sense - 70) / 100));  // 50→0.85 .. 90→1.20
}

/** The in-game leader's ECONOMIC acumen — the buy is an IN-GAME call, made by the IGL,
 *  not the manager. Quality scales with the IGL's cerebral stats (gameSense + clutch),
 *  centred at 70: a sharp caller saves with discipline (banks toward a guaranteed full
 *  buy), a weak one half-buys when he should save and bleeds the economy. Bounded
 *  [-1, +1]; no IGL = neutral 0 (so the buy logic is unchanged without a leader). */
function iglEco(team: Team): number {
  const igl = team.players.find(p => p.igl);
  if (!igl) return 0;
  const sense = (igl.attr.gameSense + igl.attr.clutch) / 2;        // 0..100
  return Math.max(-1, Math.min(1, (sense - 70) / 25));             // 45→-1 .. 70→0 .. 95→+1
}

/** A kill-point trigger with a death's player id resolved to a handle (the form
 *  the engine fires on). Returns null if the named teammate doesn't exist. */
type ResolvedTrig = { kind: 'death'; handle: string } | { kind: 'contact' } | { kind: 'time'; t: number };
/** The ACTIVE kill-point step on an Ag — a resolved RotateStep; `.then` is the rest of the chain. */
type RotPlan = { pos: Vec2; route?: Vec2[]; trigger: ResolvedTrig; then: RotPlan | null };
function resolveTrig(trigger: RotateTrigger, byId: Map<string, Player>): ResolvedTrig | null {
  if (trigger.kind === 'death') { const h = byId.get(trigger.player)?.handle; return h ? { kind: 'death', handle: h } : null; }
  return trigger;
}

/** Resolve an authored kill-point CHAIN (RotateStep.then) into the Ag's linked
 *  rotatePlan: each step's death trigger resolved to a handle, depth-capped at
 *  MAX_ROTATE_STEPS, truncated at the first unresolvable step. */
function resolveChain(rt: RotateStep | undefined, byId: Map<string, Player>, depth = 0): RotPlan | null {
  if (!rt || depth >= MAX_ROTATE_STEPS) return null;
  const trig = resolveTrig(rt.trigger, byId);
  if (!trig) return null;
  return { pos: rt.pos, route: rt.route, trigger: trig, then: resolveChain(rt.then, byId, depth + 1) };
}

function addLoadouts(into: Map<string, Loadout>, team: Team, comp: Comp | undefined, patch: PatchState): void {
  for (const p of team.players) {
    const agent = comp?.[p.id] ?? topAgent(p);
    const known = p.agents.find(a => a.agent === agent);
    const mastery = known ? known.level : 45;                 // an off-pool pick is rough
    const tier = patch.agentTier[agent] ?? 1.0;
    const role = AGENT_ROLES[agent] ?? p.role;
    // meta strength + comfort on the agent, as a duel edge (~±5) and util multiplier
    const compEdge = (tier - 1) * 60 + (mastery - 75) * 0.1;
    const utilFactor = 0.65 + (mastery / 100) * 0.5;
    into.set(p.handle, { agent, role, mastery, compEdge, utilFactor });
  }
}

interface Ag {
  p: Player;
  side: 0 | 1;
  handle: string;
  path: Vec2[];
  departT: number;       // round-time the agent starts moving (Infinity = holding for info)
  arrive: number;        // travel duration once moving (reaches path end at departT + arrive)
  alive: boolean;
  deathT: number | null;
  deathPos: Vec2 | null;
  weapon: string;
  anchor: boolean;       // holding an angle vs moving
  holdDir: Vec2;         // unit heading an agent looks down once stationary
  form: number;          // match-night form: a duel edge constant for the whole match
  chem: number;          // team chemistry: a duel edge from the five's shared tenure (whole match)
  holdBonus: number;     // this agent's held-angle edge (0 unless anchoring; scaled by aggression)
  agentRole: Role;       // role of the fielded agent — decides the kit
  compEdge: number;      // duel edge from the agent's tier + the player's mastery
  utilFactor: number;    // utility multiplier from agent mastery
  exposedUntil: number;  // round-time until which this agent is trade-vulnerable after a kill
  hp: number;            // 100 at round start; a duel chips the WINNER too (attrition carries)
  armor: number;         // incoming-damage multiplier from the buy's shields (full 0.72 .. eco 1.0)
  pauses: { t: number; dur: number }[];   // halts mid-travel (won a fight); extend the journey
  fightFace: { from: number; until: number; dir: Vec2 } | null;   // focused down the kill line
  grazed: Record<string, number>;   // per-OPPONENT round-t until which this matchup is disengaged
                                    // (per-pair, not per-agent — an anchor who traded pokes with one
                                    // pusher still punishes the four walking past)
  // kill point: rotate here when the trigger fires (death's player resolved to a handle)
  rotatePlan: RotPlan | null;   // the ACTIVE kill-point step; firing advances to .then (the chain)
  // journeys COMPLETED before a mid-round re-path (kill-point rotation, post-plant
  // re-setup). Emission-only: during resolution t only moves forward past each
  // re-path, so posAt/facingAt always operate on the CURRENT leg's fields — these
  // exist so the move event can carry the full multi-leg story for the viewer.
  doneLegs: { path: Vec2[]; departT: number; arrive: number; pauses: { t: number; dur: number }[]; hold: Vec2 }[];
}

const ease = (p: number) => p * (2 - p);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a: Vec2, b: Vec2, f: number): Vec2 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

// Map scale normalization. SPEED is calibrated to Ascent, so on a larger map
// attackers reach site (and plant) before Ascent-speed rotations can land —
// the documented attacker-sidedness of far-apart-site maps. We derive each map's
// characteristic distance (mean attacker spawn→site, plus mean mid→site for the
// rotation leg) and scale movement speed by it, so a push and a rotation cost the
// same *fraction of the round* on every map as they do on Ascent. Pure geometry,
// no magic per-map numbers — and Ascent's scale is exactly 1, so seed 42 is
// byte-identical (every arrive time is multiplied by 1).
function charDist(a: MapAnchors): number {
  const pts = siteIds(a).map(s => siteAnchor(a, s));
  const mean = (ds: number[]) => ds.reduce((x, y) => x + y, 0) / ds.length;
  return mean(pts.map(p => dist(a.atkSpawn, p))) * 0.6 + mean(pts.map(p => dist(a.mid, p))) * 0.4;
}
const ASCENT_CHAR = charDist(ANCHORS.ascent!);
const mapScale = (a: MapAnchors): number => charDist(a) / ASCENT_CHAR;

/** A vision-blocking smoke and a first-shot-granting recon/flash pulse — the
 *  two ways utility reaches into a round. Both are pure geometry over time. */
interface Smoke { side: 0 | 1; c: Vec2; r: number; t0: number; t1: number; }
interface Pulse { side: 0 | 1; c: Vec2; r: number; t0: number; t1: number; }

function unit(from: Vec2, to: Vec2): Vec2 {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const d = Math.hypot(dx, dy) || 1;
  return [dx / d, dy / d];
}

/** Shortest distance from point c to segment a..b (for smoke-vs-sightline). */
function segDist(a: Vec2, b: Vec2, c: Vec2): number {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const ab2 = abx * abx + aby * aby || 1;
  const t = Math.max(0, Math.min(1, ((c[0] - a[0]) * abx + (c[1] - a[1]) * aby) / ab2));
  return Math.hypot(c[0] - (a[0] + abx * t), c[1] - (a[1] + aby * t));
}
/** Does a polyline `path` pass within `r` of point `c`? (a mover crossing a zone) */
function pathHitsZone(path: Vec2[], c: Vec2, r: number): boolean {
  for (let i = 0; i + 1 < path.length; i++) if (segDist(path[i], path[i + 1], c) <= r) return true;
  return false;
}

/** Total halted time inside `pauses` up to round-time t (pauses are sequential). */
function pausedTime(pauses: { t: number; dur: number }[], t: number): number {
  let s = 0;
  for (const p of pauses) s += Math.min(p.dur, Math.max(0, t - p.t));
  return s;
}

function posAt(a: Ag, t: number): Vec2 {
  if (a.deathT != null && t >= a.deathT) return a.deathPos!;
  if (t <= a.departT) return a.path[0];            // holding at start (e.g. a rotator on info-hold)
  // fight pauses freeze the journey: progress runs on travel time NET of halts
  const local = t - a.departT - (a.pauses.length ? pausedTime(a.pauses, t) : 0);
  return posAlong(a.path, ease(Math.min(1, Math.max(0, local) / a.arrive)));
}

/** Is the agent stationary at t — holding for info, arrived on their spot, or mid-pause?
 *  A SET shooter gets their weapon's full range identity (the scoped Op on the angle). */
function isSet(a: Ag, t: number): boolean {
  if (t <= a.departT) return true;
  const local = t - a.departT - (a.pauses.length ? pausedTime(a.pauses, t) : 0);
  if (local >= a.arrive) return true;
  return inPause(a, t);
}
/** Inside a post-kill recovery window (reloading / re-chambering / re-setting)? Fights
 *  during it carry RELOAD_PEN and forfeit the set-weapon bonus — the trade window's teeth. */
function inPause(a: Ag, t: number): boolean {
  for (const p of a.pauses) if (t >= p.t && t <= p.t + p.dur) return true;
  return false;
}

/** Where an agent is looking at time t: down the kill line for a beat after winning
 *  a fight (tunnel vision — flankable), down their travel vector while moving, and
 *  down their held angle (holdDir) while holding or once arrived. */
function facingAt(a: Ag, t: number): Vec2 {
  if (a.deathT != null && t >= a.deathT) return a.holdDir;
  if (a.fightFace && t >= a.fightFace.from && t <= a.fightFace.until) return a.fightFace.dir;
  const moveEnd = a.departT + a.arrive + (a.pauses.length ? pausedTime(a.pauses, t) : 0);
  if (t > a.departT && t < moveEnd - 1e-6) {
    const here = posAt(a, t);
    const ahead = posAt(a, Math.min(moveEnd, t + STEP));
    const dx = ahead[0] - here[0], dy = ahead[1] - here[1];
    if (Math.hypot(dx, dy) > 1e-6) return unit(here, ahead);
  }
  return a.holdDir;
}

function jitter(rng: Rng, p: Vec2, amt: number): Vec2 {
  return [p[0] + rng.range(-amt, amt), p[1] + rng.range(-amt, amt)];
}

function arriveTime(path: Vec2[], speedMul = 1): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += dist(path[i - 1], path[i]);
  return Math.max(0.1, Math.min(0.92, 0.1 + len / (SPEED * speedMul)));
}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Attack site-choice weights from the siteBias dial, generalized to N sites.
 *  Two-site reduces EXACTLY to the original `pA = 0.5 + bias·0.42` (clamped), so
 *  the single rng draw and its result are unchanged — seed 42 stays byte-identical.
 *  For three sites the bias tilts linearly: +1 favours A, −1 the last site, 0 even. */
function siteWeights(bias: number, n: number): number[] {
  if (n <= 2) { const pA = clampN(0.5 + bias * 0.42, 0.08, 0.92); return [pA, 1 - pA]; }
  const k = 0.30, w: number[] = [];
  for (let i = 0; i < n; i++) { const pos = (i / (n - 1)) * 2 - 1; w.push(Math.max(0.06, 1 / n - bias * k * pos)); }
  const s = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / s);
}

/** Pick an index from weights with ONE rng draw (cumulative walk). For two
 *  weights `[p, 1−p]` this is exactly `rng.chance(p) ? 0 : 1` — same draw. */
function pickWeighted(weights: number[], rng: Rng): number {
  let u = rng.next();
  for (let i = 0; i < weights.length; i++) { if (u < weights[i]) return i; u -= weights[i]; }
  return weights.length - 1;
}

/** Map the read dial (−1..+1) to a defended site index. Two-site keeps the exact
 *  original `read ≥ 0 ? A : B`; for N sites it spans read +1→A .. −1→last site. */
function readIndex(read: number, n: number): number {
  if (n <= 2) return read >= 0 ? 0 : 1;
  return clampN(Math.round((1 - read) / 2 * (n - 1)), 0, n - 1);
}

/** Resolve one attacker-vs-defender duel. Returns whether the attacker wins AND
 *  the probability it did (so the caller can scale the winner's return damage —
 *  a dominant duel is near-free, a coin flip leaves the victor hurting).
 *  `surprise` is the signed advantage edge: +ve favours the attacker (saw first
 *  / pulse / trade), -ve favours the defender. A WOUNDED fighter duels worse
 *  (WOUND_PEN per missing HP) — attrition carries between fights. */
function duel(rng: Rng, atk: Ag, def: Ag, surprise: number, holdEdge: number, range = 100, atkSet = true, defSet = true, atkReload = false, defReload = false, atkCover = 0, defCover = 0): { atkWins: boolean; p: number } {
  const A = atk.p.attr, D = def.p.attr;
  // .form is match-night; .compEdge is the fielded agent (tier + mastery); rangeEdge is
  // the weapon's identity at this distance (a SET Op owns the long angle, a Spectre the
  // rush); a mid-RECOVERY fighter (reloading after a kill) duels at RELOAD_PEN; cover
  // (0..1, only ever set for a SET fighter) is how little body they expose
  const atkEdge = A.aim * 0.45 + A.gameSense * 0.30 + A.entry * 0.25 + TIER[atk.weapon] * 4 + rangeEdge(atk.weapon, range, atkSet) + atkCover * COVER_EDGE + atk.form + atk.compEdge + atk.chem - (100 - atk.hp) * WOUND_PEN - (atkReload ? RELOAD_PEN : 0);
  const defEdge = D.aim * 0.45 + D.gameSense * 0.35 + D.clutch * 0.20 + TIER[def.weapon] * 4 + rangeEdge(def.weapon, range, defSet) + defCover * COVER_EDGE + def.form + def.compEdge + def.chem - (100 - def.hp) * WOUND_PEN - (defReload ? RELOAD_PEN : 0);
  // holdEdge > 0 favours the defender (pre-plant anchor); < 0 favours the attacker (post-plant crossfire)
  const noise = rng.range(-13, 13);
  const p = sigmoid((atkEdge - defEdge - holdEdge + surprise + noise) / 18);
  return { atkWins: rng.chance(p), p };
}

function pickWeapon(rng: Rng, buy: Buy, role: string): string {
  const pool = WEAPONS[buy];
  return rng.pick(pool);
}

const FORKS = 120;         // counterfactual re-runs per round → its true odds
// a stable, match-independent seed for fork (n, i); never drawn from the match rng
function forkSeed(seed: number, n: number, i: number): number {
  return ((seed * 0x9e3779b1) ^ (n * 0x85ebca77) ^ ((i + 1) * 0xc2b2ae3d)) >>> 0;
}

/** Resolve a round from a fixed setup with a given rng: the tick loop, plant,
 *  and terminal conditions. Pure over (agents, smokes, pulses, rng) — so the
 *  same setup can be replayed on throwaway rng to measure its odds. Agents are
 *  mutated (alive/death), so callers pass a throwaway copy for forks. */
function resolveRound(
  agents: Ag[], smokes: Smoke[], pulses: Pulse[], nav: Navmesh,
  sitePt: Vec2, site: SiteId, attacker: 0 | 1, defender: 0 | 1, scale: number, rng: Rng,
): { winner: 0 | 1; method: RoundMethod; events: MatchEvent[] } {
  // work on a PER-RUN copy of the smokes: the retake smoke below is planned at
  // plant time, and pushing it into the shared setup array would leak one run's
  // smoke into every other fork + the canonical pass (the fork-hygiene rule).
  smokes = smokes.slice();
  // a smoke is directional: it blinds the ENEMY's vision through it, not the
  // side that threw it (you play around your own smoke).
  const blindedThrough = (viewer: 0 | 1, p1: Vec2, p2: Vec2, t: number): boolean =>
    smokes.some(s => s.side !== viewer && t >= s.t0 && t <= s.t1 && segDist(p1, p2, s.c) <= s.r);
  const pulseFor = (s: 0 | 1, p: Vec2, t: number): boolean =>
    pulses.some(u => u.side === s && t >= u.t0 && t <= u.t1 && dist(p, u.c) <= u.r);
  const atk = () => agents.filter(a => a.side === attacker && a.alive);
  const def = () => agents.filter(a => a.side === defender && a.alive);

  const events: MatchEvent[] = [];
  let planted = false, plantBy = '';
  let detonateAt = Infinity;
  let plantPos: Vec2 | null = null, defuseStart = -1;
  let spikeRunner: Ag | null = null;   // the defender assigned to actually get on the spike
  let winner: 0 | 1 | null = null;
  let method: RoundMethod = 'time';
  let hadKill = false, contactT = Infinity;

  // begin a NEW movement leg mid-round: the finished journey is archived on
  // doneLegs (so the move event can carry the multi-leg story), then the agent's
  // live fields become the new leg. Pauses start clean (the old halts are spent).
  const beginLeg = (ag: Ag, path: Vec2[], t: number, speed: number, hold?: Vec2) => {
    ag.doneLegs.push({ path: ag.path, departT: ag.departT, arrive: ag.arrive, pauses: ag.pauses, hold: ag.holdDir });
    ag.path = path; ag.departT = t; ag.arrive = arriveTime(path, speed); ag.pauses = [];
    if (hold) ag.holdDir = hold;
  };
  // release an authored kill-point rotation: walk the authored route verbatim,
  // else A* the way; reuses the departT hold-then-move machinery.
  const fireRotation = (ag: Ag, t: number) => {
    const rp = ag.rotatePlan!, here = posAt(ag, t);
    beginLeg(ag, rp.route?.length ? [here, ...rp.route, rp.pos] : pathfind(nav, here, rp.pos), t, ROTATE_SPEED * scale);
    ag.rotatePlan = rp.then ?? null;   // an N-step chain arms its next step; a single step ends
  };

  // still mid-journey at t (a pause only makes sense for someone with ground left to cover)
  const midTravel = (ag: Ag, t: number) => ag.departT !== Infinity && t > ag.departT && t - ag.departT - pausedTime(ag.pauses, t) < ag.arrive;

  const resolvedThisStep = new Set<string>();
  for (let t = 0; t <= 1 + 1e-9; t += STEP) {
    resolvedThisStep.clear();

    // contact: the defense learns the hit on the first kill or the first attacker
    // reaching the site — only then do the info-held rotators commit and rotate.
    if (contactT === Infinity && (hadKill || atk().some(a => dist(posAt(a, t), sitePt) < SITE_R))) {
      contactT = t;
      for (const ag of agents) if (ag.departT === Infinity) ag.departT = t;
    }

    // authored kill points keyed to contact or the clock (death-keyed ones fire
    // in the kill loop below). Time triggers are the staggered-hold timing lever.
    for (const ag of agents) {
      if (!ag.alive || !ag.rotatePlan) continue;
      const tr = ag.rotatePlan.trigger;
      if ((tr.kind === 'contact' && contactT !== Infinity) || (tr.kind === 'time' && t >= tr.t)) fireRotation(ag, t);
    }

    const liveA = atk(), liveD = def();

    // engagements: a pair only fights if at least one sees the other. Whoever
    // spots an unaware enemy first carries a decisive first-shot advantage.
    for (const a of liveA) {
      if (!a.alive) continue;
      const pa = posAt(a, t), fa = facingAt(a, t);
      for (const d of liveD) {
        if (!d.alive || resolvedThisStep.has(d.handle) || resolvedThisStep.has(a.handle)) continue;
        if ((a.grazed[d.handle] ?? -1) >= t) continue;   // this matchup traded pokes — briefly reset
        const pd = posAt(d, t);
        const range = dist(pa, pd);
        if (range > ENGAGE) continue;
        const fd = facingAt(d, t);
        const aSeesD = !blindedThrough(attacker, pa, pd, t) && inView(nav, pa, fa, pd, ENGAGE, FOV);
        const dSeesA = !blindedThrough(defender, pd, pa, t) && inView(nav, pd, fd, pa, ENGAGE, FOV);
        if (!aSeesD && !dSeesA) continue;              // mutual blindside, no LOS, or both smoked — no fight
        let surprise = aSeesD === dSeesA ? 0 : (aSeesD ? FIRST_SHOT : -FIRST_SHOT);
        // recon/flash overrides who gets the first shot inside its pulse
        const atkPulse = pulseFor(attacker, pd, t), defPulse = pulseFor(defender, pa, t);
        if (atkPulse && !defPulse) surprise = FIRST_SHOT;
        else if (defPulse && !atkPulse) surprise = -FIRST_SHOT;
        // trade: a teammate punishes a just-exposed killer they can see — the
        // single biggest reason spacing and support play matter. A moderate edge
        // that never weakens an already-larger advantage the same way.
        const aCanTrade = d.exposedUntil >= t && aSeesD;
        const dCanTrade = a.exposedUntil >= t && dSeesA;
        if (aCanTrade && !dCanTrade) surprise = Math.max(surprise, TRADE_EDGE);
        else if (dCanTrade && !aCanTrade) surprise = Math.min(surprise, -TRADE_EDGE);
        // pre-plant the defender holds the angle; post-plant the attacker holds the crossfire
        const holdEdge = planted ? -POSTPLANT_HOLD : d.holdBonus;
        // recovery state: a fighter mid-reload after a kill loses their set-weapon bonus
        // (you're not scoped while re-chambering) and duels at a penalty
        const aReload = inPause(a, t), dReload = inPause(d, t);
        // COVER: a SET fighter tucked at a corner exposes only a sliver of body — the
        // POSITION, not just the angle, wins fights. Gated to SET (you use cover when
        // holding a spot, never sprinting past a wall), so it rewards CHOSEN positions:
        // procedural holds near geometry and authored plays hugging a corner. Pure
        // geometry, no rng draws — the stream shifts only where a duel probability flips.
        const aSet = isSet(a, t), dSet = isSet(d, t);
        const aCov = aSet ? coverOf(nav, pd, pa) : 0;
        const dCov = dSet ? coverOf(nav, pa, pd) : 0;
        const { atkWins, p } = duel(rng, a, d, surprise, holdEdge, range, aSet && !aReload, dSet && !dReload, aReload, dReload, aCov, dCov);
        // a CLOSE duel can break off without a kill: both trade shots, take damage, and
        // disengage for a beat, watching each other. The wounds make the NEXT exchange
        // deadlier (WOUND_PEN), so firefights escalate: poke → poke → kill. URGENCY:
        // the graze chance fades as the clock runs down — late-round fights are committed
        // (players can't afford to reset), which is realistic AND keeps rounds from
        // stalling out (grazes at t>0.7 pushed lotus to 17% time-expiry).
        const closeness = Math.pow(1 - 2 * Math.abs(p - 0.5), 0.4);   // soft curve — mid-edge duels poke too
        const urgency = Math.max(0, 1 - t * 1.6);   // pokes fade as the clock runs — late fights commit
        // fights AT the site are all-in (an execute can't reset) — only map-control pokes
        // graze. This is what keeps plant timings honest (lotus stalled at 14-17% otherwise).
        const nearSite = dist(pa, sitePt) < SITE_R * 1.5 || dist(pd, sitePt) < SITE_R * 1.5;
        if (!nearSite && rng.chance(GRAZE_MAX * closeness * urgency)) {
          // graze damage carries the SHOOTER's weapon AND aim, absorbed by the TARGET's
          // armor (all post-draw scales, same rng count): an Op body-shot poke hurts, a
          // sharp-aim poke tags heads, heavy shields shrug off the chip
          const dmgD = Math.round(rng.range(GRAZE_LO, GRAZE_HI) * (W_DMG[a.weapon] ?? 1) * (0.8 + a.p.attr.aim * 0.004) * d.armor);
          const dmgA = Math.round(rng.range(GRAZE_LO, GRAZE_HI) * (W_DMG[d.weapon] ?? 1) * (0.8 + d.p.attr.aim * 0.004) * a.armor);
          d.hp = Math.max(1, d.hp - dmgD); a.hp = Math.max(1, a.hp - dmgA);
          a.grazed[d.handle] = t + GRAZE_COOL; d.grazed[a.handle] = t + GRAZE_COOL;
          a.fightFace = { from: t, until: t + GRAZE_FACE, dir: unit(pa, pd) };
          d.fightFace = { from: t, until: t + GRAZE_FACE, dir: unit(pd, pa) };
          // a badly wounded survivor doesn't push on — he BREAKS OFF to the nearest
          // cover and posts up WATCHING THE ENEMY HE JUST FOUGHT (a known, near
          // watch reference — the exchange told him exactly where the threat is).
          // A new movement LEG (multi-leg contract): the retreat abandons his old
          // goal, a real behavioural cost. With no wall in reach he just hesitates
          // (the original hitch). Zero new rng draws — pure geometry.
          // (the retreat bar sits DEEPER than the hesitation bar — at 35 the
          // graze-heavy maps bled attackers off the push: split 44.1→41.3)
          const retreat = (w: Ag, pw: Vec2, threat: Vec2) => {
            const spot = w.hp < RETREAT_HP ? seekCover(nav, pw, threat, 30) : pw;
            if (spot !== pw) beginLeg(w, [pw, spot], t, scale, unit(spot, threat));
            else w.pauses.push({ t, dur: WOUND_PAUSE });
          };
          if (a.hp < WOUNDED_HP && midTravel(a, t)) retreat(a, pa, pd);
          if (d.hp < WOUNDED_HP && midTravel(d, t)) retreat(d, pd, pa);
          resolvedThisStep.add(a.handle); resolvedThisStep.add(d.handle);
          events.push({ t, kind: 'dmg', from: a.handle, to: d.handle, dmg: dmgD, hp: d.hp });
          events.push({ t, kind: 'dmg', from: d.handle, to: a.handle, dmg: dmgA, hp: a.hp });
          break;
        }
        const loser = atkWins ? d : a;
        const winnerAg = atkWins ? a : d;
        // capture the death spot BEFORE marking dead — posAt short-circuits to deathPos
        // once deathT is set, so the old order left deathPos null forever (latent; never
        // read until the fight-facing below needed it)
        const lPos = posAt(loser, t);
        loser.alive = false; loser.deathT = t; loser.deathPos = lPos;
        winnerAg.exposedUntil = t + TRADE_WINDOW;      // the killer is now tradeable
        // the fight COSTS the winner (actual players, not a coin toss):
        // 0) HEADSHOT roll — the winner's AIM + dominance decide if it was a clean one-tap
        //    (drawn BEFORE the chip so the chip can shrink; fixed draw order for determinism)
        const q = atkWins ? p : 1 - p;                 // the winner's own win probability
        const wAim = winnerAg.p.attr.aim;
        const hs = rng.chance(Math.max(0.02, Math.min(0.75, HS_BASE + (wAim - 65) * HS_AIM + (q - 0.5) * HS_DOM)));
        // 1) return damage scaled by how contested it was — a dominant duel is near-free,
        //    a coin flip leaves the victor hurting; the wound carries into the next fight.
        //    Scaled by the LOSER's weapon (beating an eco Classic is near-free, a rifle
        //    sprays back), shrunk by the winner's AIM (sharp aim finishes fights faster),
        //    and near-zero on a headshot (the loser never got to shoot back).
        const chipScale = (hs ? HS_CHIP : 1) * (1.3 - wAim * 0.005) * (W_DMG[loser.weapon] ?? 1) * winnerAg.armor;
        winnerAg.hp = Math.max(5, winnerAg.hp - Math.round(Math.min(92, rng.range(CHIP_LO, CHIP_HI) * (1 - q) * 1.8 * chipScale)));
        // 2) a beat stationary at the kill spot (fights take time) — the push arrives
        //    later, and a fresh killer is a known, standing target for the trade window.
        //    The RECOVERY scales with the gun (rate of fire made real): an Op re-chambers,
        //    an SMG is instantly ready — and fights during it carry RELOAD_PEN.
        const wPos = posAt(winnerAg, t);
        if (midTravel(winnerAg, t)) {
          // the recovery beat, extended when the winner came out badly hurt (playing
          // hurt). A winner-side RETREAT was tried here and MEASURED HARMFUL (split
          // 42.9→41.6, ascent stalls 1→4%): unlike the graze survivor, the winner's
          // immediate threat is DEAD — breaking off the push after winning is bad
          // play, and the model correctly priced it. Don't re-add.
          winnerAg.pauses.push({ t, dur: FIGHT_PAUSE * (W_HANDLING[winnerAg.weapon] ?? 1) + (winnerAg.hp < WOUNDED_HP ? WOUND_PAUSE : 0) });
        }
        // 3) tunnel vision down the kill line — realistically flankable from behind
        const ffDir = dist(wPos, loser.deathPos!) > 1e-6 ? unit(wPos, loser.deathPos!) : facingAt(winnerAg, t);
        winnerAg.fightFace = { from: t, until: t + FIGHT_FACE, dir: ffDir };
        hadKill = true;                                 // first blood = info for the defense
        // kill point: teammates whose death-trigger names this victim rotate now
        for (const ag of agents) {
          if (ag.alive && ag.rotatePlan?.trigger.kind === 'death' && ag.rotatePlan.trigger.handle === loser.handle) fireRotation(ag, t);
        }
        resolvedThisStep.add(a.handle); resolvedThisStep.add(d.handle);
        events.push({ t, kind: 'kill', killer: winnerAg.handle, victim: loser.handle, weapon: winnerAg.weapon, hp: winnerAg.hp, ...(hs ? { hs: true } : {}) });
        break;
      }
    }

    // plant: an attacker controls the site
    if (!planted) {
      const atkAtSite = atk().filter(a => dist(posAt(a, t), sitePt) < PLANT_R);
      const defAtSite = def().filter(d => dist(posAt(d, t), sitePt) < SITE_R);
      if (atkAtSite.length >= 1 && (defAtSite.length === 0 || (t > 0.5 && atk().length > def().length))) {
        planted = true; plantBy = atkAtSite[0].handle; plantPos = posAt(atkAtSite[0], t);
        detonateAt = Math.min(0.99, t + SPIKE_TIME);
        events.push({ t, kind: 'plant', agent: plantBy, site });
        // RETAKE SMOKE: a defense controller with kit to spare has SAVED one for
        // exactly this — it blooms a beat after the plant ON THE RETAKE LANE (between
        // the planted spike and where the retakers actually are), cutting the
        // attackers' held sightlines onto the incoming push (defender-side, so it
        // blinds the attackers through it, never the retakers — blindedThrough holds).
        // NOT on the spike itself: that placement was tried and BACKFIRED (it shielded
        // the post-plant attackers from being acquired, fights never fired, and the
        // clock ran to detonation — bind jumped +6 ATK). PLANNED, not thrown: centre/
        // time/reach are pure functions of the plant + the live defenders + the
        // caster's utility (zero new rng draws), and it lives on the per-run smokes
        // copy so every fork plans its own and the shared setup array is untouched.
        const liveDef = def();
        let mdx = 0, mdy = 0;
        for (const d2 of liveDef) { const p2 = posAt(d2, t); mdx += p2[0]; mdy += p2[1]; }
        const meanDef: Vec2 | null = liveDef.length ? [mdx / liveDef.length, mdy / liveDef.length] : null;
        const ctrl = liveDef.find(d2 => d2.agentRole === 'controller');
        if (ctrl && meanDef) {
          const cu = (ctrl.p.attr.utility / 100) * ctrl.utilFactor;
          if (cu >= RETAKE_SMOKE_U) {
            const lane: Vec2 = lerp(plantPos, meanDef, 0.45);
            const rt0 = t + RETAKE_DELAY, rr = RESMOKE_R + RESMOKE_R_UTIL * cu;
            const rt1 = rt0 + RESMOKE_DUR + RESMOKE_DUR_UTIL * cu;
            smokes.push({ side: defender, c: lane, r: rr, t0: rt0, t1: rt1 });
            events.push({ t: rt0, kind: 'ability', agent: ctrl.handle, ability: 'smoke', side: defender, at: lane, r: rr, until: rt1 });
          }
        }
        // NOTE: a post-plant RE-FAN was tried here (attackers re-positioning to
        // cover at plant time) and MEASURED NULL-TO-HARMFUL in every variant
        // (meanDef facing 39.0 / face-only 37.0 / keep-facing 40.0 / watch-spike
        // 40.3 on split, vs 44.1 without) — because the model already does the
        // right thing: the planter RESUMES his journey to his setup-tucked fan
        // spot after planting, and those spots were cover-seeked with a good
        // near watch reference at setup. Re-fanning replaced well-chosen
        // destinations with ones built off a far, probe-degraded reference.
        // Don't re-add without new evidence.
      }
    }

    // retake: post-plant, a defender who reaches the spike with no attacker
    // contesting the site channels a defuse — defenders must clear it, then hold it.
    if (planted && plantPos) {
      const defuser = def().find(d => dist(posAt(d, t), plantPos!) < DEFUSE_R);
      const contested = atk().some(a => dist(posAt(a, t), plantPos!) < SITE_R);
      // THE SPIKE RUNNER (multi-leg): retakers converge on the SITE, but somebody
      // has to actually get on the spike. Once the site is CLEARED (not contested)
      // and nobody stands in defuse range, the nearest live defender walks to it —
      // re-assigned if he falls. Deterministic (nearest by distance), zero rng.
      if (!contested && !defuser && (!spikeRunner || !spikeRunner.alive)) {
        let best: Ag | null = null, bd = Infinity;
        for (const d of def()) {
          const dd = dist(posAt(d, t), plantPos!);
          if (dd < SITE_R * 1.5 && dd < bd) { best = d; bd = dd; }
        }
        if (best) {
          beginLeg(best, pathfind(nav, posAt(best, t), plantPos!), t, scale);
          spikeRunner = best;
        }
      }
      if (defuser && !contested) {
        if (defuseStart < 0) defuseStart = t;
        if (t - defuseStart >= DEFUSE_TIME) {
          events.push({ t, kind: 'defuse', agent: defuser.handle });
          winner = defender; method = 'defuse'; break;
        }
      } else {
        defuseStart = -1;   // contested or stepped off — channel interrupted
      }
    }

    // terminal conditions
    if (def().length === 0) { winner = attacker; method = planted ? 'detonation' : 'elimination'; break; }
    if (atk().length === 0) { winner = defender; method = planted ? 'defuse' : 'elimination'; break; }
    if (planted && t >= detonateAt) { winner = attacker; method = 'detonation'; break; }
    if (t >= 1) { winner = planted ? attacker : defender; method = planted ? 'detonation' : 'time'; break; }
  }
  if (winner === null) { winner = planted ? attacker : defender; method = planted ? 'detonation' : 'time'; }

  return { winner, method, events };
}

function simulateRound(
  rng: Rng, input: MatchInput, nav: Navmesh, n: number, attacker: 0 | 1,
  creds: Record<'0' | '1', number>, lossStreak: Record<'0' | '1', number>,
  form: Map<string, number>, loadouts: Map<string, Loadout>, atkTac: Tactics, defTac: Tactics,
  forks: number,
): Round {
  const defender: 0 | 1 = attacker === 0 ? 1 : 0;
  const A = ANCHORS[input.map]!;
  const scale = mapScale(A);   // normalize movement to Ascent's timing (1.0 on Ascent)
  const pistol = n === 1 || n === 13;

  // the buy is the IN-GAME LEADER's call (not the manager's) — its quality scales with
  // the IGL's economic acumen, so a sharp caller's team runs a tighter economy.
  const buy: Record<'0' | '1', Buy> = {
    '0': pistol ? 'pistol' : decideBuy(creds['0'], creds['1'], lossStreak['0'], iglEco(input.teams[0])),
    '1': pistol ? 'pistol' : decideBuy(creds['1'], creds['0'], lossStreak['1'], iglEco(input.teams[1])),
  };

  // attackers pick a site (A/B, or A/B/C on a three-site map), weighted by their
  // plan's site bias — unless an authored attack play declares the site it
  // executes (then that's forced). The weighted pick draws one rng value; on a
  // two-site map it reduces exactly to the original A/B coin-flip.
  const SITES = siteIds(A);
  const site: SiteId = atkTac.attack.play?.site ?? SITES[pickWeighted(siteWeights(atkTac.attack.siteBias, SITES.length), rng)];
  const sitePt = siteAnchor(A, site);
  // the lurk flanks the off-site = the fielded site whose anchor is farthest from
  // the target (the other one on a two-site map; the far site on a three-site map)
  const otherSite = SITES.filter(s => s !== site).sort((a, b) => dist(siteAnchor(A, b), sitePt) - dist(siteAnchor(A, a), sitePt))[0] ?? site;
  const otherPt = siteAnchor(A, otherSite);

  const atkTeam = input.teams[attacker];
  const defTeam = input.teams[defender];
  const chemEdge: [number, number] = [teamChem(input.teams[0].players), teamChem(input.teams[1].players)];
  const agents: Ag[] = [];

  // per-player attack roles (the manager's plan, beyond the team dials): the
  // ENTRY leads the push (arrives first, takes opening contact); the LURK peels
  // to a flank and holds for picks on rotators + a late man-advantage. Entry
  // defaults to the best opening duelist; lurk only if the plan names one.
  const entryId = atkTac.attack.entry ?? bestEntry(atkTeam);
  const lurkId = atkTac.attack.lurk;
  const lurkPt = lerp(A.mid, otherPt, 0.4);     // a flank hold between mid and the off-site

  // attackers: stack at spawn, execute the chosen site. Tempo sets the pace —
  // a fast hit reaches site sooner; a slow default arrives later (more map control).
  const atkSpeed = (0.8 + atkTac.attack.tempo * 0.5) * scale;
  if (atkTac.attack.play) {
    // AUTHORED execute: each attacker walks an authored route to a placed spot,
    // watches an authored angle, and can carry a push trigger (death/contact/time
    // — e.g. a lurk that flanks on a teammate's death). Like authored defenders,
    // an unrouted attacker is A*'d to its spot; a routed one is walked verbatim.
    const byIdA = new Map(atkTeam.players.map(p => [p.id, p] as const));
    atkTeam.players.forEach((p, i) => {
      const plan = atkTac.attack.play!.plans.find(q => q.player === p.id);
      const pos = plan ? plan.pos : sitePt;                 // unplanned players push the site
      const lo = loadouts.get(p.handle)!;
      const spawn: Vec2 = [A.atkSpawn[0] + (i - 2) * 14, A.atkSpawn[1]];  // deterministic spread, no rng
      const route = plan?.route?.length ? plan.route : null;
      const path = route ? [spawn, ...route, pos] : pathfind(nav, spawn, pos);
      const isEntry = p.id === entryId;
      const rotChain = resolveChain(plan?.rotate, byIdA);
      agents.push({
        p, side: attacker, handle: p.handle, path, departT: 0,
        arrive: arriveTime(path, isEntry ? atkSpeed * 1.15 : atkSpeed),
        alive: true, deathT: null, deathPos: null,
        weapon: pickWeapon(rng, buy[String(attacker) as '0' | '1'], p.role), anchor: false,
        holdDir: plan?.face ? unit(pos, plan.face) : unit(spawn, pos),  // authored angle, else face the push
        exposedUntil: -1, hp: 100, armor: ARMOR_MUL[buy[String(attacker) as '0' | '1']], pauses: [], fightFace: null, grazed: {}, doneLegs: [],
        rotatePlan: rotChain,
        form: form.get(p.handle) ?? 0, chem: chemEdge[attacker], holdBonus: 0,
        agentRole: lo.role, compEdge: lo.compEdge, utilFactor: lo.utilFactor,
      });
    });
  } else {
    // PROCEDURAL execute: the pushers FAN across the site entry (distinct angles, not
    // a stack on one point), staged by role — the entry leads deep and fast, duelists
    // hit the spread, the controller + sentinel trail a beat behind to lob utility and
    // watch the flank. This is how the hit READS on the map: a coordinated, layered
    // spread instead of a blob of overlapping bodies/cones. Symmetric (both sides), so
    // the pool stays balanced; jitter count is unchanged so setup rng doesn't desync.
    const approach = unit(A.atkSpawn, sitePt);
    const perp: Vec2 = [-approach[1], approach[0]];
    const pushers = atkTeam.players.filter(p => p.id !== lurkId);
    const np = Math.max(1, pushers.length);
    atkTeam.players.forEach(p => {
      const isLurk = p.id === lurkId;
      const isEntry = !isLurk && p.id === entryId;
      const lo = loadouts.get(p.handle)!;
      const support = lo.role === 'controller' || lo.role === 'sentinel';
      const spawn = jitter(rng, A.atkSpawn, 18);
      let goal: Vec2;
      if (isLurk) {
        goal = jitter(rng, lurkPt, 28);
      } else {
        const k = pushers.indexOf(p);
        const lat = (k - (np - 1) / 2) * ATK_SPREAD;          // fan left..right across the entry
        const depth = support ? -16 : 0;                      // support eases back a touch to lob util from range
        goal = jitter(rng, [sitePt[0] + perp[0] * lat + approach[0] * depth, sitePt[1] + perp[1] * lat + approach[1] * depth], 12);
      }
      // a real player never stops mid-open-ground: each spot tucks to the nearest
      // wall that keeps its lane toward the site (post-jitter, no rng — deterministic
      // geometry), so the fan hits from covered angles and EARNS the set cover edge.
      // Attackers only — defender tucks were tried three ways (spawn/mid/room watch
      // references) and each broke the pool (split DEF-SIDED 37-38, breeze swinging):
      // the procedural defense's balance LIVES in its tuned positions (the DEF_SPREAD
      // lesson). Defenders still earn cover where their spots already touch geometry.
      goal = seekCover(nav, goal, sitePt);
      const path = pathfind(nav, spawn, goal);
      // the entry leads (15% faster), as before — the fan is positional, not a tempo change
      const speedMul = isEntry ? 1.15 : 1.0;
      agents.push({
        p, side: attacker, handle: p.handle, path, departT: 0,
        arrive: arriveTime(path, atkSpeed * speedMul),
        alive: true, deathT: null, deathPos: null,
        weapon: pickWeapon(rng, buy[String(attacker) as '0' | '1'], p.role), anchor: false,
        // the lurker holds toward the fight (catches unaware rotators); others push to site
        holdDir: isLurk ? unit(goal, sitePt) : unit(spawn, goal),
        exposedUntil: -1, rotatePlan: null, hp: 100, armor: ARMOR_MUL[buy[String(attacker) as '0' | '1']], pauses: [], fightFace: null, grazed: {}, doneLegs: [],
        form: form.get(p.handle) ?? 0, chem: chemEdge[attacker], holdBonus: 0,
        agentRole: lo.role, compEdge: lo.compEdge, utilFactor: lo.utilFactor,
      });
    });
  }

  const dAgg = defTac.defense.aggression;
  if (defTac.defense.play) {
    // AUTHORED play: defenders hold exactly where the owner placed them, watch an
    // optional authored angle, walk an optional route to get there, and a kill
    // point re-routes them when its trigger (a death / contact / time) fires.
    const byId = new Map(defTeam.players.map(p => [p.id, p] as const));
    defTeam.players.forEach(p => {
      const plan = defTac.defense.play!.plans.find(q => q.player === p.id);
      const pos = plan ? plan.pos : sitePt;                  // unplanned players hold the site
      const lo = loadouts.get(p.handle)!;
      // a route is the waypoints walked into the hold; [...route, pos] is the full
      // path. No route = start already set on the hold (the original behaviour).
      const route = plan?.route?.length ? plan.route : null;
      const path = route ? [...route, pos] : [pos];
      // resolve the kill-point trigger; a death trigger's player id → a handle
      const rotChain = resolveChain(plan?.rotate, byId);
      agents.push({
        p, side: defender, handle: p.handle, path, departT: 0,
        arrive: route ? arriveTime(path, scale) : 0.12,     // a longer route = set up later
        alive: true, deathT: null, deathPos: null,
        weapon: pickWeapon(rng, buy[String(defender) as '0' | '1'], p.role), anchor: true,
        // watch the authored angle if given, else default to facing the attacker spawn
        holdDir: plan?.face ? unit(pos, plan.face) : unit(pos, A.atkSpawn),
        form: form.get(p.handle) ?? 0, chem: chemEdge[defender],
        holdBonus: HOLD_BONUS * (1 - dAgg * 0.6),
        agentRole: lo.role, compEdge: lo.compEdge, utilFactor: lo.utilFactor,
        exposedUntil: -1, hp: 100, armor: ARMOR_MUL[buy[String(defender) as '0' | '1']], pauses: [], fightFace: null, grazed: {}, doneLegs: [],
        rotatePlan: rotChain,
      });
    });
  } else {
    // PROCEDURAL: defenders set up on their READ, not the actual site — a wrong
    // read is paid for in rotation time. Stack hardens the read; one watcher
    // takes each other site; aggression pushes the rest forward to mid. On a
    // three-site map the read spans all three, so a wrong read can be two
    // rotations away. Two-site reduces exactly to the original A/off/mid split.
    const readSite = SITES[readIndex(defTac.defense.read, SITES.length)];
    const otherSites = SITES.filter(s => s !== readSite);   // each gets one watcher, in order
    // (a 3-site read-stack floor of 2 was tried against haven/lotus's ATK lean and
    // made BOTH worse — 60.9→68.4 / 62→65: a 3-site read is right only ~1/3 of the
    // time, so extra commit mostly pays the wrong-read rotation tax; the mid pool IS
    // the three-site flexibility. Their fix is per-map anchor work, not this split.)
    const onRead = Math.max(1, Math.min(3, 1 + Math.round(Math.abs(defTac.defense.read) * 2)));
    const rotSpeed = ROTATE_SPEED * iglRotateMul(defTeam) * scale;   // sharp IGL + map-scale normalized
    const fwd = lerp(A.mid, A.atkSpawn, dAgg * 0.3);   // aggressive mids hold forward toward contact
    const slots: { from: Vec2; site: SiteId | 'M' }[] = [];
    // NOTE: defenders deliberately do NOT cover-seek. It was tried three ways (spawn /
    // mid / own-room watch references) and every variant broke the pool — split sank
    // DEF-SIDED (37-38), breeze swung ATK or STALLY — because the procedural defense's
    // BALANCE lives in its tuned positions (the DEF_SPREAD lesson again: defenders
    // fight FROM their hold, so any engine reposition re-tunes every map at once).
    // Defenders still EARN the cover edge wherever their tuned spots already touch
    // geometry; only attackers (below) actively tuck.
    for (let i = 0; i < onRead; i++) slots.push({ from: jitter(rng, siteAnchor(A, readSite), 30), site: readSite });
    for (const os of otherSites) slots.push({ from: jitter(rng, siteAnchor(A, os), 30), site: os });
    for (let i = 0; i < 5 - onRead - otherSites.length; i++) slots.push({ from: jitter(rng, fwd, 34), site: 'M' });
    defTeam.players.forEach((p, i) => {
      const st = slots[i];
      const anchor = st.site === site;            // already on the contested site = holding an angle
      const goal = anchor ? jitter(rng, sitePt, 26) : jitter(rng, sitePt, 44);
      const path = pathfind(nav, st.from, goal);
      const lo = loadouts.get(p.handle)!;
      agents.push({
        p, side: defender, handle: p.handle, path,
        // anchors are set from the start; rotators HOLD their read until contact,
        // then rotate with purpose — so a wrong read is paid for in real info time
        departT: anchor ? 0 : Infinity,
        arrive: anchor ? 0.12 : arriveTime(path, rotSpeed),
        alive: true, deathT: null, deathPos: null,
        weapon: pickWeapon(rng, buy[String(defender) as '0' | '1'], p.role), anchor,
        holdDir: unit(anchor ? goal : st.from, A.atkSpawn),  // hold toward the entry from where they sit
        form: form.get(p.handle) ?? 0, chem: chemEdge[defender],
        holdBonus: anchor ? HOLD_BONUS * (1 - dAgg * 0.6) : 0,
        agentRole: lo.role, compEdge: lo.compEdge, utilFactor: lo.utilFactor,
        exposedUntil: -1, rotatePlan: null, hp: 100, armor: ARMOR_MUL[buy[String(defender) as '0' | '1']], pauses: [], fightFace: null, grazed: {}, doneLegs: [],
      });
    });
  }

  const events: MatchEvent[] = [];

  // utility fires for real and bends duels through geometry. Controllers smoke
  // off a sightline (cuts vision for both sides); initiators (recon) and
  // attacking duelists (flash) pulse the contested site to win the first shot
  // on contact. Each effect's reach/duration expresses the caster's `utility`.
  // the fielded agent (not the player's natural role) decides the kit, so the
  // comp you pick changes a team's utility profile. Mastery scales each effect.
  const smokes: Smoke[] = [];
  const pulses: Pulse[] = [];
  const traps: { side: 0 | 1; c: Vec2; r: number }[] = [];
  const choke = lerp(A.mid, sitePt, 0.55);
  // authored utility lineups (either side): a caster's lineup REPLACES their auto
  // cast, so collect those handles to skip below, then add the lineups verbatim.
  // Each lineup carries the side that threw it (attack smokes blind defenders;
  // defense smokes blind attackers — blindedThrough holds the invariant).
  const atkHandleOf = new Map(atkTeam.players.map(p => [p.id, p.handle] as const));
  const defHandleOf = new Map(defTeam.players.map(p => [p.id, p.handle] as const));
  const lineups = [
    ...(atkTac.attack.play?.lineups ?? []).map(l => ({ ...l, side: attacker, handle: atkHandleOf.get(l.player) })),
    ...(defTac.defense.play?.lineups ?? []).map(l => ({ ...l, side: defender, handle: defHandleOf.get(l.player) })),
  ];
  const authoredCasters = new Set(lineups.map(l => l.handle).filter(Boolean) as string[]);
  for (const ag of agents) {
    if (authoredCasters.has(ag.handle)) continue;   // this player throws their authored lineup instead
    const isAtk = ag.side === attacker;
    const u = (ag.p.attr.utility / 100) * ag.utilFactor;
    if (ag.agentRole === 'controller') {
      // EXECUTE smoke: attackers smoke the defenders' hold (the site); defenders smoke the entry (the choke)
      const c = jitter(rng, isAtk ? sitePt : choke, 18);
      const t0 = SMOKE_T0 + rng.range(0, SMOKE_JITTER);
      const r = SMOKE_R + SMOKE_R_UTIL * u, t1 = t0 + SMOKE_DUR + SMOKE_DUR_UTIL * u;
      smokes.push({ side: ag.side, c, r, t0, t1 });
      events.push({ t: t0, kind: 'ability', agent: ag.handle, ability: 'smoke', side: ag.side, at: c, r, until: t1 });
      // SECOND smoke: a controller with kit to spare double-smokes the execute, walling
      // the CONNECTOR between mid and site — so the hit reads like real coordinated
      // utility (two walls up through the fight, not one), and a high-util controller
      // visibly does more. It blooms just after the first for sustained coverage and is
      // drawn clipped to the walls by the viewer. PLANNED, not thrown: centre + time are
      // a deterministic function of the geometry (no jitter, no rng.range) — zero new
      // rng, symmetric on a mirror, so the canonical stream + pool balance are untouched.
      if (u >= CTRL_RESMOKE_U) {
        const rc: Vec2 = lerp(sitePt, A.mid, 0.5);
        const rr = RESMOKE_R + RESMOKE_R_UTIL * u, rt1 = RESMOKE_T0 + RESMOKE_DUR + RESMOKE_DUR_UTIL * u;
        smokes.push({ side: ag.side, c: rc, r: rr, t0: RESMOKE_T0, t1: rt1 });
        events.push({ t: RESMOKE_T0, kind: 'ability', agent: ag.handle, ability: 'smoke', side: ag.side, at: rc, r: rr, until: rt1 });
      }
    } else if (ag.agentRole === 'initiator' || (isAtk && ag.agentRole === 'duelist')) {
      const c = jitter(rng, sitePt, 22);
      // attackers time the execute to their tempo (fast hits flash earlier)
      const t0 = (isAtk ? 0.44 - atkTac.attack.tempo * 0.20 : 0.16) + rng.range(0, 0.10);
      const r = PULSE_R + PULSE_R_UTIL * u, t1 = t0 + PULSE_DUR + PULSE_DUR_UTIL * u;
      pulses.push({ side: ag.side, c, r, t0, t1 });
      events.push({ t: t0, kind: 'ability', agent: ag.handle, ability: ag.agentRole === 'initiator' ? 'recon' : 'flash', side: ag.side, at: c, r, until: t1 });
    } else if (ag.agentRole === 'sentinel') {
      // a sentinel LOCKS THE FLANK: a trap on the off-site lane that catches an enemy
      // crossing it — granting the sentinel's side the first shot there for the whole
      // round (a persistent armed watch, not a thrown window). The other roles fight
      // the main site; the sentinel watches the back door, so a lurk/flank is punished
      // by geometry. Reuses the pulse first-shot machinery, side = the sentinel's.
      const c = jitter(rng, lerp(A.mid, otherPt, 0.5), 24);
      const t0 = TRAP_T0 + rng.range(0, 0.04), r = TRAP_R + TRAP_R_UTIL * u, t1 = t0 + TRAP_DUR;
      pulses.push({ side: ag.side, c, r, t0, t1 });
      traps.push({ side: ag.side, c, r });
      events.push({ t: t0, kind: 'ability', agent: ag.handle, ability: 'trap', side: ag.side, at: c, r, until: t1 });
    }
  }
  // authored lineups: deterministic (no rng), reach/duration still express the
  // caster's utility. A smoke blinds attackers through it; a flash/recon grants
  // the defender the first shot in its window.
  for (const ln of lineups) {
    const caster = agents.find(a => a.handle === ln.handle);
    const u = caster ? (caster.p.attr.utility / 100) * caster.utilFactor : 0.5;
    const r = ln.kind === 'smoke' ? SMOKE_R + SMOKE_R_UTIL * u : PULSE_R + PULSE_R_UTIL * u;
    const t1 = ln.t + (ln.kind === 'smoke' ? SMOKE_DUR + SMOKE_DUR_UTIL * u : PULSE_DUR + PULSE_DUR_UTIL * u);
    if (ln.kind === 'smoke') smokes.push({ side: ln.side, c: ln.at, r, t0: ln.t, t1 });
    else pulses.push({ side: ln.side, c: ln.at, r, t0: ln.t, t1 });
    if (ln.handle) events.push({ t: ln.t, kind: 'ability', agent: ln.handle, ability: ln.kind, side: ln.side, at: ln.at, r, until: t1 });
  }
  // A sentinel trap doesn't just reveal — it SLOWS an enemy who crosses it (denial,
  // not just info): any agent whose path passes through an enemy trap zone has their
  // arrival delayed, so a lurk/flank into a trapped lane hitches and gets there out
  // of position. Setup-time + deterministic (a pure function of paths + trap geom,
  // no rng), applied before the fork clones spread `arrive`, so forks inherit it and
  // True Odds stays byte-identical. Scaled by `scale` so the cost is the same
  // round-fraction on every map. No-op when no sentinel is fielded (traps empty).
  for (const ag of agents) {
    if (ag.path.length < 2) continue;
    if (traps.some(tp => tp.side !== ag.side && pathHitsZone(ag.path, tp.c, tp.r))) ag.arrive += TRAP_SLOW * scale;
  }

  // Counterfactual forks: replay this exact setup on throwaway rng to measure
  // how often the attacker wins — the round's true odds. These never draw from
  // the match rng, so the canonical timeline stays byte-identical.
  let atkForkWins = 0;
  for (let i = 0; i < forks; i++) {
    // fresh hp/pauses/fightFace per clone — `pauses` MUST be a new array (a shared ref
    // would leak fork fight-halts into the canonical pass and break byte-identity)
    const clones = agents.map(a => ({ ...a, alive: true, deathT: null, deathPos: null, exposedUntil: -1, hp: 100, pauses: [], fightFace: null, grazed: {}, doneLegs: [] }));
    const fr = resolveRound(clones, smokes, pulses, nav, sitePt, site, attacker, defender, scale, new Rng(forkSeed(input.seed, n, i)));
    if (fr.winner === attacker) atkForkWins++;
  }

  // Canonical resolution draws from the match rng (same order as ever).
  const res = resolveRound(agents, smokes, pulses, nav, sitePt, site, attacker, defender, scale, rng);
  events.push(...res.events);

  // emit one move event per agent (full path + arrival); viewer freezes on death.
  // `pauses` carries the fight halts (winner stationary at the kill spot) so the
  // viewer replays the exact same journey — omitted when empty (additive field).
  const spawns: Record<string, Vec2> = {};
  for (const a of agents) {
    // the move event's base fields are the FIRST journey; mid-round re-paths
    // (kill-point rotations, the post-plant re-setup) follow as `legs` in
    // departure order — the multi-leg contract (additive: an old consumer plays
    // leg 0 and simply freezes at its end). A rotator that never got contact
    // held all round → departT clamps to 1.
    const shape = (l: { path: Vec2[]; departT: number; arrive: number; pauses: { t: number; dur: number }[]; hold: Vec2 }) =>
      ({ path: l.path, departT: Math.min(1, l.departT), arrive: l.arrive, hold: l.hold, ...(l.pauses.length ? { pauses: l.pauses } : {}) });
    const all = [...a.doneLegs, { path: a.path, departT: a.departT, arrive: a.arrive, pauses: a.pauses, hold: a.holdDir }].map(shape);
    const base = all[0], rest = all.slice(1);
    spawns[a.handle] = base.path[0];
    events.push({ t: 0, arrive: base.arrive, departT: base.departT, kind: 'move', agent: a.handle, path: base.path, hold: base.hold, ...(base.pauses ? { pauses: base.pauses } : {}), ...(rest.length ? { legs: rest } : {}) });
  }
  events.sort((x, y) => x.t - y.t);

  return {
    n, attacker, winner: res.winner, method: res.method, site,
    economy: buildEconomy(buy, creds),
    winPct: forks > 0 ? atkForkWins / forks : 0,
    spawns, events,
  };
}

/** Resolve a full match. `nav` is injected (the caller fetches/loads it) so the
 *  engine stays pure and runs in the browser as well as node. `forks` controls
 *  the true-odds re-sim count (fewer = faster, for live editing). */
export function simulateMatch(input: MatchInput, nav: Navmesh, forks = FORKS): MatchTimeline {
  const rng = new Rng(input.seed);
  const score: [number, number] = [0, 0];
  const creds: Record<'0' | '1', number> = { '0': 800, '1': 800 };
  const lossStreak: Record<'0' | '1', number> = { '0': 0, '1': 0 };
  const rounds: Round[] = [];

  // the match-night layer: every player draws a form edge once, held all match —
  // same roster, different night. Drawn in a fixed order to stay deterministic.
  const form = new Map<string, number>();
  for (const team of input.teams) for (const p of team.players) form.set(p.handle, rng.range(-FORM_SWING, FORM_SWING));

  const tactics: [Tactics, Tactics] = input.tactics ?? [DEFAULT_TACTICS, DEFAULT_TACTICS];

  // each player's fielded agent for the match (their pick, or their main) — held
  // all match. Decides their kit, a duel edge (tier + mastery), and util scaling.
  const loadouts = new Map<string, Loadout>();
  input.teams.forEach((team, ti) => addLoadouts(loadouts, team, input.comp?.[ti], input.patch));

  let idx = 0;
  while (score[0] < 13 && score[1] < 13 && idx < 30) {
    const attacker: 0 | 1 = idx < 12 ? 0 : idx < 24 ? 1 : (idx % 2 === 0 ? 0 : 1);
    const defender: 0 | 1 = attacker === 0 ? 1 : 0;
    const round = simulateRound(rng, input, nav, idx + 1, attacker, { ...creds }, { ...lossStreak }, form, loadouts, tactics[attacker], tactics[defender], forks);
    rounds.push(round);
    score[round.winner]++;

    // economy update
    const kills: Record<'0' | '1', number> = { '0': 0, '1': 0 };
    for (const e of round.events) if (e.kind === 'kill') {
      const side = input.teams[0].players.some(p => p.handle === e.killer) ? '0' : '1';
      kills[side]++;
    }
    const planted = round.events.some(e => e.kind === 'plant');   // only attackers plant
    (['0', '1'] as const).forEach(s => {
      const sideIdx = Number(s) as 0 | 1;
      const won = round.winner === sideIdx;
      const didPlant = planted && round.attacker === sideIdx;
      creds[s] = nextCreds(creds[s], round.economy.buy[s], won, kills[s], lossStreak[s], didPlant);
      lossStreak[s] = won ? 0 : Math.min(3, lossStreak[s] + 1);
    });
    idx++;
  }

  const meta = (t: Team) => ({
    id: t.id, tag: t.tag, name: t.name,
    players: t.players.map(p => ({ id: p.id, handle: p.handle, role: p.role, igl: p.igl, agent: loadouts.get(p.handle)?.agent })),
  });

  return {
    version: 1,
    seed: input.seed,
    map: input.map,
    patch: input.patch.version,
    teams: [meta(input.teams[0]), meta(input.teams[1])],
    finalScore: score,
    rounds,
  };
}
