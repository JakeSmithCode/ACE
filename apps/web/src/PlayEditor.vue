<script setup lang="ts">
// Drag-to-place play editor. The map is the engine's own 1000×1000 image space
// (same coords A* pathfinds on), rendered as an SVG viewBox so a marker's
// position IS its engine position — no transform to keep in sync. Authors a
// `Play`: per-player holds, **routes** (waypoints walked to the hold), and kill
// points (rotate when a teammate dies) — and the rotation can have its OWN
// authored route. Routes are capped at MAX_ROUTE_WAYPOINTS (a play is a sketch,
// not micro). Mutations clone-and-emit so the parent re-sims.
import { computed, ref } from 'vue';
import { MAX_ROUTE_WAYPOINTS as CAP } from '@ace/shared';
import type { Play, PlayerPlan, RotateTrigger, UtilKind, Vec2, Team } from '@ace/shared';
import type { Navmesh } from '@ace/maps';

const props = defineProps<{ team: Team; mapUrl: string; play: Play; side: 'att' | 'def'; mode: 'attack' | 'defense'; atkSpawn: Vec2; sites: { A: Vec2; B: Vec2 }; nav: Navmesh }>();
const emit = defineEmits<{ (e: 'update', play: Play): void }>();

// --- walkability feedback: flag holds/waypoints in a wall and route segments
// that clip one (authored routes are walked verbatim, so a wall-crossing segment
// means the player would walk THROUGH it). Same grid the engine pathfinds on.
const walkable = (pt: Vec2) => {
  const n = props.nav, c = Math.floor(pt[0] / n.cell), r = Math.floor(pt[1] / n.cell);
  return c >= 0 && c < n.cols && r >= 0 && r < n.rows && n.walk[r * n.cols + c] === 1;
};
const inWall = (pt: Vec2) => !walkable(pt);
function segHitsWall(a: Vec2, b: Vec2): boolean {
  const step = props.nav.cell * 0.6, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 0; i <= n; i++) { const f = i / n; if (inWall([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])) return true; }
  return false;
}
// the red overlay segments for a path (consecutive wall-clipping pairs)
function badSegs(points: Vec2[]): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (let i = 1; i < points.length; i++) if (segHitsWall(points[i - 1], points[i])) out.push([points[i - 1], points[i]]);
  return out;
}
// hold paths are walked verbatim, so always check them. An UNROUTED rotation is
// pathfound (A*, wall-aware) by the engine, so only flag a rotation's segments
// when the owner authored its route (then it IS walked verbatim).
const holdBad = (pl: PlayerPlan) => badSegs(holdPath(pl));
const rotBad = (pl: PlayerPlan) => (pl.rotate?.route?.length ? badSegs(rotPath(pl)) : []);

type Target = 'hold' | 'rotate';
const handleOf = (id: string) => props.team.players.find(p => p.id === id)?.handle ?? id;
const planOf = (id: string) => props.play.plans.find(p => p.player === id);
const routeArr = (pl: PlayerPlan | undefined, tgt: Target) => (tgt === 'hold' ? pl?.route : pl?.rotate?.route) ?? [];
const routeLen = (id: string, tgt: Target) => routeArr(planOf(id), tgt).length;

// facing: the nub sits a fixed distance from the hold along the watched angle
// (the default angle, when unset, points at the attacker spawn — as the engine does)
const FACE_LEN = 58;
function faceNub(pl: PlayerPlan): Vec2 {
  // default angle: defenders watch toward the attacker spawn; attackers watch
  // forward, away from it (their push direction) — matching the engine.
  let dx: number, dy: number;
  if (pl.face) { dx = pl.face[0] - pl.pos[0]; dy = pl.face[1] - pl.pos[1]; }
  else if (props.mode === 'attack') { dx = pl.pos[0] - props.atkSpawn[0]; dy = pl.pos[1] - props.atkSpawn[1]; }
  else { dx = props.atkSpawn[0] - pl.pos[0]; dy = props.atkSpawn[1] - pl.pos[1]; }
  const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
  return [pl.pos[0] + dx * FACE_LEN, pl.pos[1] + dy * FACE_LEN];
}
function setSite(s: 'A' | 'B') { commit(p => { p.site = s; }); }

