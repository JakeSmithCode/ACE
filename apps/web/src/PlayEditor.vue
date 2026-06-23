<script setup lang="ts">
// Drag-to-place play editor. The map is the engine's own 1000×1000 image space
// (same coords A* pathfinds on), rendered as an SVG viewBox so a marker's
// position IS its engine position — no transform to keep in sync. Authors a
// `Play`: per-player hold positions, an optional **route** (waypoints walked to
// the hold), and kill points (rotate when a named teammate dies). Mutations
// clone-and-emit so the parent re-sims.
import { ref } from 'vue';
import type { Play, Vec2, Team } from '@ace/shared';

const props = defineProps<{ team: Team; mapUrl: string; play: Play; side: 'att' | 'def' }>();
const emit = defineEmits<{ (e: 'update', play: Play): void }>();

const handleOf = (id: string) => props.team.players.find(p => p.id === id)?.handle ?? id;
const routeOf = (id: string) => props.play.plans.find(p => p.player === id)?.route ?? [];

// one immutable update: clone, mutate the clone, emit. Cheap (5 plans) and keeps
// us from mutating the parent's reactive prop in place.
function commit(mut: (p: Play) => void) {
  const next: Play = JSON.parse(JSON.stringify(props.play));
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

// --- dragging markers (hold / rotate target / route waypoint) -------------
type Which = 'pos' | 'rotate' | 'wp';
let drag: { player: string; which: Which; idx: number; from: Vec2; moved: boolean } | null = null;

function startDrag(player: string, which: Which, idx: number, ev: PointerEvent) {
  ev.stopPropagation();          // don't let the map background also fire (route-add)
  drag = { player, which, idx, from: toImg(ev.clientX, ev.clientY), moved: false };
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
    else if (d.which === 'wp' && pl.route) pl.route[d.idx] = pt;
  });
}
function endDrag() {
  // a waypoint clicked without dragging = remove it (the only way to delete one)
  if (drag && drag.which === 'wp' && !drag.moved) removeWaypoint(drag.player, drag.idx);
  drag = null;
}

// --- routes ---------------------------------------------------------------
const routing = ref<string | null>(null);    // player id whose route we're laying
function toggleRouting(player: string) { routing.value = routing.value === player ? null : player; }

function onBg(ev: PointerEvent) {
  if (!routing.value) return;                 // clicks only lay points in routing mode
  const pt = toImg(ev.clientX, ev.clientY);
  const player = routing.value;
  commit(p => {
    const pl = p.plans.find(q => q.player === player);
    if (!pl) return;
    (pl.route ??= []).push(pt);               // append: drawn spawn→hold in travel order
  });
}
function removeWaypoint(player: string, idx: number) {
  commit(p => {
    const pl = p.plans.find(q => q.player === player);
    if (!pl?.route) return;
    pl.route.splice(idx, 1);
    if (pl.route.length === 0) delete pl.route;
  });
}
function clearRoute(player: string) {
  commit(p => { const pl = p.plans.find(q => q.player === player); if (pl) delete pl.route; });
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
}
function setTrigger(player: string, onDeathOf: string) {
  commit(p => { const pl = p.plans.find(q => q.player === player); if (pl?.rotate) pl.rotate.onDeathOf = onDeathOf; });
}

// the full path drawn as a polyline: route[0] → … → pos (the hold is the end)
const pathPoints = (id: string): string => {
  const pl = props.play.plans.find(p => p.player === id);
  if (!pl) return '';
  return [...(pl.route ?? []), pl.pos].map(pt => pt.join(',')).join(' ');
};
</script>

