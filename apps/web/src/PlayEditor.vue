<script setup lang="ts">
// Drag-to-place play editor. The map is the engine's own 1000×1000 image space
// (same coords A* pathfinds on), rendered as an SVG viewBox so a marker's
// position IS its engine position — no transform to keep in sync. Authors a
// `Play`: per-player holds, **routes** (waypoints walked to the hold), and kill
// points (rotate when a teammate dies) — and the rotation can have its OWN
// authored route. Routes are capped at MAX_ROUTE_WAYPOINTS (a play is a sketch,
// not micro). Mutations clone-and-emit so the parent re-sims.
import { ref } from 'vue';
import { MAX_ROUTE_WAYPOINTS as CAP } from '@ace/shared';
import type { Play, PlayerPlan, Vec2, Team } from '@ace/shared';

const props = defineProps<{ team: Team; mapUrl: string; play: Play; side: 'att' | 'def' }>();
const emit = defineEmits<{ (e: 'update', play: Play): void }>();

type Target = 'hold' | 'rotate';
const handleOf = (id: string) => props.team.players.find(p => p.id === id)?.handle ?? id;
const planOf = (id: string) => props.play.plans.find(p => p.player === id);
const routeArr = (pl: PlayerPlan | undefined, tgt: Target) => (tgt === 'hold' ? pl?.route : pl?.rotate?.route) ?? [];
const routeLen = (id: string, tgt: Target) => routeArr(planOf(id), tgt).length;

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

// --- dragging markers (hold / rotate target / a route waypoint) -----------
type Which = 'pos' | 'rotate' | 'wp';
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
  commit(p => {
    const pl = p.plans.find(q => q.player === d.player);
    if (!pl) return;
    if (d.which === 'pos') pl.pos = pt;
    else if (d.which === 'rotate' && pl.rotate) pl.rotate.pos = pt;
    else if (d.which === 'wp') { const arr = d.tgt === 'hold' ? pl.route : pl.rotate?.route; if (arr) arr[d.idx] = pt; }
  });
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
    pl.rotate = { pos: [Math.min(1000, pl.pos[0] + 90), Math.max(0, pl.pos[1] - 90)], onDeathOf: other };
  });
  if (routing.value?.player === player && routing.value.tgt === 'rotate') routing.value = null;
}
function setTrigger(player: string, onDeathOf: string) {
  commit(p => { const pl = p.plans.find(q => q.player === player); if (pl?.rotate) pl.rotate.onDeathOf = onDeathOf; });
}

// polyline point strings: the hold path ends AT the hold; the rotation path
// runs hold → waypoints → rotate target.
const holdPts = (pl: PlayerPlan) => [...(pl.route ?? []), pl.pos].map(p => p.join(',')).join(' ');
const rotPts = (pl: PlayerPlan) => pl.rotate ? [pl.pos, ...(pl.rotate.route ?? []), pl.rotate.pos].map(p => p.join(',')).join(' ') : '';
</script>

<template>
  <div class="pe">
    <svg class="pe-map" viewBox="0 0 1000 1000" ref="svgEl" :class="{ routing, cap: capHit }"
         @pointermove="onMove" @pointerup="endDrag" @pointerleave="endDrag">
      <image :href="mapUrl" x="0" y="0" width="1000" height="1000" preserveAspectRatio="none" />
      <rect x="0" y="0" width="1000" height="1000" class="pe-scrim" @pointerdown="onBg" />

      <!-- rotation paths: hold → (waypoints) → rotate target -->
      <g v-for="pl in play.plans" :key="'rp' + pl.player">
        <polyline v-if="pl.rotate" :points="rotPts(pl)" class="pe-link" :class="{ active: isRouting(pl.player, 'rotate') }" />
        <g v-for="(wp, i) in (pl.rotate?.route || [])" :key="'rw' + i" class="pe-mark wp gold"
           :transform="`translate(${wp[0]},${wp[1]})`" @pointerdown="startDrag(pl.player, 'wp', 'rotate', i, $event)">
          <circle r="10" class="pe-wp-dot gold" /><text class="pe-wp-ix" y="3.5">{{ i + 1 }}</text>
        </g>
      </g>

      <!-- hold routes: (waypoints) → hold -->
      <g v-for="pl in play.plans" :key="'ht' + pl.player">
        <polyline v-if="pl.route && pl.route.length" :points="holdPts(pl)"
                  class="pe-route" :class="{ active: isRouting(pl.player, 'hold') }" />
        <g v-for="(wp, i) in (pl.route || [])" :key="i" class="pe-mark wp"
           :transform="`translate(${wp[0]},${wp[1]})`" @pointerdown="startDrag(pl.player, 'wp', 'hold', i, $event)">
          <circle r="11" class="pe-wp-dot" /><text class="pe-wp-ix" y="3.5">{{ i + 1 }}</text>
        </g>
      </g>

      <!-- rotate targets -->
      <g v-for="pl in play.plans" :key="'r' + pl.player">
        <g v-if="pl.rotate" class="pe-mark rot" :class="side"
           :transform="`translate(${pl.rotate.pos[0]},${pl.rotate.pos[1]})`"
           @pointerdown="startDrag(pl.player, 'rotate', 'rotate', 0, $event)">
          <circle r="15" class="pe-dot" /><text class="pe-rot-ic" y="5">↻</text>
        </g>
      </g>

      <!-- hold positions -->
      <g v-for="pl in play.plans" :key="'p' + pl.player" class="pe-mark hold"
         :class="[side, { sel: routing?.player === pl.player }]"
         :transform="`translate(${pl.pos[0]},${pl.pos[1]})`"
         @pointerdown="startDrag(pl.player, 'pos', 'hold', 0, $event)">
        <circle r="17" class="pe-dot" /><text class="pe-hl" y="-24">{{ handleOf(pl.player) }}</text>
      </g>
    </svg>

    <div class="pe-list">
      <div class="pe-hint" v-if="routing">
        Laying <b>{{ handleOf(routing.player) }}</b>'s {{ routing.tgt === 'rotate' ? 'rotation' : 'setup' }} path
        (<b :class="{ full: routeLen(routing.player, routing.tgt) >= CAP }">{{ routeLen(routing.player, routing.tgt) }}/{{ CAP }}</b>) —
        click the map to drop waypoints, drag to move, click a point to remove.
      </div>
      <div class="pe-hint" v-else>
        Drag dots to place defenders. <b>route</b> = draw the path they walk in (longer = set up later);
        <b>kill point</b> = rotate (↻) when a teammate trades, with its own routable path. Up to {{ CAP }} waypoints each.
      </div>
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
          <span class="pe-trig">when
            <select :value="pl.rotate.onDeathOf" @change="setTrigger(pl.player, ($event.target as HTMLSelectElement).value)">
              <option v-for="o in team.players.filter(q => q.id !== pl.player)" :key="o.id" :value="o.id">{{ o.handle }}</option>
            </select> dies
          </span>
          <button class="pe-rt-btn gold" :class="{ on: isRouting(pl.player, 'rotate') }" @click="toggleRouting(pl.player, 'rotate')">
            {{ isRouting(pl.player, 'rotate') ? 'done ↻' : 'route ↻' }}<i v-if="routeLen(pl.player, 'rotate')">{{ routeLen(pl.player, 'rotate') }}</i>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