// A/B mirror: Ascent's sites aren't reflections, so we TRANSPLANT the formation —
// translate every point by (otherSite − thisSite) and flip the execute site. A
// rough starting template for the other site that the owner then tunes (the
// walkability feedback flags whatever lands in a wall).
const otherSite = (): 'A' | 'B' => (props.play.site ?? 'A') === 'A' ? 'B' : 'A';
function mirror() {
  const cur = props.play.site ?? 'A', nxt = otherSite();
  const dx = props.sites[nxt][0] - props.sites[cur][0], dy = props.sites[nxt][1] - props.sites[cur][1];
  const clamp = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
  const sh = (p: Vec2): Vec2 => [clamp(p[0] + dx), clamp(p[1] + dy)];
  commit(p => {
    p.site = nxt;
    for (const pl of p.plans) {
      pl.pos = sh(pl.pos);
      if (pl.face) pl.face = sh(pl.face);
      if (pl.route) pl.route = pl.route.map(sh);
      if (pl.rotate) { pl.rotate.pos = sh(pl.rotate.pos); if (pl.rotate.route) pl.rotate.route = pl.rotate.route.map(sh); }
    }
    for (const ln of p.lineups ?? []) ln.at = sh(ln.at);
  });
}

function commit(mut: (p: Play) => void) {
  const next: Play = JSON.parse(JSON.stringify(props.play));   // cheap (5 plans); avoids mutating the prop
  mut(next);
  emit('update', next);
}

const svgEl = ref<SVGSVGElement | null>(null);
function toImg(clientX: number, clientY: number): Vec2 {
  const r = svgEl.value!.getBoundingClientRect();  // square container → 1:1 with viewBox
  const x = Math.max(0, Math.min(1000, ((clientX - r.left) / r.width) * 1000));
  const y = Math.max(0, Math.min(1000, ((clientY - r.top) / r.height) * 1000));
  return [Math.round(x), Math.round(y)];
}

// --- dragging markers (hold / rotate target / route waypoint / facing / util) ----
type Which = 'pos' | 'rotate' | 'wp' | 'face' | 'util';
let drag: { player: string; which: Which; tgt: Target; idx: number; from: Vec2; moved: boolean } | null = null;

