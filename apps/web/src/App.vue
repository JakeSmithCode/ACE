<script setup lang="ts">
import { ref } from 'vue';
import Hq from './Hq.vue';
import Editor from './Editor.vue';
import Live from './Live.vue';
import Circuit from './Circuit.vue';
import WorldCup from './WorldCup.vue';

// A shared deep-link (?watch= or an explicit ?server=) means the visitor came to watch
// the live world — open the Match Center, not the default HQ. (Live.vue reads ?watch=
// once it connects and auto-plays that replay.)
const params = new URLSearchParams(location.search);
const view = ref<'hq' | 'editor' | 'live' | 'circuit' | 'worldcup'>(
  params.has('watch') || params.has('server') ? 'live' : 'hq',
);
</script>

<template>
  <div class="ace-shell">
    <header class="ace-top">
      <div class="logo"><span class="dot"></span>ACE</div>
      <nav class="ace-nav">
        <button :class="{ on: view === 'hq' }" @click="view = 'hq'">HQ · Season</button>
        <button :class="{ on: view === 'editor' }" @click="view = 'editor'">Tactics Editor</button>
        <button :class="{ on: view === 'live' }" @click="view = 'live'">Match Center<span class="nav-live">LIVE</span></button>
        <button :class="{ on: view === 'circuit' }" @click="view = 'circuit'">Circuit</button>
        <button :class="{ on: view === 'worldcup' }" @click="view = 'worldcup'">🌍 World Cup</button>
      </nav>
      <div class="crumb-r"><b>@ace/engine</b> · live in your browser</div>
    </header>

    <Hq v-if="view === 'hq'" />
    <Editor v-else-if="view === 'editor'" />
    <Live v-else-if="view === 'live'" />
    <Circuit v-else-if="view === 'circuit'" />
    <WorldCup v-else />
  </div>
</template>
