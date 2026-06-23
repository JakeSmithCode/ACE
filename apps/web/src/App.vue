<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { MatchTimeline } from '@ace/shared';
import { Viewer, type NavGrid } from './viewer';

const host = ref<HTMLElement | null>(null);
let viewer: Viewer | null = null;

onMounted(async () => {
  const tl = (await fetch('/timeline.json').then(r => r.json())) as MatchTimeline;
  // map assets are loaded by the timeline's map id, so any simulated map renders
  const nav = (await fetch(`/${tl.map}.navmesh.json`).then(r => (r.ok ? r.json() : null)).catch(() => null)) as NavGrid | null;
  if (host.value) viewer = new Viewer(host.value, tl, `/${tl.map}.png`, nav);
});
onUnmounted(() => viewer?.destroy());
</script>

<template>
  <div class="ace-shell">
    <header class="ace-top">
      <div class="logo"><span class="dot"></span>ACE</div>
      <div class="crumb">Match Viewer · reading <b>timeline.json</b> emitted by <b>@ace/engine</b></div>
    </header>
    <div ref="host" class="ace-host"></div>
  </div>
</template>