function startDrag(player: string, which: Which, tgt: Target, idx: number, ev: PointerEvent) {
  ev.stopPropagation();          // don't let the map background also fire (route-add)
  drag = { player, which, tgt, idx, from: toImg(ev.clientX, ev.clientY), moved: false };
  (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
}
function onMove(ev: PointerEvent) {
  if (!drag) return;
  const pt = toImg(ev.clientX, ev.clientY);
  const d = drag;
  if (Math.hypot(pt[0] - d.from[0], pt[1] - d.from[1]) > 12) d.moved = true;
  if (d.which === 'util') { commit(p => { const ln = p.lineups?.[d.idx]; if (ln) ln.at = pt; }); return; }
  commit(p => {
    const pl = p.plans.find(q => q.player === d.player);
    if (!pl) return;
    if (d.which === 'pos') pl.pos = pt;
    else if (d.which === 'rotate' && pl.rotate) pl.rotate.pos = pt;
    else if (d.which === 'face') { if (pt[0] !== pl.pos[0] || pt[1] !== pl.pos[1]) pl.face = pt; }
    else if (d.which === 'wp') { const arr = d.tgt === 'hold' ? pl.route : pl.rotate?.route; if (arr) arr[d.idx] = pt; }
  });
}
// util-lineup markers drag independently of a player plan (they key off index)
function startDragUtil(idx: number, ev: PointerEvent) {
  ev.stopPropagation();
  drag = { player: '', which: 'util', tgt: 'hold', idx, from: toImg(ev.clientX, ev.clientY), moved: false };
  (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
}
function endDrag() {
  if (drag && drag.which === 'wp' && !drag.moved) removeWaypoint(drag.player, drag.tgt, drag.idx); // click = remove
  drag = null;
}

// --- routes ---------------------------------------------------------------
const routing = ref<{ player: string; tgt: Target } | null>(null);
const isRouting = (id: string, tgt: Target) => routing.value?.player === id && routing.value?.tgt === tgt;
function toggleRouting(player: string, tgt: Target) {
  routing.value = isRouting(player, tgt) ? null : { player, tgt };
}
const capHit = ref(false);

function onBg(ev: PointerEvent) {
  const r = routing.value;
  if (!r) return;                              // clicks only lay points in routing mode
  if (routeLen(r.player, r.tgt) >= CAP) { capHit.value = true; setTimeout(() => (capHit.value = false), 600); return; }
  const pt = toImg(ev.clientX, ev.clientY);
  commit(p => {
    const pl = p.plans.find(q => q.player === r.player);
    if (!pl) return;
    if (r.tgt === 'hold') (pl.route ??= []).push(pt);
    else if (pl.rotate) (pl.rotate.route ??= []).push(pt);
  });
}
function removeWaypoint(player: string, tgt: Target, idx: number) {
  commit(p => {
    const pl = p.plans.find(q => q.player === player);
    const arr = tgt === 'hold' ? pl?.route : pl?.rotate?.route;
    if (!arr) return;
    arr.splice(idx, 1);
    if (arr.length === 0) { if (tgt === 'hold') delete pl!.route; else delete pl!.rotate!.route; }
  });
}
function clearRoute(player: string, tgt: Target) {
  commit(p => {
    const pl = p.plans.find(q => q.player === player);
    if (tgt === 'hold') { if (pl) delete pl.route; } else if (pl?.rotate) delete pl.rotate.route;
  });
}

// --- kill points ----------------------------------------------------------
function toggleKill(player: string) {
  commit(p => {
    const pl = p.plans.find(q => q.player === player);
    if (!pl) return;
    if (pl.rotate) { delete pl.rotate; return; }
    const other = props.team.players.find(q => q.id !== player)!.id;
    pl.rotate = { pos: [Math.min(1000, pl.pos[0] + 90), Math.max(0, pl.pos[1] - 90)], trigger: { kind: 'death', player: other } };
  });
  if (routing.value?.player === player && routing.value.tgt === 'rotate') routing.value = null;
}
const triggerKind = (id: string) => planOf(id)?.rotate?.trigger.kind;
const deathPlayer = (id: string) => { const tr = planOf(id)?.rotate?.trigger; return tr?.kind === 'death' ? tr.player : ''; };
const timeT = (id: string) => { const tr = planOf(id)?.rotate?.trigger; return tr?.kind === 'time' ? tr.t : 0.4; };
function setTriggerKind(player: string, kind: RotateTrigger['kind']) {
  commit(p => {
    const pl = p.plans.find(q => q.player === player);
    if (!pl?.rotate) return;
    pl.rotate.trigger = kind === 'death' ? { kind: 'death', player: props.team.players.find(q => q.id !== player)!.id }
      : kind === 'time' ? { kind: 'time', t: 0.4 } : { kind: 'contact' };
  });
}
function setDeathPlayer(player: string, who: string) {
  commit(p => { const pl = p.plans.find(q => q.player === player); if (pl?.rotate) pl.rotate.trigger = { kind: 'death', player: who }; });
}
function setTime(player: string, t: number) {
  commit(p => { const pl = p.plans.find(q => q.player === player); if (pl?.rotate) pl.rotate.trigger = { kind: 'time', t }; });
}

// polyline point strings: the hold path ends AT the hold; the rotation path
// runs hold → waypoints → rotate target.
const holdPath = (pl: PlayerPlan): Vec2[] => [...(pl.route ?? []), pl.pos];
const rotPath = (pl: PlayerPlan): Vec2[] => pl.rotate ? [pl.pos, ...(pl.rotate.route ?? []), pl.rotate.pos] : [];
const holdPts = (pl: PlayerPlan) => holdPath(pl).map(p => p.join(',')).join(' ');
const rotPts = (pl: PlayerPlan) => rotPath(pl).map(p => p.join(',')).join(' ');
const segStr = (s: [Vec2, Vec2]) => `${s[0][0]},${s[0][1]} ${s[1][0]},${s[1][1]}`;

// total off-mesh warnings, for the summary line
const warnCount = computed(() => {
  let n = 0;
  for (const pl of props.play.plans) {
    if (inWall(pl.pos)) n++;
    for (const wp of pl.route ?? []) if (inWall(wp)) n++;
    n += holdBad(pl).length;
    if (pl.rotate) {
      if (inWall(pl.rotate.pos)) n++;
      for (const wp of pl.rotate.route ?? []) if (inWall(wp)) n++;
      n += rotBad(pl).length;
    }
  }
  return n;
});

// --- utility lineups ------------------------------------------------------
function addLineup(kind: UtilKind) {
  commit(p => { (p.lineups ??= []).push({ player: props.team.players[0].id, kind, at: [460, 380], t: 0.25 }); });
}
function removeLineup(i: number) {
  commit(p => { p.lineups?.splice(i, 1); if (p.lineups && p.lineups.length === 0) delete p.lineups; });
}
function setUtilCaster(i: number, player: string) {
  commit(p => { if (p.lineups?.[i]) p.lineups[i].player = player; });
}
function setUtilTime(i: number, t: number) {
  commit(p => { if (p.lineups?.[i]) p.lineups[i].t = t; });
}
// display radius mirrors the engine's reach (base + util-scaled), using the
// caster's utility stat with a mid mastery factor so the circle reads true-ish.
function utilRadius(ln: { player: string; kind: UtilKind }): number {
  const u = ((props.team.players.find(q => q.id === ln.player)?.attr.utility ?? 50) / 100) * 0.9;
  return ln.kind === 'smoke' ? 58 + 46 * u : 84 + 70 * u;
}
</script>

<template>
  <div class="pe">
    <svg class="pe-map" viewBox="0 0 1000 1000" ref="svgEl" :class="{ routing, cap: capHit }"
         @pointermove="onMove" @pointerup="endDrag" @pointerleave="endDrag">
      <image :href="mapUrl" x="0" y="0" width="1000" height="1000" preserveAspectRatio="none" />
      <rect x="0" y="0" width="1000" height="1000" class="pe-scrim" @pointerdown="onBg" />

      <!-- utility lineups: translucent reach circles (drawn low, click-through) -->
      <circle v-for="(ln, i) in (play.lineups || [])" :key="'uc' + i"
              :cx="ln.at[0]" :cy="ln.at[1]" :r="utilRadius(ln)" class="pe-util-r" :class="ln.kind" />

      <!-- rotation paths: hold → (waypoints) → rotate target -->
      <g v-for="pl in play.plans" :key="'rp' + pl.player">
        <polyline v-if="pl.rotate" :points="rotPts(pl)" class="pe-link" :class="{ active: isRouting(pl.player, 'rotate') }" />
        <g v-for="(wp, i) in (pl.rotate?.route || [])" :key="'rw' + i" class="pe-mark wp gold"
           :transform="`translate(${wp[0]},${wp[1]})`" @pointerdown="startDrag(pl.player, 'wp', 'rotate', i, $event)">
          <circle v-if="inWall(wp)" r="16" class="pe-warn" /><circle r="10" class="pe-wp-dot gold" /><text class="pe-wp-ix" y="3.5">{{ i + 1 }}</text>
        </g>
      </g>

      <!-- hold routes: (waypoints) → hold -->
      <g v-for="pl in play.plans" :key="'ht' + pl.player">
        <polyline v-if="pl.route && pl.route.length" :points="holdPts(pl)"
                  class="pe-route" :class="{ active: isRouting(pl.player, 'hold') }" />
        <g v-for="(wp, i) in (pl.route || [])" :key="i" class="pe-mark wp"
           :transform="`translate(${wp[0]},${wp[1]})`" @pointerdown="startDrag(pl.player, 'wp', 'hold', i, $event)">
          <circle v-if="inWall(wp)" r="17" class="pe-warn" /><circle r="11" class="pe-wp-dot" /><text class="pe-wp-ix" y="3.5">{{ i + 1 }}</text>
        </g>
      </g>

      <!-- walkability: route segments that clip a wall (the player would walk through it) -->
      <g v-for="pl in play.plans" :key="'bs' + pl.player">
        <polyline v-for="(s, i) in holdBad(pl)" :key="'bh' + i" :points="segStr(s)" class="pe-badseg" />
        <polyline v-for="(s, i) in rotBad(pl)" :key="'br' + i" :points="segStr(s)" class="pe-badseg" />
      </g>

      <!-- rotate targets -->
      <g v-for="pl in play.plans" :key="'r' + pl.player">
        <g v-if="pl.rotate" class="pe-mark rot" :class="side"
           :transform="`translate(${pl.rotate.pos[0]},${pl.rotate.pos[1]})`"
           @pointerdown="startDrag(pl.player, 'rotate', 'rotate', 0, $event)">
          <circle v-if="inWall(pl.rotate.pos)" r="21" class="pe-warn" /><circle r="15" class="pe-dot" /><text class="pe-rot-ic" y="5">↻</text>
        </g>
      </g>

      <!-- hold positions -->
      <g v-for="pl in play.plans" :key="'p' + pl.player" class="pe-mark hold"
         :class="[side, { sel: routing?.player === pl.player }]"
         :transform="`translate(${pl.pos[0]},${pl.pos[1]})`"
         @pointerdown="startDrag(pl.player, 'pos', 'hold', 0, $event)">
        <circle v-if="inWall(pl.pos)" r="23" class="pe-warn" /><circle r="17" class="pe-dot" /><text class="pe-hl" y="-24">{{ handleOf(pl.player) }}</text>
      </g>

      <!-- facing handles: the angle each defender watches (drag to aim) -->
      <g v-for="pl in play.plans" :key="'f' + pl.player">
        <line :x1="pl.pos[0]" :y1="pl.pos[1]" :x2="faceNub(pl)[0]" :y2="faceNub(pl)[1]"
              class="pe-face-line" :class="[side, { set: pl.face }]" />
        <circle :cx="faceNub(pl)[0]" :cy="faceNub(pl)[1]" r="7" class="pe-mark pe-face-nub" :class="[side, { set: pl.face }]"
                @pointerdown="startDrag(pl.player, 'face', 'hold', 0, $event)" />
      </g>

      <!-- utility lineup centers (draggable) -->
      <g v-for="(ln, i) in (play.lineups || [])" :key="'um' + i" class="pe-mark pe-util" :class="ln.kind"
         :transform="`translate(${ln.at[0]},${ln.at[1]})`" @pointerdown="startDragUtil(i, $event)">
        <circle r="9" class="pe-util-c" />
        <text class="pe-util-ic" y="3.5">{{ ln.kind === 'smoke' ? '◍' : ln.kind === 'flash' ? '✸' : '◉' }}</text>
      </g>
    </svg>

    <div class="pe-list">
      <div v-if="mode === 'attack'" class="pe-site">
        Execute site
        <button :class="{ on: (play.site ?? 'A') === 'A' }" @click="setSite('A')">A</button>
        <button :class="{ on: play.site === 'B' }" @click="setSite('B')">B</button>
        <button class="pe-mirror" @click="mirror" title="Transplant this formation to the other site, then tune">⇄ mirror to {{ otherSite() }}</button>
        <span class="pe-site-note">forces the round to this site</span>
      </div>
      <div class="pe-hint" v-if="routing">
        Laying <b>{{ handleOf(routing.player) }}</b>'s {{ routing.tgt === 'rotate' ? 'rotation' : 'setup' }} path
        (<b :class="{ full: routeLen(routing.player, routing.tgt) >= CAP }">{{ routeLen(routing.player, routing.tgt) }}/{{ CAP }}</b>) —
        click the map to drop waypoints, drag to move, click a point to remove.
      </div>
      <div class="pe-hint" v-else-if="mode === 'attack'">
        Drag dots to place the <b>execute</b> — where each attacker ends up; aim the nub at what they <b>watch</b>.
        <b>route</b> = draw the exact path in (unrouted = auto-pathed); <b>kill point</b> = a lurk that pushes (↻)
        on a death, contact, or the clock. Add <b>lineups</b> to smoke/flash the site. Up to {{ CAP }} waypoints each.
      </div>
      <div class="pe-hint" v-else>
        Drag dots to place defenders; drag the small nub to aim what they <b>watch</b>. <b>route</b> = draw the path
        they walk in (longer = set up later); <b>kill point</b> = rotate (↻) when its trigger fires —
        a teammate's death, first contact, or the clock. Up to {{ CAP }} waypoints each.
      </div>
      <div v-if="warnCount" class="pe-warnline">⚠ {{ warnCount }} off-mesh — a spot or path crosses a wall (red); the player can't stand or walk there.</div>
      <div v-for="pl in play.plans" :key="pl.player" class="pe-row"
           :class="{ keyed: pl.rotate, routing: routing?.player === pl.player }">
        <span class="pe-name" :class="side">{{ handleOf(pl.player) }}</span>
        <button class="pe-rt-btn" :class="{ on: isRouting(pl.player, 'hold') }" @click="toggleRouting(pl.player, 'hold')">
          {{ isRouting(pl.player, 'hold') ? 'done' : 'route' }}<i v-if="routeLen(pl.player, 'hold')">{{ routeLen(pl.player, 'hold') }}</i>
        </button>
        <button v-if="routeLen(pl.player, 'hold')" class="pe-rt-clear" @click="clearRoute(pl.player, 'hold')">clear</button>
        <label class="pe-kp">
          <input type="checkbox" :checked="!!pl.rotate" @change="toggleKill(pl.player)" /> kill point
        </label>
        <template v-if="pl.rotate">
          <span class="pe-trig">
            <select class="pe-tk" :value="triggerKind(pl.player)"
                    @change="setTriggerKind(pl.player, ($event.target as HTMLSelectElement).value as any)">
              <option value="death">when… dies</option>
              <option value="contact">on contact</option>
              <option value="time">at time</option>
            </select>
            <select v-if="triggerKind(pl.player) === 'death'" :value="deathPlayer(pl.player)"
                    @change="setDeathPlayer(pl.player, ($event.target as HTMLSelectElement).value)">
              <option v-for="o in team.players.filter(q => q.id !== pl.player)" :key="o.id" :value="o.id">{{ o.handle }}</option>
            </select>
            <span v-else-if="triggerKind(pl.player) === 'time'" class="pe-time">
              <input type="range" min="0.1" max="0.9" step="0.05" :value="timeT(pl.player)"
                     @input="setTime(pl.player, +($event.target as HTMLInputElement).value)" />
              <i>{{ Math.round(timeT(pl.player) * 100) }}%</i>
            </span>
          </span>
          <button class="pe-rt-btn gold" :class="{ on: isRouting(pl.player, 'rotate') }" @click="toggleRouting(pl.player, 'rotate')">
            {{ isRouting(pl.player, 'rotate') ? 'done ↻' : 'route ↻' }}<i v-if="routeLen(pl.player, 'rotate')">{{ routeLen(pl.player, 'rotate') }}</i>
          </button>
        </template>
      </div>

      <div class="pe-util-head">
        <span>Utility lineups</span>
        <button class="pe-add smoke" @click="addLineup('smoke')">+ smoke</button>
        <button class="pe-add flash" @click="addLineup('flash')">+ flash</button>
        <button class="pe-add recon" @click="addLineup('recon')">+ recon</button>
      </div>
      <div v-for="(ln, i) in (play.lineups || [])" :key="'ur' + i" class="pe-row util" :class="ln.kind">
        <span class="pe-util-tag" :class="ln.kind">{{ ln.kind }}</span>
        <select :value="ln.player" @change="setUtilCaster(i, ($event.target as HTMLSelectElement).value)">
          <option v-for="o in team.players" :key="o.id" :value="o.id">{{ o.handle }}</option>
        </select>
        <span class="pe-time">at
          <input type="range" min="0.05" max="0.9" step="0.05" :value="ln.t"
                 @input="setUtilTime(i, +($event.target as HTMLInputElement).value)" />
          <i>{{ Math.round(ln.t * 100) }}%</i>
        </span>
        <button class="pe-rt-clear" @click="removeLineup(i)">remove</button>
      </div>
    </div>
  </div>
</template>
