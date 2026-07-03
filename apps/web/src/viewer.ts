import type { MatchTimeline, Round, Vec2 } from '@ace/shared';
import { ANCHORS } from '@ace/maps';   // pure barrel (geometry only) — the site callouts

// posAlong duplicated here (viewer is browser-only; avoids importing the node maps pkg)
function posAlong(path: Vec2[], frac: number): Vec2 {
  if (!path || path.length === 0) return [0, 0];
  if (path.length === 1) return path[0];
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  const total = cum[cum.length - 1];
  if (total === 0) return path[0];
  const d = Math.max(0, Math.min(1, frac)) * total;
  for (let i = 1; i < path.length; i++) {
    if (d <= cum[i]) { const m = (d - cum[i - 1]) / (cum[i] - cum[i - 1]); return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * m, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * m]; }
  }
  return path[path.length - 1];
}
const ease = (p: number) => p * (2 - p);
const unit = (dx: number, dy: number): Vec2 => { const d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d]; };

/** A trap stutter: the agent pauses for `dur` (round-t) at distance-fraction
 *  `frac` of its path, then resumes — same total arrival, but the motion visibly
 *  hitches where an enemy trap slowed it. Purely a render concern (no contract). */
interface Hitch { frac: number; dur: number; start: number; end: number; }

/** Total halted time inside engine fight-pauses up to round-time t — mirrors the
 *  engine's pausedTime exactly (a duel winner stands at the kill spot for a beat). */
type Pause = { t: number; dur: number };
function pausedTime(pauses: Pause[] | undefined, t: number): number {
  if (!pauses || !pauses.length) return 0;
  let s = 0;
  for (const p of pauses) s += Math.min(p.dur, Math.max(0, t - p.t));
  return s;
}

/** Position respecting a hold-then-move: stays at path[0] until departT, then
 *  travels over `arrive`. Mirrors the engine's posAt — including the engine's
 *  fight `pauses` (halts that EXTEND the journey). An optional `hitch` injects
 *  the trap pause without changing where the agent ends up at `arrive`. */
function posWithDepart(path: Vec2[], departT: number, arrive: number, prog: number, hitch?: Hitch, pauses?: Pause[]): Vec2 {
  if (prog <= departT) return path[0] ?? [0, 0];
  const local = prog - departT - pausedTime(pauses, prog);
  if (local <= 0) return path[0] ?? [0, 0];
  let lin: number;
  if (hitch && arrive > hitch.dur) {
    // steal `dur` from the travel, spent paused at `frac`: the agent reaches the
    // trap, hitches, then walks the rest a touch quicker — net arrival unchanged.
    const move = arrive - hitch.dur;
    const tHit = move * (1 - Math.sqrt(1 - hitch.frac));   // easeInv(frac): moving-time at which eased dist = frac
    const m = local < tHit ? local : local < tHit + hitch.dur ? tHit : local - hitch.dur;
    lin = m / move;
  } else {
    lin = local / arrive;
  }
  return posAlong(path, ease(Math.min(1, lin)));
}

/** Distance-fraction along `path` where it first enters the circle (c,r), or null.
 *  Mirrors the engine's pathHitsZone trigger so the viewer hitches exactly the
 *  agents the engine slowed. Samples by distance; falls back to closest approach. */
function trapEntryFrac(path: Vec2[], c: Vec2, r: number): number | null {
  if (!path || path.length < 2) return null;
  const N = 96;
  let bestD = Infinity, bestF = 0;
  for (let i = 0; i <= N; i++) {
    const f = i / N, p = posAlong(path, f);
    const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
    if (d <= r) return f;
    if (d < bestD) { bestD = d; bestF = f; }
  }
  return bestD <= r * 1.5 ? bestF : null;
}

/** Heading of a path's final non-degenerate segment — the fallback for `hold`. */
function headingAtEnd(path: Vec2[]): Vec2 {
  for (let i = path.length - 1; i > 0; i--) {
    const dx = path[i][0] - path[i - 1][0], dy = path[i][1] - path[i - 1][1];
    if (Math.hypot(dx, dy) > 1e-6) return unit(dx, dy);
  }
  return [0, -1];
}

/** A fight-face window: after a kill the winner looks down the kill line for a
 *  beat (tunnel vision) — mirrors the engine's fightFace, reconstructed from the
 *  kill events (killer → victim positions at the kill t). */
type FightFace = { from: number; until: number; dir: Vec2 };
const FIGHT_FACE = 0.03;   // mirrors the engine constant
const GRAZE_FACE = 0.02;   // mirrors the engine — both sides of an exchange watch each other

/** Reconstruct where an agent looks at progress `prog`: down the kill line for a
 *  beat after winning a fight, down its travel vector while moving, down its held
 *  angle while holding or once arrived. Mirrors engine facingAt(). */
function facingOf(path: Vec2[], departT: number, arrive: number, hold: Vec2, prog: number, hitch?: Hitch, pauses?: Pause[], ff?: FightFace[]): Vec2 {
  if (ff) {
    // the LATEST-starting active window wins — mirrors the engine's single
    // fightFace slot, which newer fights overwrite (hear-turns never interrupt)
    let best: FightFace | null = null;
    for (const f of ff) if (prog >= f.from && prog <= f.until && (!best || f.from > best.from)) best = f;
    if (best) return best.dir;
  }
  const moveEnd = departT + arrive + pausedTime(pauses, prog);
  if (prog > departT && prog < moveEnd - 1e-6) {
    const here = posWithDepart(path, departT, arrive, prog, hitch, pauses);
    const ahead = posWithDepart(path, departT, arrive, Math.min(moveEnd, prog + 0.02), hitch, pauses);
    const dx = ahead[0] - here[0], dy = ahead[1] - here[1];
    if (Math.hypot(dx, dy) > 1e-6) return unit(dx, dy);
  }
  return hold;
}

/** BROADCAST AUDIO — synthesized Web Audio cues, zero assets: short enveloped
 *  tones for the moments the broadcast already calls (kills, first blood, the
 *  multikill ladder, plant/defuse, the spike countdown, round start, clutch).
 *  Everything rides the SAME live-only guards the visual beats use, so scrubbing
 *  and paused states stay silent; the context is created lazily on the first cue
 *  (satisfying autoplay policy — the user has interacted by the time we play). */