<template>
  <div class="pe">
    <svg class="pe-map" viewBox="0 0 1000 1000" ref="svgEl" :class="{ routing }"
         @pointermove="onMove" @pointerup="endDrag" @pointerleave="endDrag">
      <image :href="mapUrl" x="0" y="0" width="1000" height="1000" preserveAspectRatio="none" />
      <rect x="0" y="0" width="1000" height="1000" class="pe-scrim" @pointerdown="onBg" />

      <!-- routes: the path walked into each hold -->
      <g v-for="pl in play.plans" :key="'rt' + pl.player">
        <polyline v-if="pl.route && pl.route.length" :points="pathPoints(pl.player)"
                  class="pe-route" :class="{ active: routing === pl.player }" />
        <g v-for="(wp, idx) in (pl.route || [])" :key="idx" class="pe-mark wp"
           :transform="`translate(${wp[0]},${wp[1]})`"
           @pointerdown="startDrag(pl.player, 'wp', idx, $event)">
          <circle r="11" class="pe-wp-dot" />
          <text class="pe-wp-ix" y="3.5">{{ idx + 1 }}</text>
        </g>
      </g>

      <!-- kill-point connectors: hold → rotate target -->
      <g v-for="pl in play.plans" :key="'l' + pl.player">
        <line v-if="pl.rotate" :x1="pl.pos[0]" :y1="pl.pos[1]" :x2="pl.rotate.pos[0]" :y2="pl.rotate.pos[1]"
              class="pe-link" />
      </g>
      <g v-for="pl in play.plans" :key="'r' + pl.player">
        <g v-if="pl.rotate" class="pe-mark rot" :class="side"
           :transform="`translate(${pl.rotate.pos[0]},${pl.rotate.pos[1]})`"
           @pointerdown="startDrag(pl.player, 'rotate', 0, $event)">
          <circle r="15" class="pe-dot" />
          <text class="pe-rot-ic" y="5">↻</text>
        </g>
      </g>

      <!-- hold positions (draggable) -->
      <g v-for="pl in play.plans" :key="'p' + pl.player" class="pe-mark hold" :class="[side, { sel: routing === pl.player }]"
         :transform="`translate(${pl.pos[0]},${pl.pos[1]})`"
         @pointerdown="startDrag(pl.player, 'pos', 0, $event)">
        <circle r="17" class="pe-dot" />
        <text class="pe-hl" y="-24">{{ handleOf(pl.player) }}</text>
      </g>
    </svg>

    <div class="pe-list">
      <div class="pe-hint" v-if="routing">
        Laying <b>{{ handleOf(routing) }}</b>'s route — click the map to drop waypoints (spawn → hold, in order),
        drag a point to move it, click a point to remove. The hold dot is the end.
      </div>
      <div class="pe-hint" v-else>
        Drag the dots to place each defender. Give a player a <b>route</b> to draw the path they walk in
        (a longer route = set up later), or a <b>kill point</b> to rotate (↻) when a chosen teammate trades out.
      </div>
      <div v-for="pl in play.plans" :key="pl.player" class="pe-row" :class="{ keyed: pl.rotate, routing: routing === pl.player }">
        <span class="pe-name" :class="side">{{ handleOf(pl.player) }}</span>
        <button class="pe-rt-btn" :class="{ on: routing === pl.player }" @click="toggleRouting(pl.player)">
          {{ routing === pl.player ? 'done' : 'route' }}<i v-if="routeOf(pl.player).length">{{ routeOf(pl.player).length }}</i>
        </button>
        <button v-if="routeOf(pl.player).length" class="pe-rt-clear" @click="clearRoute(pl.player)">clear</button>
        <label class="pe-kp">
          <input type="checkbox" :checked="!!pl.rotate" @change="toggleKill(pl.player)" />
          kill point
        </label>
        <span v-if="pl.rotate" class="pe-trig">when
          <select :value="pl.rotate.onDeathOf" @change="setTrigger(pl.player, ($event.target as HTMLSelectElement).value)">
            <option v-for="o in team.players.filter(q => q.id !== pl.player)" :key="o.id" :value="o.id">{{ o.handle }}</option>
          </select>
          dies
        </span>
      </div>
    </div>
  </div>
</template>
