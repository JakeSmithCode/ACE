<script setup lang="ts">
// Drag-to-place defense play editor. The map is the engine's own 1000×1000
// image space (same coords A* pathfinds on), rendered as an SVG viewBox so a
// marker's position IS its engine position — no transform to keep in sync.
// Authors a `Play`: per-player hold positions + optional kill points (rotate
// when a named teammate dies). Mutations clone-and-emit so the parent re-sims.
import { ref } from 'vue';
import type { Play, Team, Vec2 } from '@ace/shared';

const props = defineProps<{ team: Team; mapUrl: string; play: Play; side: 'att' | 'def' }>();
const emit = defineEmits<{ (e: 'update', play: Play): void }>();

const handleOf = (id: string) => props.team.players.find(p => p.id === id)?.handle ?? id;

// one immutable update: clone, mutate the clone, emit. Cheap (5 plans) and keeps
// us from mutating the parent's reactive prop in place.
function commit(mut: (p: Play) => void) {
  const next: Play = JSON.parse(JSON.stringify(props.play));
  mut(next);
  emit('update', next);
}

// --- dragging markers in image space -------------------------------------
const svgEl = ref<SVGSVGElement | null>(null);
let dragging: { player: string; which: 'pos' | 'rotate' } | null = null;

function toImg(clientX: number, clientY: number): Vec2 {
  const r = svgEl.value!.getBoundingClientRect();  // square container → 1:1 with viewBox
  const x = Math.max(0, Math.min(1000, ((clientX - r.left) / r.width) * 1000));
  const y = Math.max(0, Math.min(1000, ((clientY - r.top) / r.height) * 1000));
  return [Math.round(x), Math.round(y)];
}
function startDrag(player: string, which: 'pos' | 'rotate', ev: PointerEvent) {
  dragging = { player, which };
  (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
}
function onMove(ev: PointerEvent) {
  if (!dragging) return;
  const pt = toImg(ev.clientX, ev.clientY);
  const d = dragging;
  commit(p => {
    const pl = p.plans.find(q => q.player === d.player);
    if (!pl) return;
    if (d.which === 'pos') pl.pos = pt;
    else if (pl.rotate) pl.rotate.pos = pt;
  });
}
const endDrag = () => { dragging = null; };

// --- kill points ----------------------------------------------------------
function toggleKill(player: string) {
  commit(p => {
    const pl = p.plans.find(q => q.player === player);
    if (!pl) return;
    if (pl.rotate) { delete pl.rotate; return; }
    // seed a rotation target offset from the hold, triggered by a teammate's death
    const other = props.team.players.find(q => q.id !== player)!.id;
    pl.rotate = { pos: [Math.min(1000, pl.pos[0] + 90), Math.max(0, pl.pos[1] - 90)], onDeathOf: other };
  });
}
function setTrigger(player: string, onDeathOf: string) {
  commit(p => { const pl = p.plans.find(q => q.player === player); if (pl?.rotate) pl.rotate.onDeathOf = onDeathOf; });
}
</script>

<template>
  <div class="pe">
    <svg class="pe-map" viewBox="0 0 1000 1000" ref="svgEl"
         @pointermove="onMove" @pointerup="endDrag" @pointerleave="endDrag">
      <image :href="mapUrl" x="0" y="0" width="1000" height="1000" preserveAspectRatio="none" />
      <rect x="0" y="0" width="1000" height="1000" class="pe-scrim" />

      <!-- kill-point connectors: hold → rotate target -->
      <g v-for="pl in play.plans" :key="'l' + pl.player">
        <line v-if="pl.rotate" :x1="pl.pos[0]" :y1="pl.pos[1]" :x2="pl.rotate.pos[0]" :y2="pl.rotate.pos[1]"
              class="pe-link" />
      </g>

      <!-- rotate targets (where they collapse to) -->
      <g v-for="pl in play.plans" :key="'r' + pl.player">
        <g v-if="pl.rotate" class="pe-mark rot" :class="side"
           :transform="`translate(${pl.rotate.pos[0]},${pl.rotate.pos[1]})`"
           @pointerdown="startDrag(pl.player, 'rotate', $event)">
          <circle r="15" class="pe-dot" />
          <text class="pe-rot-ic" y="5">↻</text>
        </g>
      </g>

      <!-- hold positions (draggable) -->
      <g v-for="pl in play.plans" :key="'p' + pl.player" class="pe-mark hold" :class="side"
         :transform="`translate(${pl.pos[0]},${pl.pos[1]})`"
         @pointerdown="startDrag(pl.player, 'pos', $event)">
        <circle r="17" class="pe-dot" />
        <text class="pe-hl" y="-24">{{ handleOf(pl.player) }}</text>
      </g>
    </svg>

    <div class="pe-list">
      <div class="pe-hint">Drag the dots to place each defender. Add a <b>kill point</b> to make a player
        rotate (↻) the moment a chosen teammate trades out.</div>
      <div v-for="pl in play.plans" :key="pl.player" class="pe-row" :class="{ keyed: pl.rotate }">
        <span class="pe-name" :class="side">{{ handleOf(pl.player) }}</span>
        <label class="pe-kp">
          <input type="checkbox" :checked="!!pl.rotate" @change="toggleKill(pl.player)" />
          kill point
        </label>
        <span v-if="pl.rotate" class="pe-trig">rotate when
          <select :value="pl.rotate.onDeathOf" @change="setTrigger(pl.player, ($event.target as HTMLSelectElement).value)">
            <option v-for="o in team.players.filter(q => q.id !== pl.player)" :key="o.id" :value="o.id">{{ o.handle }}</option>
          </select>
          dies
        </span>
      </div>
    </div>
  </div>
</template>