class Sfx {
  enabled = true;
  private ctx: AudioContext | null = null;
  private ensure(): AudioContext | null {
    if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
    if (!this.ctx) { try { this.ctx = new AudioContext(); } catch { return null; } }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }
  private tone(f0: number, f1: number, dur: number, vol: number, type: OscillatorType = 'sine', when = 0) {
    if (!this.enabled) return;
    const ctx = this.ensure(); if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  kill(hs?: boolean) { this.tone(hs ? 420 : 340, 180, 0.09, 0.055, 'triangle'); }
  fb() { this.tone(520, 300, 0.13, 0.06, 'triangle'); this.tone(780, 520, 0.12, 0.035, 'sine', 0.05); }
  multi(n: number) { for (let i = 0; i < Math.min(n, 5); i++) this.tone(560 + i * 140, 560 + i * 140, 0.08, 0.05, 'sine', i * 0.065); }
  graze() { this.tone(250, 210, 0.045, 0.018, 'square'); }
  plant() { this.tone(880, 870, 0.09, 0.05); this.tone(880, 870, 0.09, 0.05, 'sine', 0.15); }
  spikeTick(urgent: boolean) { this.tone(urgent ? 1250 : 1100, urgent ? 1200 : 1060, 0.04, urgent ? 0.026 : 0.016); }
  defuse() { this.tone(660, 990, 0.2, 0.05); }
  roundStart() { this.tone(392, 392, 0.07, 0.03); this.tone(523, 523, 0.09, 0.04, 'sine', 0.08); }
  clutch() { this.tone(330, 660, 0.28, 0.04, 'sawtooth'); }
}

/** One movement leg of a MULTI-LEG journey — the move event's base fields are
 *  leg 0, `legs` are the re-paths after it (kill-point rotations, the post-plant
 *  re-setup), in departure order. */
type Leg = { path: Vec2[]; departT: number; arrive: number; pauses?: Pause[]; hold?: Vec2 };

/** The leg active at `prog`: the LAST one already departed, else the base leg
 *  (which also covers the pre-depart hold at its own path[0]). */
function legAt(base: Leg, legs: Leg[] | undefined, prog: number): Leg {
  let cur = base;
  if (legs) for (const l of legs) { if (prog >= l.departT) cur = l; else break; }
  return cur;
}
/** posWithDepart across a multi-leg journey (the trap hitch only ever rides leg 0). */
function posLegs(base: Leg, legs: Leg[] | undefined, prog: number, hitch?: Hitch): Vec2 {
  const l = legAt(base, legs, prog);
  return posWithDepart(l.path, l.departT, l.arrive, prog, l === base ? hitch : undefined, l.pauses);
}
/** facingOf across a multi-leg journey — each leg carries its own hold angle. */
function faceLegs(base: Leg, legs: Leg[] | undefined, hold: Vec2, prog: number, hitch?: Hitch, ff?: FightFace[]): Vec2 {
  const l = legAt(base, legs, prog);
  return facingOf(l.path, l.departT, l.arrive, l.hold ?? hold, prog, l === base ? hitch : undefined, l.pauses, ff);
}

// the IGL's economic call, labelled for the broadcast (eco reads as a disciplined "SAVE")
const BUY_LABEL: Record<string, string> = { full: 'FULL BUY', force: 'FORCE', eco: 'SAVE', pistol: 'PISTOL' };
const SVG = 'http://www.w3.org/2000/svg';
const el = (t: string, cls?: string) => { const e = document.createElement(t); if (cls) e.className = cls; return e; };
const svg = (t: string) => document.createElementNS(SVG, t);

/** The walkability grid the engine pathfinds and raycasts on (packages/maps).
 *  The viewer fetches it to clip vision cones against the same walls. */
export interface NavGrid { cell: number; cols: number; rows: number; walk: number[]; }

// Vision tuning — mirrors the engine's duel-time vision (packages/engine/src/sim.ts).
const VISION = 150;        // cone reach in image units (engine ENGAGE)
const FOV_HALF = 1.05;     // cone half-angle in radians (~60°, engine FOV)
const CONE_RAYS = 16;      // rays cast across the cone to trace its wall-clipped edge
const HP_C = 2 * Math.PI * 15;   // hp arc circumference (r=15 ring segment)
const CAM_TAU = 850;       // director-camera easing time-constant (ms) — stately, not twitchy
const CAM_MIN = 430;       // tightest frame (world units) — never over-magnifies
const CAM_PAD = 130;       // breathing room around the interest bbox

interface VAg {
  handle: string; side: 'att' | 'def'; path: Vec2[]; arrive: number; departT: number; deathT: number | null;
  hold: Vec2; node: SVGGElement; trail: SVGPolylineElement; tp: string[]; cone: SVGPathElement; hitch?: Hitch; spawnFan?: Vec2;
  pauses: Pause[];             // engine fight-halts (winner stationary at the kill spot) — extend the journey
  ff: FightFace[];             // fight-face windows (winner looks down the kill line for a beat)
  hpEv: { t: number; hp: number }[];   // hp checkpoints from dmg/kill events — the live health arc
  legs?: Leg[];                // re-paths after the base journey (multi-leg move)
  hpEl: SVGCircleElement;      // the depleting hp ring segment
  // presentation-only render state (never feeds the x-ray/heatmap reconstructions):
  rox: number; roy: number;    // smoothed separation offset (kills pile-up jitter)
  rang: number | null;         // smoothed facing angle — cones SWEEP between headings, never snap
}

/** A persistent, keyed ability node — built once per round, animated per frame as a pure
 *  function of round-time T (scrub/pause-correct), instead of rebuilding DOM at 60Hz. */
interface AbNode { e: Extract<Round['events'][number], { kind: 'ability' }>; g: SVGGElement; c1: SVGCircleElement; c2: SVGCircleElement; R: number; sw?: SVGCircleElement; wall?: SVGGElement; wallEdge?: SVGRectElement; }

const HITCH_DUR = 0.05;     // round-t the viewer pauses a trap-tripped agent (the visible stutter)
const SPAWN_FAN = 34;       // lateral spacing of attackers across the spawn barrier (px, viewer-only)
const SPAWN_CONVERGE = 0.12; // round-t over which the spread spawn collapses onto the engine path
const SEP_MIN = 38;         // min on-screen spacing between same-side bodies — de-stack piles (px, viewer-only)
const SEP_ITERS = 3;        // relaxation passes per frame to resolve overlaps
const SEP_TAU = 70;         // ms time-constant smoothing the separation offset (de-jitters piles)
const TURN_RATE = 9.4;      // rad/s max cone turn — a 90° flick sweeps in ~170ms (smooth but snappy)
const AB_VIS_SCALE = 0.62;  // smoke/flash/recon render at this fraction of the gameplay radius — a Valorant-sized dome, not a room-filling cloud (visual only; the engine's blind reach is unchanged)
const AB_BLOOM = 0.02;      // round-t a smoke takes to bloom to full size (~0.4s at 1×)
const AB_FADE = 0.045;      // round-t of the smoke's dissipate fade at the end of its life
const AB_ARM = 0.025;       // round-t a trap takes to arm (ring draws in)
const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class Viewer {
  private tl: MatchTimeline;
  private mapUrl: string;
  private nav: NavGrid | null;
  private teamOf = new Map<string, 0 | 1>();
  private roundIdx = 0;
  private T = 0; private playing = true; private speed = 1; private last: number | null = null;
  private DUR = 20000; private fired = -1; private ended = false; private raf = 0;
  private advanceTimer: ReturnType<typeof setTimeout> | null = null;   // auto-advance to next round after the result card
  private clearAdvance() { if (this.advanceTimer) { clearTimeout(this.advanceTimer); this.advanceTimer = null; } }
  private agents: VAg[] = [];
  private spikePos: Vec2 | null = null; private spikePlantT = Infinity;
  private showCones = true;
  // DIRECTOR CAMERA — the broadcast observer: auto-frames the action (contact
  // clusters, the push, the spike) with stately smoothed motion; toggles back to
  // the full map. Pure presentation: a viewBox animation over the same world.
  private camAuto = true;
  private cam: { x: number; y: number; w: number } | null = null;
  private fullBox = { x: 0, y: 0, w: 1000 };
  private camBtn!: HTMLElement;
  private followHandle: string | null = null;   // click an agent → the director locks onto them
  // FOG OF WAR (team POV): when watching YOUR club, see only what your five see —
  // an enemy renders only while a living teammate has actual vision of them
  // (cone + walls + enemy smoke, mirrored from the engine), while a friendly
  // recon/trap sweep reveals its circle, gunfire reveals both fight participants
  // for a beat, and deaths are always known (every kill involves your team).
  private pov: 0 | 1 | null = null;      // which team is "yours" (null = observer only)
  private povOn = false;                 // fog active (toggleable back to observer)
  private povBtn: HTMLElement | null = null;
  private fireReveals: { h: string; t: number }[] = [];   // shots fired → brief position reveal
  private ghosts = new Map<string, { p: Vec2; t: number }>();   // last-known-position markers
  private ghostEls = new Map<string, SVGGElement>();
  private lastSeenNow = new Set<string>();      // last frame's visible-enemy set (ghosts spawn on the edge)
  private sfx = new Sfx();
  private sndBtn!: HTMLElement;
  private lastSpikeTick = -1;   // spike-countdown beeps, indexed by round-time bucket
  // live scoreboard (kills/deaths through the current moment) — form made visible
  private scores = new Map<string, { k: number; d: number }>();
  private deadNow = new Set<string>();   // handles down in the CURRENT round at the current moment
  private scoreEls = new Map<string, { row: HTMLElement; k: HTMLElement; d: HTMLElement; kd: HTMLElement }>();
  private boardWraps: [HTMLElement, HTMLElement] = [null as any, null as any];
  private boardDirty = false;

  // dom refs
  private root: HTMLElement;
  private agLayer!: SVGGElement; private trLayer!: SVGGElement; private coneLayer!: SVGGElement; private spike!: SVGGElement;
  private abLayer!: SVGGElement; private utilBtn!: HTMLElement; private showUtil = true;
  private abilities: Extract<Round['events'][number], { kind: 'ability' }>[] = [];   // utility with geometry, for the map
  private abNodes: AbNode[] = [];        // persistent per-round ability nodes (animated, never rebuilt per frame)
  private snapNext = true;               // next render snaps smoothing state (round load / scrub — no lag-in)
  private feed!: HTMLElement; private feedItems: HTMLElement[] = [];
  private lastKill = new Map<string, number>();   // killer handle -> t, for tagging trades
  private playBtn!: HTMLElement; private timer!: HTMLElement; private seekFill!: HTMLElement; private seekHead!: HTMLElement; private seek!: HTMLElement;
  private phase!: HTMLElement; private roundLabel!: HTMLElement; private strip!: HTMLElement; private coneBtn!: HTMLElement;
  private scoreA!: HTMLElement; private scoreB!: HTMLElement;        // running score (no spoiler)
  private clock!: HTMLElement; private clockWrap!: HTMLElement;      // broadcast round clock (centerpiece)
  private endCard!: HTMLElement;                                     // round-result card shown when playback ends
  private mapSvg!: SVGSVGElement;                                    // the map svg (re-faded on each new round)
  private sideTags: [HTMLElement, HTMLElement] = [null as any, null as any]; // per-team ATK/DEF this round
  private oddsNow!: HTMLElement; private oddsBars: HTMLElement[] = []; private oddsChart!: HTMLElement; // true-odds chart
  private live = false; private liveWaiting = false;   // live-watch: parked at the last completed round, awaiting more
  private heatLayer!: SVGGElement; private heatBtn!: HTMLElement; private heatLegend!: HTMLElement; private showHeat = false;
  private xray!: HTMLElement;   // duel x-ray overlay (click a kill → why it resolved)
  private buyEls: [HTMLElement, HTMLElement] = [null as any, null as any]; // per-team buy badge
  // ── the broadcast MOMENT layer: the beats a crowd watches for, all derived from the
  // event stream (no contract change): FIRST BLOOD, multikills/ACE, the clutch callout,
  // spike-planted sting, kill tracers, alive counters, match point. ──────────────────
  private banner!: HTMLElement; private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private killsInRound = new Map<string, number>();   // per-round kill tally per player (multikill detection)
  private firstBloodDone = false;                     // has this round's opening kill happened
  private lastClutch: string | null = null;           // the clutcher already called out this round
  private aliveEls: [HTMLElement, HTMLElement] = [null as any, null as any];   // 5 alive-pips per team
  private mpt!: HTMLElement;                          // MATCH POINT tag in the scorebar

  constructor(root: HTMLElement, tl: MatchTimeline, mapUrl: string, nav: NavGrid | null = null, opts: { live?: boolean; sfx?: boolean; pov?: 0 | 1 } = {}) {
    this.root = root; this.tl = tl; this.mapUrl = mapUrl; this.nav = nav; this.live = !!opts.live;
    this.sfx.enabled = opts.sfx !== false;
    this.pov = opts.pov ?? null;
    this.povOn = this.pov != null;   // watching your club defaults to the team's-eye view
    tl.teams.forEach((tm, i) => tm.players.forEach(p => this.teamOf.set(p.handle, i as 0 | 1)));
    this.build();
    this.loadRound(0);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() { cancelAnimationFrame(this.raf); this.clearAdvance(); if (this.bannerTimer) clearTimeout(this.bannerTimer); }

  private build() {
    const t = this.tl;
    this.root.innerHTML = '';
    // scorebar
    const sb = el('div', 'ace-scorebar');
    const pips = '<i></i><i></i><i></i><i></i><i></i>';
    sb.innerHTML = `
      <div class="ace-team att">
        <div class="tmeta"><div class="tg">${t.teams[0].name}</div><div class="tside" id="ace-side0"></div><div class="alive a" id="ace-alive0">${pips}</div></div>
        <div class="tmark att">${t.teams[0].tag}</div>
      </div>
      <div class="ace-scoreblock">
        <div class="sc"><span class="a">0</span><div class="clockwrap" id="ace-clockwrap"><span class="clock" id="ace-clock">1:40</span></div><span class="b">0</span></div>
        <div class="side" id="ace-round">Round 1</div>
        <div class="mpt" id="ace-mpt"></div>
        <div class="ctx">${t.map.toUpperCase()} · PATCH ${t.patch} · SEED ${t.seed}</div>
      </div>
      <div class="ace-team def r">
        <div class="tmark def">${t.teams[1].tag}</div>
        <div class="tmeta"><div class="tg">${t.teams[1].name}</div><div class="tside" id="ace-side1"></div><div class="alive b r" id="ace-alive1">${pips}</div></div>
      </div>`;
    this.scoreA = sb.querySelector('.sc .a') as HTMLElement;
    this.scoreB = sb.querySelector('.sc .b') as HTMLElement;
    this.clock = sb.querySelector('#ace-clock') as HTMLElement;
    this.clockWrap = sb.querySelector('#ace-clockwrap') as HTMLElement;
    this.mpt = sb.querySelector('#ace-mpt') as HTMLElement;
    this.aliveEls = [sb.querySelector('#ace-alive0') as HTMLElement, sb.querySelector('#ace-alive1') as HTMLElement];
    this.sideTags = [sb.querySelector('#ace-side0') as HTMLElement, sb.querySelector('#ace-side1') as HTMLElement];
    this.root.appendChild(sb);
    this.roundLabel = sb.querySelector('#ace-round') as HTMLElement;

    const stage = el('div', 'ace-stage');
    // left: map + controls
    const left = el('div', 'ace-left');
    const wrap = el('div', 'ace-mapwrap');
    wrap.innerHTML = `<div class="ace-overlay"><span class="ovl" id="ace-phase">Round start</span></div><div class="ace-banner" id="ace-banner"></div><div class="ace-endcard" id="ace-endcard"></div><div class="ace-heatkey" id="ace-heatkey"></div>`;
    const s = svg('svg'); s.setAttribute('class', 'ace-map'); s.setAttribute('viewBox', this.playViewBox()); this.mapSvg = s as unknown as SVGSVGElement;
    { const [fx, fy, fw] = this.playViewBox().split(' ').map(Number); this.fullBox = { x: fx, y: fy, w: fw }; }
    const img = svg('image'); img.setAttribute('href', this.mapUrl); img.setAttribute('x', '0'); img.setAttribute('y', '0'); img.setAttribute('width', '1000'); img.setAttribute('height', '1000'); img.setAttribute('preserveAspectRatio', 'none');
    const scrim = svg('rect'); scrim.setAttribute('x', '0'); scrim.setAttribute('y', '0'); scrim.setAttribute('width', '1000'); scrim.setAttribute('height', '1000'); scrim.setAttribute('class', 'ace-scrim');
    // site callouts (A/B/C) — the orientation every caster + viewer navigates by.
    // From the same anchors the engine plays on, so the label sits where the fight is.
    const sitesG = svg('g'); sitesG.setAttribute('class', 'ace-sitelabels');
    const anchors = ANCHORS[this.tl.map];
    if (anchors) for (const [sid, pt] of Object.entries(anchors.sites)) {
      if (!pt) continue;
      const [sx, sy] = pt as Vec2;
      sitesG.innerHTML += `<g transform="translate(${sx},${sy})"><circle class="sl-ring" r="26"></circle><text class="sl-t" y="9">${sid}</text></g>`;
    }
    this.abLayer = svg('g') as SVGGElement; this.abLayer.setAttribute('class', 'ace-abils');
    this.coneLayer = svg('g') as SVGGElement; this.coneLayer.setAttribute('class', 'ace-cones');
    this.trLayer = svg('g') as SVGGElement; this.trLayer.setAttribute('class', 'ace-trails');
    this.spike = svg('g') as SVGGElement; this.spike.setAttribute('class', 'ace-spike');
    this.spike.innerHTML = `<circle class="sp-ring" r="13"></circle><rect class="sp-core" x="-6" y="-6" width="12" height="12" transform="rotate(45)"></rect>`;
    this.agLayer = svg('g') as SVGGElement; this.agLayer.setAttribute('class', 'ace-agents');
    // match heatmap: an aggregate density of where each side dies across the WHOLE match
    // (the interrogability x-ray). Soft radial blobs, team-tinted, screen-blended so
    // overlaps brighten into hotspots. Hidden until toggled; sits on top of everything.
    const defs = svg('defs');
    defs.innerHTML = `
      <radialGradient id="heat0" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.55"/><stop offset="55%" stop-color="#22d3ee" stop-opacity="0.16"/><stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="heat1" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ff5c6e" stop-opacity="0.55"/><stop offset="55%" stop-color="#ff5c6e" stop-opacity="0.16"/><stop offset="100%" stop-color="#ff5c6e" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="ace-smk" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#a0a3af" stop-opacity="0.6"/><stop offset="62%" stop-color="#9c9eaa" stop-opacity="0.46"/><stop offset="100%" stop-color="#9c9eaa" stop-opacity="0.1"/>
      </radialGradient>`;
    this.heatLayer = svg('g') as SVGGElement; this.heatLayer.setAttribute('class', 'ace-heat');
    // utility (smokes/flashes/traps) sits on the map surface, cones above it, then trails/agents
    s.append(defs, img, scrim, sitesG, this.abLayer, this.coneLayer, this.trLayer, this.spike, this.agLayer, this.heatLayer);
    wrap.appendChild(s);
    left.appendChild(wrap);
    this.phase = wrap.querySelector('#ace-phase') as HTMLElement;
    this.banner = wrap.querySelector('#ace-banner') as HTMLElement;
    this.endCard = wrap.querySelector('#ace-endcard') as HTMLElement;
    this.heatLegend = wrap.querySelector('#ace-heatkey') as HTMLElement;

    const ctl = el('div', 'ace-controls');
    ctl.innerHTML = `
      <div class="row">
        <button class="play" id="ace-play">❚❚</button>
        <button class="nav" id="ace-prev">‹</button>
        <div class="timer" id="ace-timer">1:40</div>
        <div class="seek" id="ace-seek"><div class="fill" id="ace-fill"></div><div class="head" id="ace-headd"></div></div>
        <button class="nav" id="ace-next">›</button>
        <button class="speed" id="ace-speed">1×</button>
        <button class="speed vis on" id="ace-vis" title="Toggle vision cones">◔ Vision</button>
        <button class="speed vis on" id="ace-util" title="Toggle utility (smokes / flashes / traps)">✦ Utility</button>
        <button class="speed heat" id="ace-heat" title="Match heatmap — where each side dies across the whole match">▦ Heatmap</button>
        <button class="speed cam on" id="ace-cam" title="Director camera — auto-frames the action like a broadcast observer; off = full map">🎥 Director</button>
        <button class="speed snd on" id="ace-snd" title="Broadcast audio — kills, plants, the spike countdown">🔊 Sound</button>
        <button class="speed pov" id="ace-pov" title="Team POV — fog of war: see only what YOUR five see (off = observer view)">⬢ Team POV</button>
      </div>
      <div class="strip" id="ace-strip"></div>`;
    left.appendChild(ctl);
    stage.appendChild(left);

    // right: scoreboard + kill feed
    const rail = el('div', 'ace-rail');

    const board = el('div', 'ace-panel');
    board.innerHTML = `<h3><span class="b"></span>Scoreboard</h3>`;
    ([0, 1] as const).forEach(ti => {
      const tm = this.tl.teams[ti];
      const sec = el('div', 'bteam');
      sec.innerHTML = `<div class="bhead ${ti === 0 ? 'att' : 'def'}"><span>${tm.tag}<i class="bbuy"></i></span><span class="blabel">K</span><span class="blabel">D</span><span class="blabel">+/-</span></div>`;
      const rows = el('div', 'brows');
      tm.players.forEach(p => {
        const row = el('div', 'brow');
        row.innerHTML = `<span class="bh">${p.handle}${p.agent ? `<i class="bagent">${p.agent}</i>` : ''}${p.igl ? '<i class="bigl">IGL</i>' : ''}</span><span class="bk">0</span><span class="bd">0</span><span class="bkd">0</span>`;
        rows.appendChild(row);
        this.scoreEls.set(p.handle, {
          row, k: row.querySelector('.bk') as HTMLElement, d: row.querySelector('.bd') as HTMLElement, kd: row.querySelector('.bkd') as HTMLElement,
        });
      });
      sec.appendChild(rows);
      board.appendChild(sec);
      this.boardWraps[ti] = rows;
      this.buyEls[ti] = sec.querySelector('.bbuy') as HTMLElement;
    });
    rail.appendChild(board);

    // True Odds: the engine re-ran every round 120× to find its real win chance
    const odds = el('div', 'ace-panel');
    odds.innerHTML = `<h3><span class="b"></span>True Odds <span class="oddsub">${this.tl.rounds[0]?.['winPct'] != null ? '· 120× re-sim/round' : ''}</span></h3><div class="oddsnow" id="ace-oddsnow"></div>`;
    const chart = el('div', 'oddschart');
    this.oddsChart = chart;
    this.rebuildOdds();
    odds.appendChild(chart);
    rail.appendChild(odds);
    this.oddsNow = odds.querySelector('#ace-oddsnow') as HTMLElement;

    const panel = el('div', 'ace-panel');
    panel.innerHTML = `<h3><span class="b"></span>Kill Feed</h3><div class="feed" id="ace-feed"><div class="empty">Round in progress…</div></div>`;
    rail.appendChild(panel);
    const info = el('div', 'ace-panel');
    info.innerHTML = `<h3><span class="b"></span>Match</h3><div class="devnote">Generated by <b>@ace/engine</b> from a seed. Every route is an A* path on the map's navmesh; every duel turns on who sees whom (vision cones), the utility thrown (smokes/flashes), and each player's form on the night. Because the engine is a pure function, every round is re-simulated 120× to show its <b>true odds</b> — which wins were robbery, which losses were chokes.</div>`;
    rail.appendChild(info);
    stage.appendChild(rail);
    this.root.appendChild(stage);
    this.xray = el('div', 'ace-xray'); this.root.appendChild(this.xray);   // duel x-ray overlay

    this.playBtn = ctl.querySelector('#ace-play') as HTMLElement;
    this.timer = ctl.querySelector('#ace-timer') as HTMLElement;
    this.seek = ctl.querySelector('#ace-seek') as HTMLElement;
    this.seekFill = ctl.querySelector('#ace-fill') as HTMLElement;
    this.seekHead = ctl.querySelector('#ace-headd') as HTMLElement;
    this.strip = ctl.querySelector('#ace-strip') as HTMLElement;
    this.feed = rail.querySelector('#ace-feed') as HTMLElement;

    this.playBtn.onclick = () => { if (this.showHeat) this.toggleHeat(); if (this.ended) this.scrubTo(0); this.playing = !this.playing; this.playBtn.textContent = this.playing ? '❚❚' : '▶'; this.last = null; };
    (ctl.querySelector('#ace-speed') as HTMLElement).onclick = (e) => { this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1; (e.target as HTMLElement).textContent = this.speed + '×'; };
    this.coneBtn = ctl.querySelector('#ace-vis') as HTMLElement;
    this.coneBtn.onclick = () => { this.showCones = !this.showCones; this.coneBtn.classList.toggle('on', this.showCones); this.render(); };
    if (!this.nav) { this.showCones = false; this.coneBtn.classList.remove('on'); this.coneBtn.style.display = 'none'; }
    this.utilBtn = ctl.querySelector('#ace-util') as HTMLElement;
    this.utilBtn.onclick = () => { this.showUtil = !this.showUtil; this.utilBtn.classList.toggle('on', this.showUtil); this.abLayer.style.display = this.showUtil ? '' : 'none'; this.render(); };
    this.heatBtn = ctl.querySelector('#ace-heat') as HTMLElement;
    this.heatBtn.onclick = () => this.toggleHeat();
    this.povBtn = ctl.querySelector('#ace-pov') as HTMLElement;
    if (this.pov == null) this.povBtn.style.display = 'none';
    else {
      this.povBtn.classList.toggle('on', this.povOn);
      this.povBtn.onclick = () => { this.povOn = !this.povOn; this.povBtn!.classList.toggle('on', this.povOn); this.ghosts.clear(); this.render(); };
    }
    this.sndBtn = ctl.querySelector('#ace-snd') as HTMLElement;
    this.sndBtn.classList.toggle('on', this.sfx.enabled);
    this.sndBtn.onclick = () => { this.sfx.enabled = !this.sfx.enabled; this.sndBtn.classList.toggle('on', this.sfx.enabled); };
    this.camBtn = ctl.querySelector('#ace-cam') as HTMLElement;
    this.camBtn.onclick = () => {
      this.camAuto = !this.camAuto;
      this.camBtn.classList.toggle('on', this.camAuto);
      if (!this.camAuto) { this.cam = null; this.mapSvg.setAttribute('viewBox', this.playViewBox()); }
      this.snapNext = true; this.render();
    };
    (ctl.querySelector('#ace-prev') as HTMLElement).onclick = () => this.loadRound(Math.max(0, this.roundIdx - 1));
    (ctl.querySelector('#ace-next') as HTMLElement).onclick = () => this.loadRound(Math.min(this.tl.rounds.length - 1, this.roundIdx + 1));
    const seekTo = (clientX: number) => { const r = this.seek.getBoundingClientRect(); this.scrubTo(Math.max(0, Math.min(1, (clientX - r.left) / r.width))); };
    let drag = false;
    this.seek.addEventListener('mousedown', e => { drag = true; this.playing = false; this.playBtn.textContent = '▶'; seekTo(e.clientX); });
    window.addEventListener('mousemove', e => { if (drag) seekTo(e.clientX); });
    window.addEventListener('mouseup', () => { drag = false; this.last = null; });

    this.rebuildStrip();
  }

  /** Flash a broadcast moment banner over the map — the crowd beat (FIRST BLOOD, ACE,
   *  CLUTCH, SPIKE PLANTED…). One element; a new moment replaces the last (the animation
   *  restarts via a reflow). Suppressed in the heatmap analysis view. */
  private announce(cls: string, html: string, dur = 1700) {
    if (this.showHeat) return;
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.banner.className = 'ace-banner';
    void this.banner.getBoundingClientRect();   // restart the entrance animation
    this.banner.innerHTML = html;
    this.banner.className = 'ace-banner show ' + cls;
    this.bannerTimer = setTimeout(() => { this.banner.className = 'ace-banner'; }, dur);
  }
  private clearBanner() { if (this.bannerTimer) clearTimeout(this.bannerTimer); this.bannerTimer = null; this.banner.className = 'ace-banner'; this.banner.innerHTML = ''; }

  /** Rebuild the round strip from the current timeline (idempotent — used on the
   *  initial build AND when live playback unlocks new rounds). */
  private rebuildStrip() {
    this.strip.innerHTML = '';
    this.tl.rounds.forEach((r, i) => {
      const pip = el('span', 'pip ' + (r.winner === 0 ? 'w0' : 'w1'));
      pip.title = `Round ${r.n}`;
      pip.onclick = () => this.loadRound(i);
      this.strip.appendChild(pip);
    });
    Array.from(this.strip.children).forEach((c, idx) => c.classList.toggle('cur', idx === this.roundIdx));
  }

  /** Rebuild the True-Odds chart from the current timeline (same idempotency). */
  private rebuildOdds() {
    this.oddsChart.innerHTML = '';
    this.oddsBars = [];
    this.tl.rounds.forEach((r, i) => {
      const p0 = (r.attacker === 0 ? r.winPct : 1 - r.winPct);        // team-0 (att-colour) win chance
      const won0 = r.winner === 0;
      const favored0 = p0 >= 0.5;
      const upset = favored0 !== won0;
      const col = el('div', 'ocol' + (upset ? ' upset' : ''));
      col.title = `Round ${r.n}`;
      // bar grows from the 50% midline toward the favoured team
      const mag = Math.round(Math.abs(p0 - 0.5) * 200);               // 0..100 (% of half-height)
      const bar = el('div', 'obar ' + (favored0 ? 'a' : 'd'));
      bar.style.height = mag + '%';
      bar.style[favored0 ? 'bottom' : 'top'] = '50%';
      const cap = el('div', 'ocap ' + (won0 ? 'a' : 'd'));            // who actually won
      col.append(bar, cap);
      col.onclick = () => this.loadRound(i);
      this.oddsChart.appendChild(col);
      this.oddsBars.push(col);
    });
  }

  /** Match heatmap: aggregate WHERE each side dies across every round into a density
   *  field. A kill's death-spot is the victim's reconstructed position at the kill `t`
   *  (the same posWithDepart the playback uses), tinted by the victim's side. Built fresh
   *  each toggle so it reflects the current (possibly still-live, completed-rounds-only)
   *  timeline — never a spoiler. */
  private buildHeat() {
    this.heatLayer.innerHTML = '';
    const HEAT_R = 46;
    let n0 = 0, n1 = 0;
    for (const r of this.tl.rounds) {
      const moves = new Map<string, { path: Vec2[]; departT: number; arrive: number; pauses?: Pause[]; legs?: Leg[] }>();
      for (const e of r.events) if (e.kind === 'move') moves.set(e.agent, { path: e.path, departT: e.departT ?? 0, arrive: e.arrive, pauses: e.pauses });
      for (const e of r.events) {
        if (e.kind !== 'kill') continue;
        const v = moves.get(e.victim);
        if (!v) continue;
        const p = posLegs(v, v.legs, e.t);
        const side = this.teamOf.get(e.victim) ?? 0;
        side === 0 ? n0++ : n1++;
        const c = svg('circle');
        c.setAttribute('cx', String(p[0])); c.setAttribute('cy', String(p[1])); c.setAttribute('r', String(HEAT_R));
        c.setAttribute('fill', `url(#heat${side})`);
        this.heatLayer.appendChild(c);
      }
    }
    this.heatLegend.innerHTML = `<div class="hk-h">▦ where each side died · ${this.tl.rounds.length} rounds</div>`
      + `<div class="hk-row"><i class="hk-dot a"></i>${this.tl.teams[0].tag}<b>${n0}</b></div>`
      + `<div class="hk-row"><i class="hk-dot d"></i>${this.tl.teams[1].tag}<b>${n1}</b></div>`
      + `<div class="hk-sub">brighter = more kills there</div>`;
  }

  /** Toggle the match heatmap — an analysis overlay, so it pauses playback and hides the
   *  live agents/cones/utility (CSS, via `heat-on`) to read the density cleanly. */
  private toggleHeat() {
    this.showHeat = !this.showHeat;
    this.heatBtn.classList.toggle('on', this.showHeat);
    this.mapSvg.classList.toggle('heat-on', this.showHeat);
    this.heatLegend.classList.toggle('show', this.showHeat);
    if (this.showHeat) {
      this.playing = false; this.playBtn.textContent = '▶'; this.clearAdvance(); this.hideEndCard(); this.buildHeat();
      // the aggregate view reads on the FULL map — park the director camera
      this.cam = null; this.mapSvg.setAttribute('viewBox', this.playViewBox());
    } else this.snapNext = true;
  }

  // ── duel x-ray: click a kill → reconstruct WHY it resolved, from the same geometry
  // the engine duels on (vision cones + LOS, active utility, the trade window). The
  // product's core bet ("a tactical instrument you can x-ray") made literal. ────────
  /** Reconstruct a round's agents (path/facing/side) for the x-ray — playback's data. */
  private roundRecs(r: Round): Map<string, { path: Vec2[]; departT: number; arrive: number; hold: Vec2; side: 0 | 1; pauses?: Pause[]; legs?: Leg[] }> {
    const m = new Map<string, { path: Vec2[]; departT: number; arrive: number; hold: Vec2; side: 0 | 1; pauses?: Pause[]; legs?: Leg[] }>();
    for (const e of r.events) if (e.kind === 'move') m.set(e.agent, { path: e.path, departT: e.departT ?? 0, arrive: e.arrive, hold: e.hold ?? headingAtEnd(e.path), side: this.teamOf.get(e.agent) ?? 0, pauses: e.pauses, legs: e.legs });
    return m;
  }
  /** Is the segment a→b wall-clear (the engine's LOS, sampled on the navmesh)? */
  private segClear(a: Vec2, b: Vec2): boolean {
    if (!this.nav) return true;
    const steps = Math.max(8, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 12));
    for (let i = 1; i < steps; i++) { const u = i / steps; if (!this.walkAt(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u)) return false; }
    return true;
  }
  /** Does `from` (facing unit `f`) have `to` inside its ~120° cone AND a clear line? —
   *  exactly the engine's `inView` test, so the verdict matches the resolved duel. */
  private seesTarget(from: Vec2, f: Vec2, to: Vec2): boolean {
    const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1;
    const fl = Math.hypot(f[0], f[1]) || 1;
    const dot = (dx / len) * (f[0] / fl) + (dy / len) * (f[1] / fl);
    if (Math.acos(Math.max(-1, Math.min(1, dot))) > FOV_HALF) return false;
    return this.segClear(from, to);
  }
  /** The engine's `coverOf`, mirrored on the same walkAt sampling: how much of a
   *  body at `to` is protected from a shooter at `from` — the target's shoulder
   *  points (±w perpendicular to the sightline) are covered when inside a wall or
   *  wall-blocked from the shooter (0 open · 0.5 corner peek · 1 sliver). */
  private coverFrac(from: Vec2, to: Vec2, w = 12): number {
    if (!this.nav) return 0;
    const dx = to[0] - from[0], dy = to[1] - from[1], d = Math.hypot(dx, dy);
    if (d < 1e-6) return 0;
    const px = -dy / d, py = dx / d;
    let cov = 0;
    for (const o of [-w, w]) {
      const s: Vec2 = [to[0] + px * o, to[1] + py * o];
      if (!this.walkAt(s[0], s[1]) || !this.segClear(from, s)) cov++;
    }
    return cov / 2;
  }
  /** Does an ENEMY smoke sit on the sightline p1→p2? Mirrors the engine's one-way
   *  blindedThrough for the fog: your own clouds never blind you. Wall smokes are
   *  checked as their capsule (segment-to-segment distance). */
  private smokeBlocked(viewerTeam: 0 | 1, p1: Vec2, p2: Vec2): boolean {
    for (const ab of this.abilities) {
      if (ab.ability !== 'smoke' || ab.side === viewerTeam || ab.at == null || ab.r == null) continue;
      if (this.T < ab.t || this.T > (ab.until ?? ab.t)) continue;
      const at = ab.at as Vec2, at2 = (ab as { at2?: Vec2 }).at2;
      if (at2) {
        const mir: Vec2 = [2 * at[0] - at2[0], 2 * at[1] - at2[1]];   // the capsule spans at2 ↔ its mirror through the centre
        if (this.segSegDist(p1, p2, at2, mir) <= (ab.r as number)) return true;
      } else if (this.pointSegDist(at, p1, p2) <= (ab.r as number)) return true;
    }
    return false;
  }
  /** Min distance between segments a→b and c→d (mirrors the engine's segSegDist). */
  private segSegDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
    const o = (p: Vec2, q: Vec2, r2: Vec2) => (q[0] - p[0]) * (r2[1] - p[1]) - (q[1] - p[1]) * (r2[0] - p[0]);
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    if (((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0))) return 0;
    return Math.min(this.pointSegDist(c, a, b), this.pointSegDist(d, a, b), this.pointSegDist(a, c, d), this.pointSegDist(b, c, d));
  }
  private pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
  }
  private inCircle = (p: Vec2, c: Vec2, r: number) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r;
  private xrayReport(r: Round, e: Extract<Round['events'][number], { kind: 'kill' }>) {
    const recs = this.roundRecs(r);
    const K = recs.get(e.killer), V = recs.get(e.victim);
    const at = (rec?: { path: Vec2[]; departT: number; arrive: number; hold: Vec2; pauses?: Pause[]; legs?: Leg[] }): Vec2 => rec ? posLegs(rec, rec.legs, e.t) : [500, 500];
    const face = (rec?: { path: Vec2[]; departT: number; arrive: number; hold: Vec2; pauses?: Pause[]; legs?: Leg[] }): Vec2 => rec ? faceLegs(rec, rec.legs, rec.hold, e.t) : [1, 0];
    const pK = at(K), pV = at(V), fK = face(K), fV = face(V);
    const kSeesV = this.seesTarget(pK, fK, pV), vSeesK = this.seesTarget(pV, fV, pK);
    // cover counts only for a SET fighter (the engine's isSet: holding, arrived,
    // or paused at a spot) — mirrored so the factor never claims cover for a runner
    const setAt = (rec?: { path: Vec2[]; departT: number; arrive: number; pauses?: Pause[]; legs?: Leg[] }): boolean => {
      if (!rec) return false;
      const l = legAt(rec, rec.legs, e.t);   // set-ness is a property of the ACTIVE leg
      if (e.t <= l.departT) return true;
      if (e.t - l.departT - (l.pauses ? pausedTime(l.pauses, e.t) : 0) >= l.arrive) return true;
      return (l.pauses ?? []).some(p => e.t >= p.t && e.t <= p.t + p.dur);
    };
    const covK = setAt(K) ? this.coverFrac(pV, pK) : 0;
    const covV = setAt(V) ? this.coverFrac(pK, pV) : 0;
    const dist = Math.hypot(pK[0] - pV[0], pK[1] - pV[1]);
    const abils = r.events.filter((a): a is Extract<Round['events'][number], { kind: 'ability' }> => a.kind === 'ability' && !!a.at && a.until != null && a.t <= e.t && (a.until as number) >= e.t);
    const smoke = abils.find(a => a.ability === 'smoke' && this.pointSegDist(a.at as Vec2, pK, pV) <= (a.r as number));
    const flash = abils.find(a => (a.ability === 'flash' || a.ability === 'recon') && a.side !== V?.side && this.inCircle(pV, a.at as Vec2, a.r as number));
    const trap = abils.find(a => a.ability === 'trap' && a.side === K?.side && this.inCircle(pV, a.at as Vec2, a.r as number));
    const traded = r.events.some(k => k.kind === 'kill' && k.killer === e.victim && e.t - k.t > 0 && e.t - k.t <= 0.04);
    // the headline verdict, from the cones (the engine's first-shot edge is decisive)
    const verdict = kSeesV && !vSeesK ? { tag: 'BACKSTAB', cls: 'back', text: `${e.killer} caught ${e.victim} unaware — the decisive first shot.` }
      : kSeesV && vSeesK ? { tag: 'EVEN GUNFIGHT', cls: 'even', text: `Both aware of each other — won on the aim (form / loadout edge).` }
      : !kSeesV && vSeesK ? { tag: 'OFF-ANGLE', cls: 'off', text: `${e.victim} had the look, but ${e.killer} held the angle and won the trade.` }
      : { tag: 'BLIND DUEL', cls: 'blind', text: `Neither had a clean cone — a close, scrappy break.` };
    const factors: { icon: string; text: string }[] = [];
    if (traded) factors.push({ icon: '⇄', text: `Trade — ${e.victim} had just fragged and was punished` });
    if (e.hs) factors.push({ icon: '⊙', text: `Headshot — a clean one-tap, ${e.victim} never got to shoot back` });
    if (e.hp != null && e.hp <= 50) factors.push({ icon: '♥', text: `${e.killer} walked away at ${e.hp}hp — wounded into the next fight` });
    if (covK >= 0.5) factors.push({ icon: '⛨', text: `${e.killer} was set in cover — ${covK >= 1 ? 'only a sliver of body exposed' : 'a shoulder tucked behind the corner'}` });
    if (covV >= 0.5) factors.push({ icon: '⛨', text: `${e.victim} had cover and still lost the exchange` });
    if (smoke) factors.push({ icon: '◍', text: `A ${smoke.side === K?.side ? 'friendly' : 'enemy'} smoke sat on the sightline` });
    if (flash) factors.push({ icon: '✲', text: `${e.victim} was caught by a ${flash.ability}` });
    if (trap) factors.push({ icon: '◇', text: `${e.victim} tripped ${e.killer}'s side's trap` });
    // weapon range identity (mirrors the engine's W_RANGE bands: close ≤70, long ≥125)
    const sniper = (w: string) => w === 'Operator' || w === 'Marshal';
    if (sniper(e.weapon) && dist >= 125) factors.push({ icon: '⌖', text: `A set ${e.weapon} on a long angle — snipers own this distance` });
    if (dist <= 70 && sniper(e.weapon)) factors.push({ icon: '⌖', text: `${e.weapon} up close — a risky win, snipers crumble when rushed` });
    factors.push({ icon: '↔', text: `${dist < 130 ? 'Close' : dist > 360 ? 'Long' : 'Mid'} range · ${Math.round(dist)}u` });
    return { pK, pV, fK, fV, kSeesV, vSeesK, smoke, verdict, factors, covK, covV, kSide: K?.side ?? 0, vSide: V?.side ?? 1 };
  }
  /** Open the x-ray card for one kill: the verdict, the factors, and a cropped map
   *  diagram of the duel (the killer's cone, the sightline, both agents). */
  private openXray(r: Round, e: Extract<Round['events'][number], { kind: 'kill' }>) {
    const x = this.xrayReport(r, e);
    const sc = (s: 0 | 1) => (s === 0 ? 'att' : 'def');
    // crop the map to the duel (bbox of both agents + the smoke if it's on the line)
    const pts = [x.pK, x.pV, ...(x.smoke ? [x.smoke.at as Vec2] : [])];
    const pad = 150;
    const minX = Math.max(0, Math.min(...pts.map(p => p[0])) - pad), maxX = Math.min(1000, Math.max(...pts.map(p => p[0])) + pad);
    const minY = Math.max(0, Math.min(...pts.map(p => p[1])) - pad), maxY = Math.min(1000, Math.max(...pts.map(p => p[1])) + pad);
    const w = Math.max(maxX - minX, maxY - minY);   // square viewBox so the diagram isn't skewed
    const cone = this.nav ? this.conePath(x.pK, x.fK) : '';
    const dot = (p: Vec2, s: 0 | 1, unaware: boolean) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(w * 0.022).toFixed(1)}" class="xd-dot ${sc(s)}"/>${unaware ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(w * 0.04).toFixed(1)}" class="xd-unaware"/>` : ''}`;
    // shield bracket on a covered fighter — drawn on the shoulder(s) the wall protects
    // (recomputed from the same walkAt/segClear sampling the cover factor used)
    const shield = (p: Vec2, from: Vec2) => {
      const dx = p[0] - from[0], dy = p[1] - from[1], d = Math.hypot(dx, dy) || 1;
      const px = -dy / d, py = dx / d, R = w * 0.036;
      let out = '';
      for (const s of [-1, 1]) {
        const sp: Vec2 = [p[0] + px * 12 * s, p[1] + py * 12 * s];
        if (!this.walkAt(sp[0], sp[1]) || !this.segClear(from, sp)) {
          const m = Math.atan2(py * s, px * s), a0 = m - 0.75, a1 = m + 0.75;
          out += `<path d="M ${(p[0] + Math.cos(a0) * R).toFixed(1)} ${(p[1] + Math.sin(a0) * R).toFixed(1)} A ${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${(p[0] + Math.cos(a1) * R).toFixed(1)} ${(p[1] + Math.sin(a1) * R).toFixed(1)}" class="xd-cover"/>`;
        }
      }
      return out;
    };
    const arrow = (p: Vec2, f: Vec2) => { const fl = Math.hypot(f[0], f[1]) || 1, L = w * 0.07; return `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${(p[0] + f[0] / fl * L).toFixed(1)}" y2="${(p[1] + f[1] / fl * L).toFixed(1)}" class="xd-face"/>`; };
    const diagram = `<svg viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${w.toFixed(1)}" class="xd-svg" preserveAspectRatio="xMidYMid slice">
        <image href="${this.mapUrl}" x="0" y="0" width="1000" height="1000" preserveAspectRatio="none"/>
        <rect x="${minX}" y="${minY}" width="${w}" height="${w}" class="xd-scrim"/>
        ${cone ? `<path d="${cone}" class="xd-cone ${sc(x.kSide)}"/>` : ''}
        <line x1="${x.pK[0].toFixed(1)}" y1="${x.pK[1].toFixed(1)}" x2="${x.pV[0].toFixed(1)}" y2="${x.pV[1].toFixed(1)}" class="xd-line ${x.verdict.cls}"/>
        ${x.smoke ? `<circle cx="${(x.smoke.at as Vec2)[0]}" cy="${(x.smoke.at as Vec2)[1]}" r="${x.smoke.r}" class="xd-smoke"/>` : ''}
        ${arrow(x.pV, x.fV)}${arrow(x.pK, x.fK)}
        ${dot(x.pV, x.vSide, x.kSeesV && !x.vSeesK)}${dot(x.pK, x.kSide, false)}
        ${x.covK >= 0.5 ? shield(x.pK, x.pV) : ''}${x.covV >= 0.5 ? shield(x.pV, x.pK) : ''}
      </svg>`;
    this.xray.innerHTML = `
      <div class="xr-card">
        <button class="xr-x">✕</button>
        <div class="xr-head"><b class="kr ${sc(x.kSide)}">${e.killer}</b><span class="xr-wp">${e.weapon}</span><b class="vc ${sc(x.vSide)}">${e.victim}</b></div>
        <div class="xr-verdict ${x.verdict.cls}"><span class="xr-tag">${x.verdict.tag}</span>${x.verdict.text}</div>
        <div class="xr-diagram">${diagram}<div class="xr-legend"><i class="xl-k ${sc(x.kSide)}">▲ ${e.killer}</i><i class="xl-v ${sc(x.vSide)}">▲ ${e.victim}</i><i class="xl-cone">cone = who they see</i></div></div>
        <div class="xr-factors">${x.factors.map(f => `<span class="xr-f"><i>${f.icon}</i>${f.text}</span>`).join('')}</div>
        <div class="xr-foot">Round ${r.n} · ${Math.round(e.t * 100)}% in · reconstructed from the engine's vision + utility geometry</div>
      </div>`;
    this.xray.classList.add('show');
    (this.xray.querySelector('.xr-x') as HTMLElement).onclick = () => this.closeXray();
    this.xray.onclick = ev => { if (ev.target === this.xray) this.closeXray(); };
  }
  private closeXray() { this.xray.classList.remove('show'); this.xray.innerHTML = ''; }

  /** Swap in a longer timeline mid-watch WITHOUT resetting playback — the live-watch
   *  feed: the server ships more completed rounds as the broadcast plays out. Rebuilds
   *  the strip + odds, clamps the current round, and resumes from a live-tail hold if
   *  fresh rounds arrived. `live=false` (the resolve flip) re-enables the match-final
   *  card so the finale plays normally. */
  setTimeline(tl: MatchTimeline, opts: { live?: boolean } = {}) {
    const grew = tl.rounds.length > this.tl.rounds.length;
    this.tl = tl;
    this.live = !!opts.live;
    tl.teams.forEach((tm, i) => tm.players.forEach(p => this.teamOf.set(p.handle, i as 0 | 1)));
    this.rebuildStrip();
    this.rebuildOdds();
    this.roundIdx = Math.min(this.roundIdx, tl.rounds.length - 1);
    // if we were parked at the live tail (last completed round done, waiting), and new
    // rounds have unlocked, roll on into the next one.
    if (grew && this.liveWaiting) { this.liveWaiting = false; this.hideEndCard(); this.loadRound(this.roundIdx + 1); }
    else this.roundChrome(this.roundIdx);
  }

  private loadRound(i: number) {
    if (this.showHeat) this.toggleHeat();   // leaving the aggregate view back into round playback
    this.roundIdx = i;
    this.liveWaiting = false;   // navigating into a round means we're no longer parked at the live tail
    const r = this.tl.rounds[i];
    this.clearAdvance();
    this.T = 0; this.fired = -1; this.ended = false; this.playing = true; this.last = null;
    this.playBtn.textContent = '❚❚'; this.hideEndCard();
    // quick fade so a new round eases in rather than hard-cutting from the result card
    this.mapSvg.classList.remove('round-in'); void this.mapSvg.getBoundingClientRect(); this.mapSvg.classList.add('round-in');
    this.agLayer.innerHTML = ''; this.trLayer.innerHTML = ''; this.coneLayer.innerHTML = ''; this.abLayer.innerHTML = '';
    this.snapNext = true;   // fresh round — smoothing state snaps to the first frame
    // utility with map geometry (older timelines without `at` are simply skipped).
    // Each ability gets ONE persistent node, built here and ANIMATED per frame as a pure
    // function of round-time (bloom in, hold, dissipate) — scrub- and pause-correct, and
    // no per-frame DOM churn.
    this.abilities = r.events.filter((e): e is Extract<typeof e, { kind: 'ability' }> => e.kind === 'ability' && (e as { at?: Vec2 }).at != null);
    this.abNodes = this.abilities.filter(e => e.r != null).map(e => {
      const side = e.side === r.attacker ? 'att' : 'def';
      const R = e.ability === 'trap' ? (e.r as number) : (e.r as number) * AB_VIS_SCALE;
      const g = svg('g') as SVGGElement;
      g.setAttribute('class', `ace-abg ab-${e.ability} ${side}`);
      g.setAttribute('transform', `translate(${(e.at as Vec2)[0].toFixed(1)},${(e.at as Vec2)[1].toFixed(1)})`);
      g.style.display = 'none';
      const at2 = (e as { at2?: Vec2 }).at2;
      if (e.ability === 'smoke' && at2) {
        // a WALL smoke — a capsule from the centre through at2 (mirrored): drawn as
        // a rounded rect rotated onto the axis, blooming out from the middle
        const at = e.at as Vec2;
        const hl = Math.hypot(at2[0] - at[0], at2[1] - at[1]);
        const ang = Math.atan2(at2[1] - at[1], at2[0] - at[0]) * 180 / Math.PI;
        const rr = (e.r as number) * 1.25;
        const rect = (cls: string) => `<rect class="${cls}" x="${(-hl).toFixed(1)}" y="${(-rr).toFixed(1)}" width="${(2 * hl).toFixed(1)}" height="${(2 * rr).toFixed(1)}" rx="${rr.toFixed(1)}"/>`;
        g.innerHTML = `<g transform="rotate(${ang.toFixed(1)})"><g class="abscale">${rect('abf-cap')}${rect('abe-cap')}</g></g>`;
        this.abLayer.appendChild(g);
        return { e, g, c1: null as unknown as SVGCircleElement, c2: null as unknown as SVGCircleElement, R,
                 wall: g.querySelector('.abscale') as SVGGElement, wallEdge: g.querySelector('.abe-cap') as SVGRectElement };
      }
      g.innerHTML = e.ability === 'smoke' ? '<circle class="abf"/><circle class="abe"/><circle class="absw"/>'
        : e.ability === 'trap' ? '<circle class="abt"/><circle class="abeye" r="3.2"/>'
        : '<circle class="abb"/><circle class="abcore"/>';
      this.abLayer.appendChild(g);
      return { e, g, c1: g.children[0] as SVGCircleElement, c2: g.children[1] as SVGCircleElement, R,
               sw: e.ability === 'smoke' ? g.children[2] as SVGCircleElement : undefined };
    });
    this.feed.innerHTML = '<div class="empty">Round in progress…</div>'; this.feedItems = []; this.lastKill.clear();
    // seek-bar EVENT TICKS — where this round's kills/plant/defuse sit in time, so
    // the round's rhythm reads at a glance and you can scrub straight to the action
    this.seek.querySelectorAll('.tick').forEach(n2 => n2.remove());
    for (const e of r.events) {
      if (e.kind !== 'kill' && e.kind !== 'plant' && e.kind !== 'defuse') continue;
      const d = el('div', 'tick ' + (e.kind === 'kill' ? 'k ' + (this.teamOf.get(e.killer) === r.attacker ? 'att' : 'def') : e.kind));
      d.style.left = (e.t * 100).toFixed(1) + '%';
      d.title = e.kind === 'kill' ? `${e.killer} ▸ ${e.victim}` : e.kind === 'plant' ? 'spike planted' : 'spike defused';
      this.seek.appendChild(d);
    }
    this.spike.classList.remove('on'); this.spikePos = null; this.spikePlantT = Infinity;
    // reset the moment layer for the fresh round, then call the round in like a broadcast
    this.killsInRound.clear(); this.firstBloodDone = false; this.lastClutch = null; this.clearBanner();
    const atkCls = r.attacker === 0 ? 'att' : 'def';
    this.announce('roundstart', `<i>ROUND ${r.n}</i><b class="${atkCls}">${this.tl.teams[r.attacker].tag}</b><s>attack ${r.site}</s>`, 1500);
    this.lastSpikeTick = -1;
    if (this.playing) this.sfx.roundStart();

    // deaths
    const death = new Map<string, number>();
    for (const e of r.events) if (e.kind === 'kill' && !death.has(e.victim)) death.set(e.victim, e.t);

    this.agents = r.events.filter(e => e.kind === 'move').map(e => {
      const mv = e as Extract<typeof e, { kind: 'move' }>;
      const side: 'att' | 'def' = this.teamOf.get(mv.agent) === r.attacker ? 'att' : 'def';
      const cone = svg('path') as SVGPathElement; cone.setAttribute('class', 'ace-cone ' + side); this.coneLayer.appendChild(cone);
      const g = svg('g') as SVGGElement; g.setAttribute('class', 'ace-ag ' + side);
      const npw = mv.agent.length * 6.2 + 11;   // nameplate pill width estimate (Chakra Petch ~6px/char)
      g.innerHTML = `<circle class="clutch-ring" r="17"></circle><circle class="hp" r="15" transform="rotate(-90)"></circle><circle class="ring ${side}" r="12"></circle><circle class="core ${side}" r="4.5"></circle><text class="xm" y="4.5">✕</text>`
        + `<g class="np"><rect class="np-bg" x="${(-npw / 2).toFixed(1)}" y="-27" width="${npw.toFixed(1)}" height="14" rx="2.5"></rect><text class="hl ${side}" y="-16.5">${mv.agent}</text></g>`;
      g.setAttribute('transform', `translate(${mv.path[0][0]},${mv.path[0][1]})`);
      g.style.cursor = 'pointer';
      g.onclick = () => {   // FOLLOW CAM: click a player → the director locks on; click again to release
        this.followHandle = this.followHandle === mv.agent ? null : mv.agent;
        if (this.followHandle && !this.camAuto) { this.camAuto = true; this.camBtn.classList.add('on'); }
      };
      this.agLayer.appendChild(g);
      const tr = svg('polyline') as SVGPolylineElement; tr.setAttribute('class', 'ace-trail ' + side); this.trLayer.appendChild(tr);
      // older timelines predate `hold`; fall back to the final path heading
      const hold: Vec2 = mv.hold ?? headingAtEnd(mv.path);
      return { handle: mv.agent, side, path: mv.path, arrive: mv.arrive, departT: mv.departT ?? 0, deathT: death.get(mv.agent) ?? null, hold, node: g, trail: tr, tp: [], cone, pauses: mv.pauses ?? [], ff: [], hpEv: [], hpEl: g.querySelector('.hp') as SVGCircleElement, legs: mv.legs, rox: 0, roy: 0, rang: null };
    });

    // FOG reveals from GUNFIRE: every kill/exchange involves one of each team, so
    // both participants' positions are known to both teams for a beat. Ghost markers
    // (last-known position) reset with the round.
    this.fireReveals = [];
    for (const e of r.events) {
      if (e.kind === 'kill') { this.fireReveals.push({ h: e.killer, t: e.t }, { h: e.victim, t: e.t }); }
      else if (e.kind === 'dmg') this.fireReveals.push({ h: e.from, t: e.t });
    }
    this.ghosts.clear();
    for (const el2 of this.ghostEls.values()) el2.remove();
    this.ghostEls.clear();

    // live HP, reconstructed from the round's dmg/kill events (the engine's own
    // attrition data): each hit stamps the TARGET's remaining hp, each kill the
    // WINNER's — so the map shows who's hurt, scrub-correct at any T.
    {
      const byH = new Map(this.agents.map(a => [a.handle, a] as const));
      for (const e of r.events) {
        if (e.kind === 'dmg') byH.get(e.to)?.hpEv.push({ t: e.t, hp: e.hp });
        else if (e.kind === 'kill' && e.hp != null) byH.get(e.killer)?.hpEv.push({ t: e.t, hp: e.hp });
      }
    }

    // fight-face windows (mirrors the engine): after each kill the winner looks down the
    // kill line for a beat, and BOTH sides of a non-lethal exchange watch each other —
    // reconstructed from the kill/dmg events' positions, so the cones snap onto the
    // fight exactly where the engine's did.
    const byHandle = new Map(this.agents.map(a => [a.handle, a] as const));
    const faceAt = (fromH: string, toH: string, t: number, dur: number) => {
      const k = byHandle.get(fromH), v = byHandle.get(toH);
      if (!k || !v) return;
      const kp = posLegs(k, k.legs, t, k.hitch);
      const vp = posLegs(v, v.legs, t, v.hitch);
      const d = Math.hypot(vp[0] - kp[0], vp[1] - kp[1]);
      if (d > 1e-6) k.ff.push({ from: t, until: t + dur, dir: [(vp[0] - kp[0]) / d, (vp[1] - kp[1]) / d] });
    };
    for (const e of r.events) {
      if (e.kind === 'kill') faceAt(e.killer, e.victim, e.t, FIGHT_FACE);
      else if (e.kind === 'dmg') faceAt(e.from, e.to, e.t, GRAZE_FACE);
      // footsteps: the engine emits an explicit facing override when an agent
      // TURNS toward a heard sound — replay it so the head-turn shows on the map
      else if (e.kind === 'face') byHandle.get(e.agent)?.ff.push({ from: e.t, until: e.until, dir: e.dir });
    }

    // trap STUTTER: an agent whose path crosses an ENEMY trap was slowed by the
    // engine (its `arrive` already carries TRAP_SLOW). Surface that as a visible
    // hitch — pause the motion at the crossing — so you SEE the lurk get tripped
    // instead of just walking uniformly slower. Replays the engine's pathHitsZone.
    const traps = this.abilities.filter(a => a.ability === 'trap' && a.at != null && a.r != null);
    if (traps.length) for (const a of this.agents) {
      if (a.path.length < 2) continue;
      const aSide = a.side === 'att' ? r.attacker : (r.attacker === 0 ? 1 : 0);   // a's own team index
      for (const t of traps) {
        if (t.side === aSide) continue;                 // your own side's trap never slows you
        const f = trapEntryFrac(a.path, t.at as Vec2, t.r as number);
        if (f == null) continue;
        const dur = Math.min(HITCH_DUR, a.arrive * 0.5);
        const tHit = (a.arrive - dur) * (1 - Math.sqrt(1 - f));
        a.hitch = { frac: f, dur, start: a.departT + tHit, end: a.departT + tHit + dur };
        break;                                          // first trap crossed is enough
      }
    }

    // SPAWN FAN (viewer-only): real teams spawn spread across the barrier, then group
    // up to execute. The engine starts attackers near one point (balance is tuned
    // around that exact geometry — separating them in the sim re-tunes the whole pool),
    // so we render the separation as a cosmetic flourish: fan the attackers across a
    // shared perpendicular at spawn, collapsing onto the engine path by SPAWN_CONVERGE.
    // Pure render — no contract/engine change, determinism + map balance untouched.
    const atkAgs = this.agents.filter(a => a.side === 'att' && a.path.length >= 2);
    if (atkAgs.length > 1) {
      let hx = 0, hy = 0;                               // mean spawn→destination heading
      for (const a of atkAgs) { const s = a.path[0], e = a.path[a.path.length - 1]; hx += e[0] - s[0]; hy += e[1] - s[1]; }
      const hl = Math.hypot(hx, hy) || 1;
      const perp: Vec2 = [-hy / hl, hx / hl];           // the barrier line is perpendicular to the push
      const n = atkAgs.length;
      atkAgs.forEach((a, i) => { const lane = (i - (n - 1) / 2) * SPAWN_FAN; a.spawnFan = [perp[0] * lane, perp[1] * lane]; });
    }

    // spike location = planter position at plant time
    const plant = r.events.find(e => e.kind === 'plant') as Extract<Round['events'][number], { kind: 'plant' }> | undefined;
    if (plant) {
      const planter = this.agents.find(a => a.handle === plant.agent);
      if (planter) { this.spikePlantT = plant.t; this.spikePos = posLegs(planter, planter.legs, plant.t, planter.hitch); }
    }

    this.roundLabel.innerHTML = `<b>ROUND ${r.n}</b> · <span class="${r.attacker === 0 ? 'att' : 'def'}">${this.tl.teams[r.attacker].tag}</span> attacking site ${r.site}`;
    // per-team ATK/DEF this round (the attacker alternates; the team colours don't)
    ([0, 1] as const).forEach(ti => { const atk = ti === r.attacker; this.sideTags[ti].textContent = atk ? 'ATTACK' : 'DEFENSE'; this.sideTags[ti].className = 'tside ' + (atk ? 'atk' : 'def'); });
    Array.from(this.strip.children).forEach((c, idx) => c.classList.toggle('cur', idx === i));
    this.roundChrome(i);
    this.updateBoard(0);
    this.render();
  }

  /** Running score (no spoiler) + the current round's true-odds verdict. */
  private roundChrome(i: number) {
    const r = this.tl.rounds[i];
    let s0 = 0, s1 = 0;
    for (let ri = 0; ri < i; ri++) (this.tl.rounds[ri].winner === 0 ? s0++ : s1++);
    this.scoreA.textContent = String(s0); this.scoreB.textContent = String(s1);
    // MATCH POINT — a side one round from closing it (first to 13). Both at 12 = overtime nerves.
    const mp0 = s0 >= 12, mp1 = s1 >= 12;
    this.mpt.innerHTML = mp0 && mp1 ? `<span class="both">MATCH POINT · BOTH</span>`
      : mp0 ? `<span class="att">MATCH POINT · ${this.tl.teams[0].tag}</span>`
      : mp1 ? `<span class="def">MATCH POINT · ${this.tl.teams[1].tag}</span>` : '';

    // each team's buy this round — an IN-GAME call made by the in-game leader
    ([0, 1] as const).forEach(ti => {
      const b = r.economy?.buy?.[String(ti) as '0' | '1'];
      const e = this.buyEls[ti];
      if (!b) { e.textContent = ''; e.removeAttribute('title'); return; }
      e.textContent = BUY_LABEL[b] ?? b.toUpperCase();
      e.className = 'bbuy ' + b;
      const igl = this.tl.teams[ti].players.find(p => p.igl);
      e.title = igl ? `${BUY_LABEL[b] ?? b} — the IGL's call (${igl.handle} runs the economy)` : (BUY_LABEL[b] ?? b);
    });

    if (r.winPct == null) { this.oddsNow.textContent = ''; return; }
    const pAtk = r.winPct;
    const fav = (pAtk >= 0.5 ? r.attacker : 1 - r.attacker) as 0 | 1;
    const favPct = Math.round(Math.max(pAtk, 1 - pAtk) * 100);
    const upset = fav !== r.winner, coin = favPct <= 56;
    const favTag = this.tl.teams[fav].tag, winTag = this.tl.teams[r.winner].tag;
    const favCls = fav === 0 ? 'att' : 'def', winCls = r.winner === 0 ? 'att' : 'def';
    const verdict = upset ? `<b class="${winCls}">${winTag}</b> stole it ⚡`
      : coin ? `<b class="${winCls}">${winTag}</b> took the coin-flip`
      : `<b class="${winCls}">${winTag}</b> closed it`;
    this.oddsNow.innerHTML = `<span class="opct ${favCls}">${favPct}%</span><span class="olabel"><b class="${favCls}">${favTag}</b> favoured · ${verdict}</span>`;
    this.oddsNow.classList.toggle('isupset', upset);
    this.oddsBars.forEach((c, idx) => c.classList.toggle('cur', idx === i));
  }

  /** Broadcast round-result card, revealed when playback reaches the end of a round
   *  (not a spoiler — the round is over). Winner tricode + how it was won. */
  private showEndCard() {
    const r = this.tl.rounds[this.roundIdx];
    const winCls = r.winner === 0 ? 'att' : 'def';
    const method: Record<string, string> = { detonation: 'Spike detonated', defuse: 'Spike defused', elimination: 'Team eliminated', time: 'Time expired' };
    // the round's star: its top fragger (ties broken by first to reach the count)
    let mvpH = '', mvpK = 0;
    for (const [h, k] of this.killsInRound) if (k > mvpK) { mvpK = k; mvpH = h; }
    const mvpCls = this.teamOf.get(mvpH) === 0 ? 'att' : 'def';
    // a THRIFTY: winning the round on a save/eco while the loser was fully bought
    const buyW = r.economy?.buy?.[String(r.winner) as '0' | '1'];
    const buyL = r.economy?.buy?.[String(1 - r.winner) as '0' | '1'];
    const thrifty = buyW === 'eco' && buyL === 'full';
    this.endCard.className = 'ace-endcard show ' + winCls;
    this.endCard.innerHTML = `<div class="ec-tag">${this.tl.teams[r.winner].tag}</div><div class="ec-win">Round won${thrifty ? ' · <em class="ec-thrifty">THRIFTY</em>' : ''}</div>`
      + `<div class="ec-method">${method[r.method] ?? r.method} · ${r.winner === r.attacker ? 'attack' : 'defense'}</div>`
      + (mvpK >= 2 ? `<div class="ec-mvp">★ <b class="${mvpCls}">${mvpH}</b> · ${mvpK}K</div>` : '');
  }
  private hideEndCard() { if (this.endCard) { this.endCard.className = 'ace-endcard'; this.endCard.innerHTML = ''; } }

  /** Match-final card on the last round: winner, final score, and top fragger. */
  private showMatchCard() {
    const [a, b] = this.tl.finalScore;
    const win = a >= b ? 0 : 1, winCls = win === 0 ? 'att' : 'def';
    const kills = new Map<string, number>();
    for (const r of this.tl.rounds) for (const e of r.events) if (e.kind === 'kill') kills.set(e.killer, (kills.get(e.killer) ?? 0) + 1);
    let topH = '', topK = -1;
    for (const [h, k] of kills) if (k > topK) { topK = k; topH = h; }
    this.endCard.className = 'ace-endcard show matchend ' + winCls;
    this.endCard.innerHTML = `<div class="ec-label">Match Final</div><div class="ec-tag">${this.tl.teams[win].tag}</div>`
      + `<div class="ec-score"><span class="att">${a}</span><span class="ec-dash">—</span><span class="def">${b}</span></div>`
      + `<div class="ec-method">${this.tl.teams[win].name} win${topH ? ` · top frag ${topH} ${topK}` : ''}</div>`;
  }

  /** Live tail: we've watched every round broadcast so far and are caught up to the
   *  live feed — hold here (no spoiler) until the next round is decided on air. */
  private showLiveTail() {
    this.endCard.className = 'ace-endcard show live';
    this.endCard.innerHTML = `<div class="ec-label">● LIVE</div><div class="ec-win">Caught up to the broadcast</div>`
      + `<div class="ec-method">Round ${this.tl.rounds.length + 1} is being decided…</div>`;
  }

  private scrubTo(frac: number) {
    const r = this.tl.rounds[this.roundIdx];
    this.clearAdvance();
    this.T = frac; this.fired = -1; this.ended = false; this.hideEndCard();
    this.feed.innerHTML = ''; this.feedItems = []; this.lastKill.clear(); this.spike.classList.remove('on');
    this.killsInRound.clear(); this.firstBloodDone = false; this.lastClutch = null; this.clearBanner();
    this.snapNext = true;   // a scrub jumps time — smoothing state snaps, never lags in
    this.agents.forEach(a => { a.node.classList.remove('dead'); a.tp = []; a.trail.setAttribute('points', ''); });
    r.events.forEach(e => { if ((e.kind === 'kill' || e.kind === 'plant' || e.kind === 'defuse') && e.t <= frac) this.fire(e, false); });
    this.fired = frac;
    if (this.feedItems.length === 0) this.feed.innerHTML = '<div class="empty">Round in progress…</div>';
    this.boardDirty = false; this.updateBoard(frac);
    this.render();
  }

  private fire(e: Round['events'][number], live = true) {
    if (e.kind === 'kill') {
      if (this.feedItems.length === 0) this.feed.innerHTML = '';
      const kc = this.teamOf.get(e.killer) === this.tl.rounds[this.roundIdx].attacker ? 'att' : 'def';
      const vc = kc === 'att' ? 'def' : 'att';
      const d = el('div', 'kill ' + kc);                  // left accent = the killer's colour
      // a trade: this kill drops someone who themselves killed in the last ~3s
      const lk = this.lastKill.get(e.victim);
      const traded = lk != null && e.t - lk <= 0.04;
      this.lastKill.set(e.killer, e.t);
      // moment tallies — always counted (scrubs replay silently), announced only live
      const fb = !this.firstBloodDone; this.firstBloodDone = true;
      const streak = (this.killsInRound.get(e.killer) ?? 0) + 1; this.killsInRound.set(e.killer, streak);
      const mkTag = streak >= 3 ? `<span class="mk s${streak}">${streak >= 5 ? 'ACE' : streak + 'K'}</span>` : '';
      // attrition made visible: a winner who barely survived shows their exit HP
      const hpTag = e.hp != null && e.hp <= 50 ? `<span class="khp${e.hp <= 25 ? ' crit' : ''}" title="the winner walked away at ${e.hp}hp — wounded into the next fight">${e.hp}hp</span>` : '';
      d.innerHTML = `${fb ? '<span class="fbtag" title="first blood">FB</span>' : ''}${traded ? '<span class="trade" title="traded">⇄</span>' : ''}<span class="kr ${kc}">${e.killer}</span>${hpTag}<span class="wp">${e.weapon}${e.hs ? '<em class="hstag" title="headshot — a clean one-tap">⊙</em>' : ''}</span><span class="vc ${vc}">${e.victim}</span>${mkTag}<i class="kill-xray" title="x-ray this duel">⌕</i>`;
      const ke = e; d.classList.add('clickable'); d.onclick = () => this.openXray(this.tl.rounds[this.roundIdx], ke);   // duel x-ray
      this.feed.appendChild(d); this.feedItems.push(d);
      while (this.feedItems.length > 7) this.feedItems.shift()!.remove();
      const v = this.agents.find(a => a.handle === e.victim);
      const k = this.agents.find(a => a.handle === e.killer);
      if (v) {
        v.node.classList.add('dead');
        // on-map kill beat (live only — replaying past kills on a scrub shouldn't re-pop):
        // an expanding ring at the death spot + a TRACER from the killer, so the eye is
        // drawn to where the fight happened and who took it.
        if (live) {
          const dp = posLegs(v, v.legs, e.t, v.hitch);
          const pop = svg('g') as SVGGElement; pop.setAttribute('class', 'ace-killpop ' + vc);
          pop.setAttribute('transform', `translate(${dp[0].toFixed(1)},${dp[1].toFixed(1)})`);
          pop.innerHTML = `<circle class="kp-ring" r="5"></circle>`;
          this.agLayer.appendChild(pop);
          setTimeout(() => pop.remove(), 680);
          if (k) {
            const kp = posLegs(k, k.legs, e.t, k.hitch);
            const tr = svg('line');
            tr.setAttribute('class', 'ace-tracer ' + kc);
            tr.setAttribute('x1', kp[0].toFixed(1)); tr.setAttribute('y1', kp[1].toFixed(1));
            tr.setAttribute('x2', dp[0].toFixed(1)); tr.setAttribute('y2', dp[1].toFixed(1));
            this.trLayer.appendChild(tr);
            setTimeout(() => tr.remove(), 640);
          }
        }
      }
      // the crowd beats, called live: the opening kill, then the multikill ladder
      if (live) {
        if (streak === 5) { this.announce('acek', `<i>ACE</i><b class="${kc}">${e.killer}</b><s>all five</s>`, 2600); this.sfx.multi(5); }
        else if (streak === 4) { this.announce('mkb', `<i>QUAD KILL</i><b class="${kc}">${e.killer}</b>`, 1900); this.sfx.multi(4); }
        else if (streak === 3) { this.announce('mkb', `<i>TRIPLE KILL</i><b class="${kc}">${e.killer}</b>`, 1700); this.sfx.multi(3); }
        else if (fb) { this.announce('fb', `<i>FIRST BLOOD</i><b class="${kc}">${e.killer}</b>`, 1500); this.sfx.fb(); }
        else this.sfx.kill(e.hs);
      }
      this.boardDirty = true;
    } else if (e.kind === 'dmg') {
      // a non-lethal exchange: shots fired, nobody drops — a THIN tracer + a hit flash
      // on the target (live only; the feed stays kills-only so it doesn't spam)
      if (!live) return;
      const from = this.agents.find(a => a.handle === e.from);
      const to = this.agents.find(a => a.handle === e.to);
      if (from && to) {
        const fp = posLegs(from, from.legs, e.t, from.hitch);
        const tp = posLegs(to, to.legs, e.t, to.hitch);
        const fc = this.teamOf.get(e.from) === this.tl.rounds[this.roundIdx].attacker ? 'att' : 'def';
        const tr = svg('line');
        tr.setAttribute('class', 'ace-tracer graze ' + fc);
        tr.setAttribute('x1', fp[0].toFixed(1)); tr.setAttribute('y1', fp[1].toFixed(1));
        tr.setAttribute('x2', tp[0].toFixed(1)); tr.setAttribute('y2', tp[1].toFixed(1));
        this.trLayer.appendChild(tr);
        setTimeout(() => tr.remove(), 500);
        to.node.classList.add('hit');
        setTimeout(() => to.node.classList.remove('hit'), 360);
        this.sfx.graze();
      }
    } else if (e.kind === 'plant') {
      this.spike.classList.add('on');
      if (this.feedItems.length === 0) this.feed.innerHTML = '';
      const d = el('div', 'kill event'); d.textContent = `◆ Spike planted · ${e.site} site`;
      this.feed.appendChild(d); this.feedItems.push(d);
      if (live) { this.announce('plant', `<i>SPIKE PLANTED</i><s>${e.site} site — retake or lose it</s>`, 1800); this.sfx.plant(); }
    } else if (e.kind === 'defuse') {
      if (live) this.sfx.defuse();
      this.spike.classList.remove('on');
      if (this.feedItems.length === 0) this.feed.innerHTML = '';
      const d = el('div', 'kill event defuse'); d.textContent = `◇ Spike defused · ${e.agent}`;
      this.feed.appendChild(d); this.feedItems.push(d);
    }
  }

  // --- scoreboard: kills/deaths through the current moment ------------------
  /** Tally every kill up to (round roundIdx, fraction frac) and repaint. */
  private updateBoard(frac: number) {
    const s = this.scores; s.clear();
    for (const tm of this.tl.teams) for (const p of tm.players) s.set(p.handle, { k: 0, d: 0 });
    for (let ri = 0; ri <= this.roundIdx; ri++) {
      const cur = ri === this.roundIdx;
      for (const e of this.tl.rounds[ri].events) {
        if (e.kind !== 'kill' || (cur && e.t > frac)) continue;
        s.get(e.killer)!.k++; s.get(e.victim)!.d++;
      }
    }
    // who's down right now (this round, up to frac) — for the live alive/dead board
    this.deadNow.clear();
    for (const e of this.tl.rounds[this.roundIdx].events) if (e.kind === 'kill' && e.t <= frac) this.deadNow.add(e.victim);
    this.renderBoard();
    this.renderAlive();
  }
  /** The scorebar's 5-pip alive counters — the at-a-glance 5v4 read every broadcast HUD has. */
  private renderAlive() {
    ([0, 1] as const).forEach(ti => {
      const pips = this.aliveEls[ti].children;
      this.tl.teams[ti].players.forEach((p, i) => { if (pips[i]) pips[i].className = this.deadNow.has(p.handle) ? 'down' : ''; });
    });
  }
  /** Sort each team by kills and repaint the rows (top fragger first). */
  private renderBoard() {
    ([0, 1] as const).forEach(ti => {
      const handles = this.tl.teams[ti].players.map(p => p.handle)
        .sort((a, b) => { const A = this.scores.get(a)!, B = this.scores.get(b)!; return (B.k - A.k) || ((B.k - B.d) - (A.k - A.d)); });
      const wrap = this.boardWraps[ti];
      let top = -Infinity;
      handles.forEach((h, i) => {
        const sc = this.scores.get(h)!, els = this.scoreEls.get(h)!;
        els.k.textContent = String(sc.k); els.d.textContent = String(sc.d);
        const diff = sc.k - sc.d; els.kd.textContent = (diff > 0 ? '+' : '') + diff;
        els.kd.className = 'bkd ' + (diff > 0 ? 'pos' : diff < 0 ? 'neg' : '');
        if (i === 0) top = sc.k;
        els.row.classList.toggle('top', sc.k === top && sc.k > 0); // highlight the night's best
        els.row.classList.toggle('down', this.deadNow.has(h));     // dim players who are down this round
        wrap.appendChild(els.row); // reorder in place
      });
    });
  }

  /** Frame the SVG on the map's actual play area (the navmesh's walkable bounds,
   *  squared + padded) so the minimap fills the viewport instead of floating in a
   *  black 1000×1000 void. Everything is in image space, so agents/cones/labels
   *  scale up with it — more readable, more broadcast. Falls back to full frame. */
  private playViewBox(): string {
    if (!this.nav) return '0 0 1000 1000';
    const { cell, cols, rows, walk } = this.nav;
    let minc = cols, minr = rows, maxc = -1, maxr = -1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (walk[r * cols + c] === 1) {
      if (c < minc) minc = c; if (c > maxc) maxc = c; if (r < minr) minr = r; if (r > maxr) maxr = r;
    }
    if (maxc < minc) return '0 0 1000 1000';
    const pad = cell * 2.5;
    let x0 = minc * cell - pad, y0 = minr * cell - pad;
    let w = (maxc - minc + 1) * cell + pad * 2, h = (maxr - minr + 1) * cell + pad * 2;
    const size = Math.max(w, h);                       // square it (container is square) and centre the play area
    x0 -= (size - w) / 2; y0 -= (size - h) / 2; w = h = size;
    return `${x0.toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
  }

  // --- vision: clip a facing cone against the same walls the engine sees ----
  private walkAt(x: number, y: number): boolean {
    const nav = this.nav!; const c = Math.floor(x / nav.cell), r = Math.floor(y / nav.cell);
    return c >= 0 && c < nav.cols && r >= 0 && r < nav.rows && nav.walk[r * nav.cols + c] === 1;
  }
  /** Furthest distance from p along unit dir that is still visible — i.e. the
   *  reach of the cone edge. Uses the engine's own LOS sampling (losClear at
   *  cell*0.6) and only advances while the whole segment stays clear, so the
   *  cone never sees through a wall the engine wouldn't. */
  private rayHit(p: Vec2, dir: Vec2): number {
    const probe = this.nav!.cell * 0.6, n = Math.ceil(VISION / probe);
    let last = 0;
    for (let i = 1; i <= n; i++) {
      const d = Math.min(VISION, i * probe);
      if (!this.walkAt(p[0] + dir[0] * d, p[1] + dir[1] * d)) break;
      last = d;
    }
    return last;
  }
  /** The nearest walkable point to `c` (a small outward spiral) — so an ability
   *  whose nominal centre sits in a wall still anchors in the space it covers. */
  private nearestWalkable(c: Vec2): Vec2 | null {
    if (this.walkAt(c[0], c[1])) return c;
    const step = this.nav!.cell;
    for (let ring = 1; ring <= 7; ring++)
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2, x = c[0] + Math.cos(ang) * ring * step, y = c[1] + Math.sin(ang) * ring * step;
        if (this.walkAt(x, y)) return [x, y];
      }
    return null;
  }
  /** SVG path for the wall-clipped vision cone at p facing unit f. */
  private conePath(p: Vec2, f: Vec2): string {
    const base = Math.atan2(f[1], f[0]);
    let d = `M${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    for (let i = 0; i <= CONE_RAYS; i++) {
      const ang = base - FOV_HALF + (2 * FOV_HALF) * (i / CONE_RAYS);
      const dir: Vec2 = [Math.cos(ang), Math.sin(ang)];
      const hit = this.rayHit(p, dir);
      d += ` L${(p[0] + dir[0] * hit).toFixed(1)} ${(p[1] + dir[1] * hit).toFixed(1)}`;
    }
    return d + 'Z';
  }

  private render(dt = 16.7) {
    const snap = this.snapNext; this.snapNext = false;
    if (snap) { this.ghosts.clear(); this.lastSeenNow = new Set(); }
    // utility on the map: persistent keyed nodes, ANIMATED as a pure function of
    // round-time T (scrub/pause-correct — never wall-clock): a smoke BLOOMS to its
    // gameplay dome, holds, then DISSIPATES as it expires; a flash/recon BURSTS and
    // fades; a trap ARMS (grows in) and its dashes sweep slowly like a live sensor.
    if (this.showUtil) for (const n of this.abNodes) {
      const t0 = n.e.t, t1 = n.e.until ?? n.e.t;
      if (this.T < t0 || this.T > t1) { n.g.style.display = 'none'; continue; }
      n.g.style.display = '';
      const prog = (this.T - t0) / Math.max(0.02, t1 - t0);
      if (n.e.ability === 'smoke') {
        const bloom = easeOut(clamp01((this.T - t0) / AB_BLOOM));
        const fade = clamp01((t1 - this.T) / AB_FADE);
        if (n.wall) {
          // the wall blooms out from its midpoint; its rim dashes DRIFT with round
          // time (pure function of T — scrub-correct), so the cloud reads alive
          n.wall.setAttribute('transform', `scale(${(0.2 + 0.8 * bloom).toFixed(3)})`);
          n.wallEdge!.setAttribute('stroke-dashoffset', ((this.T - t0) * 700).toFixed(1));
          n.g.style.opacity = (0.3 + 0.7 * Math.min(bloom, fade)).toFixed(2);
        } else {
          const r = n.R * (0.25 + 0.75 * bloom);
          n.c1.setAttribute('r', r.toFixed(1)); n.c2.setAttribute('r', r.toFixed(1));
          if (n.sw) {
            // the inner SWIRL: a dashed ring slowly rotating with round time
            n.sw.setAttribute('r', (r * 0.58).toFixed(1));
            n.sw.setAttribute('transform', `rotate(${(((this.T - t0) * 560) % 360).toFixed(1)})`);
          }
          n.g.style.opacity = (0.3 + 0.7 * Math.min(bloom, fade)).toFixed(2);
        }
      } else if (n.e.ability === 'trap') {
        const arm = easeOut(clamp01((this.T - t0) / AB_ARM));
        n.c1.setAttribute('r', Math.max(1, n.R * arm).toFixed(1));
        n.c1.setAttribute('transform', `rotate(${((this.T - t0) * 220).toFixed(1)})`);   // the sensor sweep
        n.g.style.opacity = (0.45 + 0.55 * arm).toFixed(2);
      } else {   // flash / recon: a burst that expands and burns out
        n.c1.setAttribute('r', (n.R * (0.35 + 0.65 * easeOut(prog))).toFixed(1));
        n.c2.setAttribute('r', Math.max(0.5, n.R * 0.22 * (1 - prog)).toFixed(1));
        n.g.style.opacity = (0.15 + 0.85 * (1 - prog)).toFixed(2);
      }
    }
    const cones = this.showCones && !!this.nav;
    // PASS 1 — base position for every agent (with the spawn fan applied)
    const frame = this.agents.map(a => {
      const dead = a.deathT != null && this.T >= a.deathT;
      const prog = dead ? a.deathT! : this.T;
      const base = posLegs(a, a.legs, prog, a.hitch);
      const p: Vec2 = [base[0], base[1]];   // copy — posWithDepart can return the path[0] ref
      if (a.spawnFan && !dead && prog < SPAWN_CONVERGE) {
        const k = 1 - prog / SPAWN_CONVERGE; p[0] += a.spawnFan[0] * k; p[1] += a.spawnFan[1] * k;
      }
      return { a, dead, prog, p, bx: p[0], by: p[1] };   // b = pre-separation base (exact engine-mirrored position)
    });
    // PASS 2 — separate overlapping same-side bodies so a hold reads as a spread
    // defense, not a pile on one point. WALL-AWARE: a push is applied only if the
    // pushed position stays walkable, so bodies slide apart along open ground and
    // are never shoved through a wall (which used to teleport them via the snap).
    for (let it = 0; it < SEP_ITERS; it++) {
      for (let i = 0; i < frame.length; i++) {
        const fi = frame[i]; if (fi.dead) continue;
        for (let j = i + 1; j < frame.length; j++) {
          const fj = frame[j]; if (fj.dead || fj.a.side !== fi.a.side) continue;
          let dx = fj.p[0] - fi.p[0], dy = fj.p[1] - fi.p[1], d = Math.hypot(dx, dy);
          if (d >= SEP_MIN) continue;
          if (d < 1e-3) { dx = i % 2 ? 1 : -1; dy = i % 2 ? 0 : 1; d = 1; }  // exact overlap → deterministic split
          const push = (SEP_MIN - d) / 2, ux = dx / d, uy = dy / d;
          const ix = fi.p[0] - ux * push, iy = fi.p[1] - uy * push;
          if (!this.nav || this.walkAt(ix, iy)) { fi.p[0] = ix; fi.p[1] = iy; }
          const jx = fj.p[0] + ux * push, jy = fj.p[1] + uy * push;
          if (!this.nav || this.walkAt(jx, jy)) { fj.p[0] = jx; fj.p[1] = jy; }
        }
      }
    }
    // FOG OF WAR: which enemies do YOUR five actually see right now? A teammate's
    // real vision (cone + walls + enemy smoke — the engine's own test), a friendly
    // recon/trap sweep, or recent gunfire. Everything else is hidden, leaving a
    // fading last-known-position ghost. Deaths are always known (the feed is
    // broadcast, and every kill involved your team).
    const fogOn = this.povOn && this.pov != null && !this.showHeat;
    const povSide: 'att' | 'def' = this.tl.rounds[this.roundIdx].attacker === this.pov ? 'att' : 'def';
    const seen = new Set<string>();
    if (fogOn) {
      const friendlies = frame.filter(f => !f.dead && f.a.side === povSide);
      for (const f of frame) {
        if (f.a.side === povSide || f.dead) continue;
        const h = f.a.handle, ep: Vec2 = [f.p[0], f.p[1]];
        if (this.fireReveals.some(rv => rv.h === h && this.T >= rv.t && this.T <= rv.t + 0.035)) { seen.add(h); continue; }
        let vis = false;
        for (const ab of this.abilities) {
          if ((ab.ability === 'recon' || ab.ability === 'trap') && ab.side === this.pov && ab.at && ab.r != null
              && this.T >= ab.t && this.T <= (ab.until ?? ab.t)
              && Math.hypot(ep[0] - (ab.at as Vec2)[0], ep[1] - (ab.at as Vec2)[1]) <= (ab.r as number)) { vis = true; break; }
        }
        if (!vis) for (const fr of friendlies) {
          const fp: Vec2 = [fr.p[0], fr.p[1]];
          if (Math.hypot(ep[0] - fp[0], ep[1] - fp[1]) > VISION) continue;
          const face = faceLegs(fr.a, fr.a.legs, fr.a.hold, fr.prog, fr.a.hitch, fr.a.ff);
          if (!this.seesTarget(fp, face, ep)) continue;
          if (this.smokeBlocked(this.pov!, fp, ep)) continue;
          vis = true; break;
        }
        if (vis) { seen.add(h); this.ghosts.delete(h); }
        else {
          // just slipped out of vision → drop a last-known marker at the spot
          const g0 = this.ghosts.get(h);
          if (!g0 && this.lastSeenNow.has(h)) this.ghosts.set(h, { p: ep, t: this.T });
        }
      }
      // remember who was visible THIS frame (ghosts spawn on the visible→hidden edge)
      this.lastSeenNow = seen;
    }

    // CLUTCH: a side down to its last player vs 2+ enemies — flag the lone clutcher,
    // the moment a broadcast lives for. (Pre-plant only — post-plant is its own beat.)
    const liveAtt = frame.filter(f => !f.dead && f.a.side === 'att');
    const liveDef = frame.filter(f => !f.dead && f.a.side === 'def');
    let clutcher: VAg | null = null;
    if (liveAtt.length === 1 && liveDef.length >= 2) clutcher = liveAtt[0].a;
    else if (liveDef.length === 1 && liveAtt.length >= 2) clutcher = liveDef[0].a;
    // the clutch callout — the moment a broadcast lives for, announced once per clutcher
    if (clutcher && this.playing && !this.ended && this.lastClutch !== clutcher.handle) {
      this.lastClutch = clutcher.handle;
      const foes = (clutcher.side === 'att' ? liveDef : liveAtt).length;
      this.announce('clutch', `<i>CLUTCH TIME</i><b class="${clutcher.side}">${clutcher.handle}</b><s>1 v ${foes}</s>`, 2100);
      this.sfx.clutch();
    }
    // PASS 3 — apply, with TEMPORAL SMOOTHING of the separation offset (the relaxation
    // can resolve differently frame to frame in a pile; an exponential lerp of the
    // OFFSET — never the exact engine-mirrored base — turns that jitter into drift).
    // Facing SWEEPS at a capped turn rate, so cones rotate like a player checking an
    // angle instead of snapping. Both are presentation-only: the x-ray/heatmap always
    // reconstruct from the raw engine-mirrored math.
    const k = snap ? 1 : 1 - Math.exp(-dt / SEP_TAU);
    // counter-scale markers against the director zoom (last frame's camera) so a
    // tight frame magnifies the WORLD but keeps rings/nameplates broadcast-sized
    const agK = this.camAuto && this.cam ? Math.max(0.55, Math.min(1, 0.45 + 0.55 * (this.cam.w / this.fullBox.w))) : 1;
    for (const { a, dead, prog, p, bx, by } of frame) {
      if (!dead) {
        a.rox += (p[0] - bx - a.rox) * k; a.roy += (p[1] - by - a.roy) * k;
      }
      const px = bx + a.rox, py = by + a.roy;    // dead: offset frozen at the death frame (no corpse slide)
      const q: Vec2 = this.nav && !dead && !this.walkAt(px, py) ? (this.nearestWalkable([px, py]) ?? [px, py]) : [px, py];
      a.node.setAttribute('transform', `translate(${q[0].toFixed(1)},${q[1].toFixed(1)})${agK !== 1 ? ` scale(${agK.toFixed(3)})` : ''}`);
      // fog: a living unseen enemy doesn't render at all (their trail resets so a
      // reappearance never draws a tell-tale line from where they've been)
      const fogHidden = fogOn && !dead && a.side !== povSide && !seen.has(a.handle);
      a.node.style.display = fogHidden ? 'none' : '';
      if (fogHidden && a.tp.length) { a.tp = []; a.trail.setAttribute('points', ''); }
      a.node.classList.toggle('clutch', a === clutcher);
      a.node.classList.toggle('followed', a.handle === this.followHandle);
      // flash the agent while it's hitched on a trap (the visible "tripped" beat)
      a.node.classList.toggle('tripped', !dead && a.hitch != null && prog >= a.hitch.start && prog <= a.hitch.end);
      // live HP arc — the last hp checkpoint at or before T (scrub-correct); hidden
      // at full health (a clean agent), green fading to amber once hurt, then a
      // wounded (<35) red pulse: who's hurt, at a glance
      if (!dead) {
        let hp = 100;
        for (let hi = a.hpEv.length - 1; hi >= 0; hi--) if (a.hpEv[hi].t <= prog) { hp = a.hpEv[hi].hp; break; }
        a.hpEl.style.display = hp >= 100 ? 'none' : '';
        if (hp < 100) {
          a.hpEl.setAttribute('stroke-dasharray', `${(HP_C * hp / 100).toFixed(1)} ${HP_C.toFixed(1)}`);
          a.hpEl.classList.toggle('h2', hp <= 60 && hp > 35);
          a.hpEl.classList.toggle('h1', hp <= 35);
        }
      }
      if (!dead) { a.tp.push(`${q[0].toFixed(0)},${q[1].toFixed(0)}`); if (a.tp.length > 16) a.tp.shift(); a.trail.setAttribute('points', a.tp.join(' ')); }
      if (cones && !dead && !(fogOn && a.side !== povSide)) {   // fog: enemy view cones are never yours to read
        const f = faceLegs(a, a.legs, a.hold, prog, a.hitch, a.ff);
        const ta = Math.atan2(f[1], f[0]);
        if (a.rang == null || snap) a.rang = ta;
        else {
          let dA = ta - a.rang;
          while (dA > Math.PI) dA -= Math.PI * 2; while (dA < -Math.PI) dA += Math.PI * 2;
          const maxTurn = TURN_RATE * (dt / 1000) * this.speed;   // faster playback, faster flicks
          a.rang += Math.abs(dA) <= maxTurn ? dA : Math.sign(dA) * maxTurn;
        }
        a.cone.setAttribute('d', this.conePath(q, [Math.cos(a.rang), Math.sin(a.rang)]));
        a.cone.style.display = '';
      } else a.cone.style.display = 'none';
    }
    // last-known-position GHOSTS: a '?' marker where an enemy slipped out of vision,
    // fading over a few seconds of round time (fog mode only)
    if (fogOn) {
      for (const [h, g0] of this.ghosts) {
        const age = this.T - g0.t;
        const enemy = this.agents.find(a2 => a2.handle === h);
        if (age < 0 || age > 0.07 || (enemy?.deathT != null && this.T >= enemy.deathT)) {
          this.ghosts.delete(h); this.ghostEls.get(h)?.remove(); this.ghostEls.delete(h);
          continue;
        }
        let ge = this.ghostEls.get(h);
        if (!ge) {
          ge = svg('g') as SVGGElement;
          ge.setAttribute('class', 'ace-ghost');
          ge.innerHTML = '<circle r="11"></circle><text y="4.5">?</text>';
          this.agLayer.appendChild(ge);
          this.ghostEls.set(h, ge);
        }
        ge.setAttribute('transform', `translate(${g0.p[0].toFixed(1)},${g0.p[1].toFixed(1)})`);
        ge.style.opacity = (0.75 * (1 - age / 0.07)).toFixed(2);
      }
    } else if (this.ghostEls.size) {
      for (const ge of this.ghostEls.values()) ge.remove();
      this.ghostEls.clear(); this.ghosts.clear();
    }
    if (this.spikePos) this.spike.setAttribute('transform', `translate(${this.spikePos[0]},${this.spikePos[1]})`);
    // DIRECTOR CAMERA — frame the story like a broadcast observer. The interest
    // set: agents IN CONTACT (an enemy within ~260u — a fight brewing or live);
    // before any contact, the attacking push (that's the narrative); the spike
    // once planted. The frame is their padded bbox, floor-zoomed so it never
    // over-magnifies, clamped inside the map, and eased exponentially — snapped
    // on round load/scrub so it never lags in.
    if (this.camAuto && !this.showHeat) {
      const live = frame.filter(f => !f.dead);
      const pts: Vec2[] = [];
      // a FOLLOWED player owns the frame (falling back to the action if they're down)
      const fa = this.followHandle ? live.find(f => f.a.handle === this.followHandle
        && !(fogOn && f.a.side !== povSide && !seen.has(f.a.handle))) : null;   // can't follow what you can't see
      if (fa) pts.push([fa.p[0], fa.p[1]]);
      else if (fogOn) {
        // the fog camera must not leak hidden positions: frame YOUR five + what they see
        for (const f of live) if (f.a.side === povSide || seen.has(f.a.handle)) pts.push([f.p[0], f.p[1]]);
        if (this.spikePos && this.T >= this.spikePlantT) pts.push(this.spikePos);
      } else {
        for (const f of live) {
          if (live.some(g => g.a.side !== f.a.side && Math.hypot(g.p[0] - f.p[0], g.p[1] - f.p[1]) < 260)) pts.push([f.p[0], f.p[1]]);
        }
        if (!pts.length) for (const f of live) if (f.a.side === 'att') pts.push([f.p[0], f.p[1]]);
        if (this.spikePos && this.T >= this.spikePlantT) pts.push(this.spikePos);
      }
      if (pts.length) {
        let mnX = 1e9, mnY = 1e9, mxX = -1e9, mxY = -1e9;
        for (const p of pts) { mnX = Math.min(mnX, p[0]); mxX = Math.max(mxX, p[0]); mnY = Math.min(mnY, p[1]); mxY = Math.max(mxY, p[1]); }
        let w = Math.max(CAM_MIN, Math.min(this.fullBox.w, Math.max(mxX - mnX, mxY - mnY) + CAM_PAD * 2));
        const cl = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
        const tx = cl((mnX + mxX) / 2 - w / 2, this.fullBox.x, this.fullBox.x + this.fullBox.w - w);
        const ty = cl((mnY + mxY) / 2 - w / 2, this.fullBox.y, this.fullBox.y + this.fullBox.w - w);
        if (!this.cam || snap) this.cam = { x: tx, y: ty, w };
        else {
          const ck = 1 - Math.exp(-dt / CAM_TAU);
          this.cam.x += (tx - this.cam.x) * ck; this.cam.y += (ty - this.cam.y) * ck; this.cam.w += (w - this.cam.w) * ck;
        }
        this.mapSvg.setAttribute('viewBox', `${this.cam.x.toFixed(1)} ${this.cam.y.toFixed(1)} ${this.cam.w.toFixed(1)} ${this.cam.w.toFixed(1)}`);
      }
    }
    this.seekFill.style.width = (this.T * 100) + '%';
    this.seekHead.style.left = (this.T * 100) + '%';
    // round clock + phase — driven into both the control-bar timer and the broadcast
    // HUD clock (the centerpiece). Switches to the spike timer and goes red on plant.
    const planted = this.T >= this.spikePlantT;
    // the spike COUNTDOWN — a soft tick every ~2s of round time while the spike is
    // down, urgent past the halfway mark. Bucketed by round-time (not wall-clock)
    // and gated on live playback, so pause/scrub never beeps.
    if (planted && this.playing && !this.ended && !this.showHeat) {
      const bucket = Math.floor((this.T - this.spikePlantT) / 0.02);
      if (bucket !== this.lastSpikeTick) { this.lastSpikeTick = bucket; this.sfx.spikeTick(this.T - this.spikePlantT > 0.15); }
    }
    let clk: string;
    if (!planted) { const s = Math.max(0, Math.round(100 - (this.T / 0.6) * 60)); clk = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
    else { const s = Math.max(0, Math.round(45 - ((this.T - this.spikePlantT) / 0.34) * 45)); clk = '0:' + ('0' + s).slice(-2); }
    this.timer.classList.toggle('spike', planted); this.timer.textContent = clk;
    this.clock.textContent = clk; this.clockWrap.classList.toggle('spike', planted);
    this.phase.textContent = planted ? 'Post-plant' : this.T < 0.16 ? 'Round start' : this.T < 0.45 ? 'Map control' : 'Engaging';
  }

  private loop = (ts: number) => {
    if (this.last == null) this.last = ts;
    const dt = ts - this.last; this.last = ts;
    if (this.playing && !this.ended) {
      this.T += (dt / this.DUR) * this.speed;
      const r = this.tl.rounds[this.roundIdx];
      r.events.forEach(e => { if ((e.kind === 'kill' || e.kind === 'plant' || e.kind === 'defuse' || e.kind === 'dmg') && e.t > this.fired && this.T >= e.t) this.fire(e); });
      this.fired = this.T;
      if (this.boardDirty) { this.boardDirty = false; this.updateBoard(this.T); }
      if (this.T >= 1) {
        this.T = 1; this.ended = true; this.playing = false; this.playBtn.textContent = '▶';
        // last round → the match-final card; otherwise the round card + auto-advance.
        // In LIVE mode the "last round" is just the last one BROADCAST so far — don't
        // reveal a final; park at the live tail and wait for setTimeline to bring more.
        if (this.roundIdx < this.tl.rounds.length - 1) { this.showEndCard(); this.advanceTimer = setTimeout(() => this.loadRound(this.roundIdx + 1), 2400); }
        else if (this.live) { this.liveWaiting = true; this.showLiveTail(); }
        else this.showMatchCard();
      }
      this.render(dt);
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}
