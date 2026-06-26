import type { MatchTimeline, Round, Vec2 } from '@ace/shared';

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

/** Position respecting a hold-then-move: stays at path[0] until departT, then
 *  travels over `arrive`. Mirrors the engine's posAt. An optional `hitch` injects
 *  the trap pause without changing where the agent ends up at `arrive`. */
function posWithDepart(path: Vec2[], departT: number, arrive: number, prog: number, hitch?: Hitch): Vec2 {
  if (prog <= departT) return path[0] ?? [0, 0];
  const local = prog - departT;
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

/** Reconstruct where an agent looks at progress `prog`: down its travel vector
 *  while moving, down its held angle while holding or once arrived. Mirrors
 *  engine facingAt(). */
function facingOf(path: Vec2[], departT: number, arrive: number, hold: Vec2, prog: number, hitch?: Hitch): Vec2 {
  const moveEnd = departT + arrive;
  if (prog > departT && prog < moveEnd - 1e-6) {
    const here = posWithDepart(path, departT, arrive, prog, hitch);
    const ahead = posWithDepart(path, departT, arrive, Math.min(moveEnd, prog + 0.02), hitch);
    const dx = ahead[0] - here[0], dy = ahead[1] - here[1];
    if (Math.hypot(dx, dy) > 1e-6) return unit(dx, dy);
  }
  return hold;
}

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

interface VAg {
  handle: string; side: 'att' | 'def'; path: Vec2[]; arrive: number; departT: number; deathT: number | null;
  hold: Vec2; node: SVGGElement; trail: SVGPolylineElement; tp: string[]; cone: SVGPathElement; hitch?: Hitch; spawnFan?: Vec2;
}

const HITCH_DUR = 0.05;     // round-t the viewer pauses a trap-tripped agent (the visible stutter)
const SPAWN_FAN = 34;       // lateral spacing of attackers across the spawn barrier (px, viewer-only)
const SPAWN_CONVERGE = 0.12; // round-t over which the spread spawn collapses onto the engine path
const SEP_MIN = 38;         // min on-screen spacing between same-side bodies — de-stack piles (px, viewer-only)
const SEP_ITERS = 3;        // relaxation passes per frame to resolve overlaps

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
  // live scoreboard (kills/deaths through the current moment) — form made visible
  private scores = new Map<string, { k: number; d: number }>();
  private scoreEls = new Map<string, { row: HTMLElement; k: HTMLElement; d: HTMLElement; kd: HTMLElement }>();
  private boardWraps: [HTMLElement, HTMLElement] = [null as any, null as any];
  private boardDirty = false;

  // dom refs
  private root: HTMLElement;
  private agLayer!: SVGGElement; private trLayer!: SVGGElement; private coneLayer!: SVGGElement; private spike!: SVGGElement;
  private abLayer!: SVGGElement; private utilBtn!: HTMLElement; private showUtil = true;
  private abilities: Extract<Round['events'][number], { kind: 'ability' }>[] = [];   // utility with geometry, for the map
  private feed!: HTMLElement; private feedItems: HTMLElement[] = [];
  private lastKill = new Map<string, number>();   // killer handle -> t, for tagging trades
  private playBtn!: HTMLElement; private timer!: HTMLElement; private seekFill!: HTMLElement; private seekHead!: HTMLElement; private seek!: HTMLElement;
  private phase!: HTMLElement; private roundLabel!: HTMLElement; private strip!: HTMLElement; private coneBtn!: HTMLElement;
  private scoreA!: HTMLElement; private scoreB!: HTMLElement;        // running score (no spoiler)
  private clock!: HTMLElement; private clockWrap!: HTMLElement;      // broadcast round clock (centerpiece)
  private endCard!: HTMLElement;                                     // round-result card shown when playback ends
  private mapSvg!: SVGSVGElement;                                    // the map svg (re-faded on each new round)
  private sideTags: [HTMLElement, HTMLElement] = [null as any, null as any]; // per-team ATK/DEF this round
  private oddsNow!: HTMLElement; private oddsBars: HTMLElement[] = []; // true-odds chart
  private buyEls: [HTMLElement, HTMLElement] = [null as any, null as any]; // per-team buy badge

  constructor(root: HTMLElement, tl: MatchTimeline, mapUrl: string, nav: NavGrid | null = null) {
    this.root = root; this.tl = tl; this.mapUrl = mapUrl; this.nav = nav;
    tl.teams.forEach((tm, i) => tm.players.forEach(p => this.teamOf.set(p.handle, i as 0 | 1)));
    this.build();
    this.loadRound(0);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() { cancelAnimationFrame(this.raf); this.clearAdvance(); }

  private build() {
    const t = this.tl;
    this.root.innerHTML = '';
    // scorebar
    const sb = el('div', 'ace-scorebar');
    sb.innerHTML = `
      <div class="ace-team att">
        <div class="tmeta"><div class="tg">${t.teams[0].name}</div><div class="tside" id="ace-side0"></div></div>
        <div class="tmark att">${t.teams[0].tag}</div>
      </div>
      <div class="ace-scoreblock">
        <div class="sc"><span class="a">0</span><div class="clockwrap" id="ace-clockwrap"><span class="clock" id="ace-clock">1:40</span></div><span class="b">0</span></div>
        <div class="side" id="ace-round">Round 1</div>
        <div class="ctx">${t.map.toUpperCase()} · PATCH ${t.patch} · SEED ${t.seed}</div>
      </div>
      <div class="ace-team def r">
        <div class="tmark def">${t.teams[1].tag}</div>
        <div class="tmeta"><div class="tg">${t.teams[1].name}</div><div class="tside" id="ace-side1"></div></div>
      </div>`;
    this.scoreA = sb.querySelector('.sc .a') as HTMLElement;
    this.scoreB = sb.querySelector('.sc .b') as HTMLElement;
    this.clock = sb.querySelector('#ace-clock') as HTMLElement;
    this.clockWrap = sb.querySelector('#ace-clockwrap') as HTMLElement;
    this.sideTags = [sb.querySelector('#ace-side0') as HTMLElement, sb.querySelector('#ace-side1') as HTMLElement];
    this.root.appendChild(sb);
    this.roundLabel = sb.querySelector('#ace-round') as HTMLElement;

    const stage = el('div', 'ace-stage');
    // left: map + controls
    const left = el('div', 'ace-left');
    const wrap = el('div', 'ace-mapwrap');
    wrap.innerHTML = `<div class="ace-overlay"><span class="ovl" id="ace-phase">Round start</span></div><div class="ace-endcard" id="ace-endcard"></div>`;
    const s = svg('svg'); s.setAttribute('class', 'ace-map'); s.setAttribute('viewBox', this.playViewBox()); this.mapSvg = s as unknown as SVGSVGElement;
    const img = svg('image'); img.setAttribute('href', this.mapUrl); img.setAttribute('x', '0'); img.setAttribute('y', '0'); img.setAttribute('width', '1000'); img.setAttribute('height', '1000'); img.setAttribute('preserveAspectRatio', 'none');
    const scrim = svg('rect'); scrim.setAttribute('x', '0'); scrim.setAttribute('y', '0'); scrim.setAttribute('width', '1000'); scrim.setAttribute('height', '1000'); scrim.setAttribute('class', 'ace-scrim');
    this.abLayer = svg('g') as SVGGElement; this.abLayer.setAttribute('class', 'ace-abils');
    this.coneLayer = svg('g') as SVGGElement; this.coneLayer.setAttribute('class', 'ace-cones');
    this.trLayer = svg('g') as SVGGElement;
    this.spike = svg('g') as SVGGElement; this.spike.setAttribute('class', 'ace-spike');
    this.spike.innerHTML = `<circle class="sp-ring" r="13"></circle><rect class="sp-core" x="-6" y="-6" width="12" height="12" transform="rotate(45)"></rect>`;
    this.agLayer = svg('g') as SVGGElement;
    // utility (smokes/flashes/traps) sits on the map surface, cones above it, then trails/agents
    s.append(img, scrim, this.abLayer, this.coneLayer, this.trLayer, this.spike, this.agLayer);
    wrap.appendChild(s);
    left.appendChild(wrap);
    this.phase = wrap.querySelector('#ace-phase') as HTMLElement;
    this.endCard = wrap.querySelector('#ace-endcard') as HTMLElement;

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
      chart.appendChild(col);
      this.oddsBars.push(col);
    });
    odds.appendChild(chart);
    rail.appendChild(odds);
    this.oddsNow = odds.querySelector('#ace-oddsnow') as HTMLElement;

    const panel = el('div', 'ace-panel');
    panel.innerHTML = `<h3><span class="b"></span>Kill Feed</h3><div class="feed" id="ace-feed"><div class="empty">Round in progress…</div></div>`;
    rail.appendChild(panel);
    const info = el('div', 'ace-panel');
    info.innerHTML = `<h3><span class="b"></span>Match</h3><div class="devnote">Generated by <b>@ace/engine</b> from a seed. Every route is an A* path on Ascent's navmesh; every duel turns on who sees whom (vision cones), the utility thrown (smokes/flashes), and each player's form on the night. Because the engine is a pure function, every round is re-simulated 120× to show its <b>true odds</b> — which wins were robbery, which losses were chokes.</div>`;
    rail.appendChild(info);
    stage.appendChild(rail);
    this.root.appendChild(stage);

    this.playBtn = ctl.querySelector('#ace-play') as HTMLElement;
    this.timer = ctl.querySelector('#ace-timer') as HTMLElement;
    this.seek = ctl.querySelector('#ace-seek') as HTMLElement;
    this.seekFill = ctl.querySelector('#ace-fill') as HTMLElement;
    this.seekHead = ctl.querySelector('#ace-headd') as HTMLElement;
    this.strip = ctl.querySelector('#ace-strip') as HTMLElement;
    this.feed = rail.querySelector('#ace-feed') as HTMLElement;

    this.playBtn.onclick = () => { if (this.ended) this.scrubTo(0); this.playing = !this.playing; this.playBtn.textContent = this.playing ? '❚❚' : '▶'; this.last = null; };
    (ctl.querySelector('#ace-speed') as HTMLElement).onclick = (e) => { this.speed = this.speed === 1 ? 2 : 1; (e.target as HTMLElement).textContent = this.speed + '×'; };
    this.coneBtn = ctl.querySelector('#ace-vis') as HTMLElement;
    this.coneBtn.onclick = () => { this.showCones = !this.showCones; this.coneBtn.classList.toggle('on', this.showCones); this.render(); };
    if (!this.nav) { this.showCones = false; this.coneBtn.classList.remove('on'); this.coneBtn.style.display = 'none'; }
    this.utilBtn = ctl.querySelector('#ace-util') as HTMLElement;
    this.utilBtn.onclick = () => { this.showUtil = !this.showUtil; this.utilBtn.classList.toggle('on', this.showUtil); this.render(); };
    (ctl.querySelector('#ace-prev') as HTMLElement).onclick = () => this.loadRound(Math.max(0, this.roundIdx - 1));
    (ctl.querySelector('#ace-next') as HTMLElement).onclick = () => this.loadRound(Math.min(this.tl.rounds.length - 1, this.roundIdx + 1));
    const seekTo = (clientX: number) => { const r = this.seek.getBoundingClientRect(); this.scrubTo(Math.max(0, Math.min(1, (clientX - r.left) / r.width))); };
    let drag = false;
    this.seek.addEventListener('mousedown', e => { drag = true; this.playing = false; this.playBtn.textContent = '▶'; seekTo(e.clientX); });
    window.addEventListener('mousemove', e => { if (drag) seekTo(e.clientX); });
    window.addEventListener('mouseup', () => { drag = false; this.last = null; });

    // round strip
    this.tl.rounds.forEach((r, i) => {
      const pip = el('span', 'pip ' + (r.winner === 0 ? 'w0' : 'w1'));
      pip.title = `Round ${r.n}`;
      pip.onclick = () => this.loadRound(i);
      this.strip.appendChild(pip);
    });
  }

  private loadRound(i: number) {
    this.roundIdx = i;
    const r = this.tl.rounds[i];
    this.clearAdvance();
    this.T = 0; this.fired = -1; this.ended = false; this.playing = true; this.last = null;
    this.playBtn.textContent = '❚❚'; this.hideEndCard();
    // quick fade so a new round eases in rather than hard-cutting from the result card
    this.mapSvg.classList.remove('round-in'); void this.mapSvg.getBoundingClientRect(); this.mapSvg.classList.add('round-in');
    this.agLayer.innerHTML = ''; this.trLayer.innerHTML = ''; this.coneLayer.innerHTML = ''; this.abLayer.innerHTML = '';
    // utility with map geometry (older timelines without `at` are simply skipped)
    this.abilities = r.events.filter((e): e is Extract<typeof e, { kind: 'ability' }> => e.kind === 'ability' && (e as { at?: Vec2 }).at != null);
    this.feed.innerHTML = '<div class="empty">Round in progress…</div>'; this.feedItems = []; this.lastKill.clear();
    this.spike.classList.remove('on'); this.spikePos = null; this.spikePlantT = Infinity;

    // deaths
    const death = new Map<string, number>();
    for (const e of r.events) if (e.kind === 'kill' && !death.has(e.victim)) death.set(e.victim, e.t);

    this.agents = r.events.filter(e => e.kind === 'move').map(e => {
      const mv = e as Extract<typeof e, { kind: 'move' }>;
      const side: 'att' | 'def' = this.teamOf.get(mv.agent) === r.attacker ? 'att' : 'def';
      const cone = svg('path') as SVGPathElement; cone.setAttribute('class', 'ace-cone ' + side); this.coneLayer.appendChild(cone);
      const g = svg('g') as SVGGElement; g.setAttribute('class', 'ace-ag ' + side);
      const npw = mv.agent.length * 6.2 + 11;   // nameplate pill width estimate (Chakra Petch ~6px/char)
      g.innerHTML = `<circle class="ring ${side}" r="12"></circle><circle class="core ${side}" r="4.5"></circle><text class="xm" y="4.5">✕</text>`
        + `<g class="np"><rect class="np-bg" x="${(-npw / 2).toFixed(1)}" y="-27" width="${npw.toFixed(1)}" height="14" rx="2.5"></rect><text class="hl ${side}" y="-16.5">${mv.agent}</text></g>`;
      g.setAttribute('transform', `translate(${mv.path[0][0]},${mv.path[0][1]})`);
      this.agLayer.appendChild(g);
      const tr = svg('polyline') as SVGPolylineElement; tr.setAttribute('class', 'ace-trail ' + side); this.trLayer.appendChild(tr);
      // older timelines predate `hold`; fall back to the final path heading
      const hold: Vec2 = mv.hold ?? headingAtEnd(mv.path);
      return { handle: mv.agent, side, path: mv.path, arrive: mv.arrive, departT: mv.departT ?? 0, deathT: death.get(mv.agent) ?? null, hold, node: g, trail: tr, tp: [], cone };
    });

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
      if (planter) { this.spikePlantT = plant.t; this.spikePos = posWithDepart(planter.path, planter.departT, planter.arrive, plant.t); }
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

    // each team's buy this round
    ([0, 1] as const).forEach(ti => {
      const b = r.economy?.buy?.[String(ti) as '0' | '1'];
      const e = this.buyEls[ti];
      if (!b) { e.textContent = ''; return; }
      e.textContent = b.toUpperCase();
      e.className = 'bbuy ' + b;
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
    this.endCard.className = 'ace-endcard show ' + winCls;
    this.endCard.innerHTML = `<div class="ec-tag">${this.tl.teams[r.winner].tag}</div><div class="ec-win">Round won</div><div class="ec-method">${method[r.method] ?? r.method} · ${r.winner === r.attacker ? 'attack' : 'defense'}</div>`;
  }
  private hideEndCard() { if (this.endCard) { this.endCard.className = 'ace-endcard'; this.endCard.innerHTML = ''; } }

  private scrubTo(frac: number) {
    const r = this.tl.rounds[this.roundIdx];
    this.clearAdvance();
    this.T = frac; this.fired = -1; this.ended = false; this.hideEndCard();
    this.feed.innerHTML = ''; this.feedItems = []; this.lastKill.clear(); this.spike.classList.remove('on');
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
      d.innerHTML = `${traded ? '<span class="trade" title="traded">⇄</span>' : ''}<span class="kr ${kc}">${e.killer}</span><span class="wp">${e.weapon}</span><span class="vc ${vc}">${e.victim}</span>`;
      this.feed.appendChild(d); this.feedItems.push(d);
      while (this.feedItems.length > 7) this.feedItems.shift()!.remove();
      const v = this.agents.find(a => a.handle === e.victim);
      if (v) {
        v.node.classList.add('dead');
        // on-map kill pop: a brief expanding ring at the death spot draws the eye to
        // the action (live only — replaying past kills on a scrub shouldn't re-pop).
        if (live) {
          const dp = posWithDepart(v.path, v.departT, v.arrive, e.t, v.hitch);
          const pop = svg('g') as SVGGElement; pop.setAttribute('class', 'ace-killpop ' + vc);
          pop.setAttribute('transform', `translate(${dp[0].toFixed(1)},${dp[1].toFixed(1)})`);
          pop.innerHTML = `<circle class="kp-ring" r="5"></circle>`;
          this.agLayer.appendChild(pop);
          setTimeout(() => pop.remove(), 680);
        }
      }
      this.boardDirty = true;
    } else if (e.kind === 'plant') {
      this.spike.classList.add('on');
      if (this.feedItems.length === 0) this.feed.innerHTML = '';
      const d = el('div', 'kill event'); d.textContent = `◆ Spike planted · ${e.site} site`;
      this.feed.appendChild(d); this.feedItems.push(d);
    } else if (e.kind === 'defuse') {
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
    this.renderBoard();
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
  /** SVG path for an ability clipped to the WALLS — cast rays 360° from the centre,
   *  each stopping at the first wall up to `radius`, so a smoke fills the room it's
   *  in (like Valorant) instead of bleeding a perfect circle through walls. */
  private blobPath(c: Vec2, radius: number): string {
    const probe = this.nav!.cell * 0.6, RAYS = 40, n = Math.ceil(radius / probe);
    let d = '';
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      let last = probe;   // a small floor so a ray into a wall doesn't spike to centre
      for (let k = 1; k <= n; k++) {
        const dist = Math.min(radius, k * probe);
        if (!this.walkAt(c[0] + dx * dist, c[1] + dy * dist)) break;
        last = dist;
      }
      d += (i === 0 ? 'M' : 'L') + (c[0] + dx * last).toFixed(1) + ' ' + (c[1] + dy * last).toFixed(1) + ' ';
    }
    return d + 'Z';
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

  private render() {
    // utility on the map: each smoke/flash/trap is a circle active from t..until.
    // smokes read as solid vision-blockers; flashes/recon as a bright burst; traps as
    // a side-tinted dashed watch-ring (an armed sensor). Redrawn each frame.
    this.abLayer.innerHTML = '';
    if (this.showUtil) {
      const att = this.tl.rounds[this.roundIdx].attacker;
      for (const a of this.abilities) {
        const until = a.until ?? a.t;
        if (this.T < a.t || this.T > until || !a.at || !a.r) continue;
        const side = a.side === att ? 'att' : 'def';
        // a flash/recon burst fades over its short window; smokes/traps hold steady
        const burst = a.ability === 'flash' || a.ability === 'recon';
        const op = burst ? ` style="opacity:${((1 - (this.T - a.t) / Math.max(0.02, until - a.t)) * 0.6 + 0.12).toFixed(2)}"` : '';
        const cls = `ace-abil ab-${a.ability} ${side}`;
        // clip to the walls (fills the room, like Valorant) — anchor at the nearest
        // walkable point; fall back to a plain circle only with no navmesh
        const anchor = this.nav ? this.nearestWalkable(a.at) : null;
        const shape = anchor
          ? `<path class="${cls}" d="${this.blobPath(anchor, a.r)}"${op}></path>`
          : `<circle class="${cls}" cx="${a.at[0].toFixed(1)}" cy="${a.at[1].toFixed(1)}" r="${a.r.toFixed(1)}"${op}></circle>`;
        this.abLayer.insertAdjacentHTML('beforeend', shape);
      }
    }
    const cones = this.showCones && !!this.nav;
    // PASS 1 — base position for every agent (with the spawn fan applied)
    const frame = this.agents.map(a => {
      const dead = a.deathT != null && this.T >= a.deathT;
      const prog = dead ? a.deathT! : this.T;
      const base = posWithDepart(a.path, a.departT, a.arrive, prog, a.hitch);
      const p: Vec2 = [base[0], base[1]];   // copy — posWithDepart can return the path[0] ref
      if (a.spawnFan && !dead && prog < SPAWN_CONVERGE) {
        const k = 1 - prog / SPAWN_CONVERGE; p[0] += a.spawnFan[0] * k; p[1] += a.spawnFan[1] * k;
      }
      return { a, dead, prog, p };
    });
    // PASS 2 — separate overlapping same-side bodies so a hold reads as a spread
    // defense, not a pile on one point. A few relaxation passes push close pairs
    // apart; recomputed fresh each frame (no drift). Pure render — engine untouched.
    for (let it = 0; it < SEP_ITERS; it++) {
      for (let i = 0; i < frame.length; i++) {
        const fi = frame[i]; if (fi.dead) continue;
        for (let j = i + 1; j < frame.length; j++) {
          const fj = frame[j]; if (fj.dead || fj.a.side !== fi.a.side) continue;
          let dx = fj.p[0] - fi.p[0], dy = fj.p[1] - fi.p[1], d = Math.hypot(dx, dy);
          if (d >= SEP_MIN) continue;
          if (d < 1e-3) { dx = i % 2 ? 1 : -1; dy = i % 2 ? 0 : 1; d = 1; }  // exact overlap → deterministic split
          const push = (SEP_MIN - d) / 2, ux = dx / d, uy = dy / d;
          fi.p[0] -= ux * push; fi.p[1] -= uy * push; fj.p[0] += ux * push; fj.p[1] += uy * push;
        }
      }
    }
    // PASS 3 — apply (snap to a walkable cell so a nudged body never stands in a wall)
    for (const { a, dead, prog, p } of frame) {
      const q = this.nav && !dead && !this.walkAt(p[0], p[1]) ? (this.nearestWalkable(p) ?? p) : p;
      a.node.setAttribute('transform', `translate(${q[0].toFixed(1)},${q[1].toFixed(1)})`);
      // flash the agent while it's hitched on a trap (the visible "tripped" beat)
      a.node.classList.toggle('tripped', !dead && a.hitch != null && prog >= a.hitch.start && prog <= a.hitch.end);
      if (!dead) { a.tp.push(`${q[0].toFixed(0)},${q[1].toFixed(0)}`); if (a.tp.length > 16) a.tp.shift(); a.trail.setAttribute('points', a.tp.join(' ')); }
      if (cones && !dead) { a.cone.setAttribute('d', this.conePath(q, facingOf(a.path, a.departT, a.arrive, a.hold, prog, a.hitch))); a.cone.style.display = ''; }
      else a.cone.style.display = 'none';
    }
    if (this.spikePos) this.spike.setAttribute('transform', `translate(${this.spikePos[0]},${this.spikePos[1]})`);
    this.seekFill.style.width = (this.T * 100) + '%';
    this.seekHead.style.left = (this.T * 100) + '%';
    // round clock + phase — driven into both the control-bar timer and the broadcast
    // HUD clock (the centerpiece). Switches to the spike timer and goes red on plant.
    const planted = this.T >= this.spikePlantT;
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
      r.events.forEach(e => { if ((e.kind === 'kill' || e.kind === 'plant' || e.kind === 'defuse') && e.t > this.fired && this.T >= e.t) this.fire(e); });
      this.fired = this.T;
      if (this.boardDirty) { this.boardDirty = false; this.updateBoard(this.T); }
      if (this.T >= 1) {
        this.T = 1; this.ended = true; this.playing = false; this.playBtn.textContent = '▶'; this.showEndCard();
        // play on like a broadcast: hold the result card, then roll the next round
        if (this.roundIdx < this.tl.rounds.length - 1) this.advanceTimer = setTimeout(() => this.loadRound(this.roundIdx + 1), 2400);
      }
      this.render();
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}
