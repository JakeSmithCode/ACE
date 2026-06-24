import type {
  MatchInput, MatchTimeline, Round, MatchEvent, RoundMethod, Player, Vec2, Team, Tactics, Comp, Role, PatchState, RotateTrigger, SiteId,
} from '@ace/shared';
import { DEFAULT_TACTICS } from '@ace/shared';
import { Rng, sigmoid } from './rng.js';
import { decideBuy, nextCreds, buildEconomy, type Buy } from './economy.js';
import { ANCHORS, pathfind, inView, posAlong, siteIds, sitePt as siteAnchor, type Navmesh, type MapAnchors } from '@ace/maps';

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
const HOLD_BONUS = 6;      // a held angle's duel edge (an anchor on their spot)
const TRADE_WINDOW = 0.03; // round-time a killer stays exposed to a trade after a kill (~3s)
const TRADE_EDGE = 7;      // a trade's duel edge — strong, but less than a clean first shot
const ROTATE_SPEED = 0.85; // a rotator's travel speed once it has info and moves with purpose

// utility — abilities express the `utility` attribute by bending duels through
// the same geometry. Reach/duration scale with the caster's utility (0..1), so
// a util-stacked comp buys space and entries. Tune after watching matches back.
const SMOKE_R = 58, SMOKE_R_UTIL = 46;       // smoke radius (image units): 58..104
const SMOKE_T0 = 0.15, SMOKE_JITTER = 0.10;  // when a smoke blooms (normalized t)
const SMOKE_DUR = 0.20, SMOKE_DUR_UTIL = 0.18;
const PULSE_R = 84, PULSE_R_UTIL = 70;       // recon/flash reach: 84..154
const PULSE_DUR = 0.07, PULSE_DUR_UTIL = 0.10;

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

/** A kill-point trigger with a death's player id resolved to a handle (the form
 *  the engine fires on). Returns null if the named teammate doesn't exist. */
type ResolvedTrig = { kind: 'death'; handle: string } | { kind: 'contact' } | { kind: 'time'; t: number };
function resolveTrig(trigger: RotateTrigger, byId: Map<string, Player>): ResolvedTrig | null {
  if (trigger.kind === 'death') { const h = byId.get(trigger.player)?.handle; return h ? { kind: 'death', handle: h } : null; }
  return trigger;
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
  holdBonus: number;     // this agent's held-angle edge (0 unless anchoring; scaled by aggression)
  agentRole: Role;       // role of the fielded agent — decides the kit
  compEdge: number;      // duel edge from the agent's tier + the player's mastery
  utilFactor: number;    // utility multiplier from agent mastery
  exposedUntil: number;  // round-time until which this agent is trade-vulnerable after a kill
  // kill point: rotate here when the trigger fires (death's player resolved to a handle)
  rotatePlan: { pos: Vec2; route?: Vec2[]; trigger: { kind: 'death'; handle: string } | { kind: 'contact' } | { kind: 'time'; t: number } } | null;
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

function posAt(a: Ag, t: number): Vec2 {
  if (a.deathT != null && t >= a.deathT) return a.deathPos!;
  if (t <= a.departT) return a.path[0];            // holding at start (e.g. a rotator on info-hold)
  return posAlong(a.path, ease(Math.min(1, (t - a.departT) / a.arrive)));
}

/** Where an agent is looking at time t: down their travel vector while moving,
 *  and down their held angle (holdDir) while holding or once arrived. */
function facingAt(a: Ag, t: number): Vec2 {
  if (a.deathT != null && t >= a.deathT) return a.holdDir;
  const moveEnd = a.departT + a.arrive;
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

/** Resolve one attacker-vs-defender duel. Returns true if the attacker wins.
 *  `surprise` is the signed advantage edge: +ve favours the attacker (saw first
 *  / pulse / trade), -ve favours the defender. */
function duel(rng: Rng, atk: Ag, def: Ag, surprise: number, holdEdge: number): boolean {
  const A = atk.p.attr, D = def.p.attr;
  // .form is match-night; .compEdge is the fielded agent (tier + mastery)
  const atkEdge = A.aim * 0.45 + A.gameSense * 0.30 + A.entry * 0.25 + TIER[atk.weapon] * 4 + atk.form + atk.compEdge;
  const defEdge = D.aim * 0.45 + D.gameSense * 0.35 + D.clutch * 0.20 + TIER[def.weapon] * 4 + def.form + def.compEdge;
  // holdEdge > 0 favours the defender (pre-plant anchor); < 0 favours the attacker (post-plant crossfire)
  const noise = rng.range(-13, 13);
  const p = sigmoid((atkEdge - defEdge - holdEdge + surprise + noise) / 18);
  return rng.chance(p);
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
  let winner: 0 | 1 | null = null;
  let method: RoundMethod = 'time';
  let hadKill = false, contactT = Infinity;

  // release an authored kill-point rotation: walk the authored route verbatim,
  // else A* the way; reuses the departT hold-then-move machinery.
  const fireRotation = (ag: Ag, t: number) => {
    const rp = ag.rotatePlan!, here = posAt(ag, t);
    ag.path = rp.route?.length ? [here, ...rp.route, rp.pos] : pathfind(nav, here, rp.pos);
    ag.departT = t; ag.arrive = arriveTime(ag.path, ROTATE_SPEED * scale); ag.rotatePlan = null;
  };

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
        const pd = posAt(d, t);
        if (dist(pa, pd) > ENGAGE) continue;
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
        const atkWins = duel(rng, a, d, surprise, holdEdge);
        const loser = atkWins ? d : a;
        const winnerAg = atkWins ? a : d;
        loser.alive = false; loser.deathT = t; loser.deathPos = posAt(loser, t);
        winnerAg.exposedUntil = t + TRADE_WINDOW;      // the killer is now tradeable
        hadKill = true;                                 // first blood = info for the defense
        // kill point: teammates whose death-trigger names this victim rotate now
        for (const ag of agents) {
          if (ag.alive && ag.rotatePlan?.trigger.kind === 'death' && ag.rotatePlan.trigger.handle === loser.handle) fireRotation(ag, t);
        }
        resolvedThisStep.add(a.handle); resolvedThisStep.add(d.handle);
        events.push({ t, kind: 'kill', killer: winnerAg.handle, victim: loser.handle, weapon: winnerAg.weapon });
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
      }
    }

    // retake: post-plant, a defender who reaches the spike with no attacker
    // contesting the site channels a defuse — defenders must clear it, then hold it.
    if (planted && plantPos) {
      const defuser = def().find(d => dist(posAt(d, t), plantPos!) < DEFUSE_R);
      const contested = atk().some(a => dist(posAt(a, t), plantPos!) < SITE_R);
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

  const buy: Record<'0' | '1', Buy> = {
    '0': pistol ? 'pistol' : decideBuy(creds['0'], creds['1'], lossStreak['0']),
    '1': pistol ? 'pistol' : decideBuy(creds['1'], creds['0'], lossStreak['1']),
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
      const rt = plan?.rotate, trig = rt ? resolveTrig(rt.trigger, byIdA) : null;
      agents.push({
        p, side: attacker, handle: p.handle, path, departT: 0,
        arrive: arriveTime(path, isEntry ? atkSpeed * 1.15 : atkSpeed),
        alive: true, deathT: null, deathPos: null,
        weapon: pickWeapon(rng, buy[String(attacker) as '0' | '1'], p.role), anchor: false,
        holdDir: plan?.face ? unit(pos, plan.face) : unit(spawn, pos),  // authored angle, else face the push
        exposedUntil: -1,
        rotatePlan: rt && trig ? { pos: rt.pos, route: rt.route, trigger: trig } : null,
        form: form.get(p.handle) ?? 0, holdBonus: 0,
        agentRole: lo.role, compEdge: lo.compEdge, utilFactor: lo.utilFactor,
      });
    });
  } else {
    atkTeam.players.forEach(p => {
      const isLurk = p.id === lurkId;
      const isEntry = !isLurk && p.id === entryId;
      const spawn = jitter(rng, A.atkSpawn, 22);
      const goal = jitter(rng, isLurk ? lurkPt : sitePt, isLurk ? 30 : 38);
      const path = pathfind(nav, spawn, goal);
      const lo = loadouts.get(p.handle)!;
      agents.push({
        p, side: attacker, handle: p.handle, path, departT: 0,
        // the entry leads (15% faster); the lurker peels off at normal pace
        arrive: arriveTime(path, isEntry ? atkSpeed * 1.15 : atkSpeed),
        alive: true, deathT: null, deathPos: null,
        weapon: pickWeapon(rng, buy[String(attacker) as '0' | '1'], p.role), anchor: false,
        // the lurker holds toward the fight (catches unaware rotators); others push to site
        holdDir: isLurk ? unit(goal, sitePt) : unit(spawn, goal),
        exposedUntil: -1, rotatePlan: null,
        form: form.get(p.handle) ?? 0, holdBonus: 0,
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
      const rt = plan?.rotate, trig = rt ? resolveTrig(rt.trigger, byId) : null;
      agents.push({
        p, side: defender, handle: p.handle, path, departT: 0,
        arrive: route ? arriveTime(path, scale) : 0.12,     // a longer route = set up later
        alive: true, deathT: null, deathPos: null,
        weapon: pickWeapon(rng, buy[String(defender) as '0' | '1'], p.role), anchor: true,
        // watch the authored angle if given, else default to facing the attacker spawn
        holdDir: plan?.face ? unit(pos, plan.face) : unit(pos, A.atkSpawn),
        form: form.get(p.handle) ?? 0,
        holdBonus: HOLD_BONUS * (1 - dAgg * 0.6),
        agentRole: lo.role, compEdge: lo.compEdge, utilFactor: lo.utilFactor,
        exposedUntil: -1,
        rotatePlan: rt && trig ? { pos: rt.pos, route: rt.route, trigger: trig } : null,
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
    const onRead = Math.max(1, Math.min(3, 1 + Math.round(Math.abs(defTac.defense.read) * 2)));
    const rotSpeed = ROTATE_SPEED * iglRotateMul(defTeam) * scale;   // sharp IGL + map-scale normalized
    const fwd = lerp(A.mid, A.atkSpawn, dAgg * 0.3);   // aggressive mids hold forward toward contact
    const slots: { from: Vec2; site: SiteId | 'M' }[] = [];
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
        form: form.get(p.handle) ?? 0,
        holdBonus: anchor ? HOLD_BONUS * (1 - dAgg * 0.6) : 0,
        agentRole: lo.role, compEdge: lo.compEdge, utilFactor: lo.utilFactor,
        exposedUntil: -1, rotatePlan: null,
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
      // attackers smoke the defenders' hold (the site); defenders smoke the entry (the choke)
      const c = jitter(rng, isAtk ? sitePt : choke, 18);
      const t0 = SMOKE_T0 + rng.range(0, SMOKE_JITTER);
      smokes.push({ side: ag.side, c, r: SMOKE_R + SMOKE_R_UTIL * u, t0, t1: t0 + SMOKE_DUR + SMOKE_DUR_UTIL * u });
      events.push({ t: t0, kind: 'ability', agent: ag.handle, ability: 'smoke' });
    } else if (ag.agentRole === 'initiator' || (isAtk && ag.agentRole === 'duelist')) {
      const c = jitter(rng, sitePt, 22);
      // attackers time the execute to their tempo (fast hits flash earlier)
      const t0 = (isAtk ? 0.44 - atkTac.attack.tempo * 0.20 : 0.16) + rng.range(0, 0.10);
      pulses.push({ side: ag.side, c, r: PULSE_R + PULSE_R_UTIL * u, t0, t1: t0 + PULSE_DUR + PULSE_DUR_UTIL * u });
      events.push({ t: t0, kind: 'ability', agent: ag.handle, ability: ag.agentRole === 'initiator' ? 'recon' : 'flash' });
    }
  }
  // authored lineups: deterministic (no rng), reach/duration still express the
  // caster's utility. A smoke blinds attackers through it; a flash/recon grants
  // the defender the first shot in its window.
  for (const ln of lineups) {
    const caster = agents.find(a => a.handle === ln.handle);
    const u = caster ? (caster.p.attr.utility / 100) * caster.utilFactor : 0.5;
    if (ln.kind === 'smoke') {
      smokes.push({ side: ln.side, c: ln.at, r: SMOKE_R + SMOKE_R_UTIL * u, t0: ln.t, t1: ln.t + SMOKE_DUR + SMOKE_DUR_UTIL * u });
    } else {
      pulses.push({ side: ln.side, c: ln.at, r: PULSE_R + PULSE_R_UTIL * u, t0: ln.t, t1: ln.t + PULSE_DUR + PULSE_DUR_UTIL * u });
    }
    if (ln.handle) events.push({ t: ln.t, kind: 'ability', agent: ln.handle, ability: ln.kind });
  }
  // Counterfactual forks: replay this exact setup on throwaway rng to measure
  // how often the attacker wins — the round's true odds. These never draw from
  // the match rng, so the canonical timeline stays byte-identical.
  let atkForkWins = 0;
  for (let i = 0; i < forks; i++) {
    const clones = agents.map(a => ({ ...a, alive: true, deathT: null, deathPos: null, exposedUntil: -1 }));
    const fr = resolveRound(clones, smokes, pulses, nav, sitePt, site, attacker, defender, scale, new Rng(forkSeed(input.seed, n, i)));
    if (fr.winner === attacker) atkForkWins++;
  }

  // Canonical resolution draws from the match rng (same order as ever).
  const res = resolveRound(agents, smokes, pulses, nav, sitePt, site, attacker, defender, scale, rng);
  events.push(...res.events);

  // emit one move event per agent (full path + arrival); viewer freezes on death
  const spawns: Record<string, Vec2> = {};
  for (const a of agents) {
    spawns[a.handle] = a.path[0];
    // a rotator that never got contact held all round → departT clamps to 1
    events.push({ t: 0, arrive: a.arrive, departT: Math.min(1, a.departT), kind: 'move', agent: a.handle, path: a.path, hold: a.holdDir });
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
