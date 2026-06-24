<script setup lang="ts">
import { ref } from 'vue';
import Hq from './Hq.vue';
import Editor from './Editor.vue';

const view = ref<'hq' | 'editor'>('hq');
</script>

<template>
  <div class="ace-shell">
    <header class="ace-top">
      <div class="logo"><span class="dot"></span>ACE</div>
      <nav class="ace-nav">
        <button :class="{ on: view === 'hq' }" @click="view = 'hq'">HQ · Season</button>
        <button :class="{ on: view === 'editor' }" @click="view = 'editor'">Tactics Editor</button>
      </nav>
      <div class="crumb-r"><b>@ace/engine</b> · live in your browser</div>
    </header>

    <Hq v-if="view === 'hq'" />
    <Editor v-else />
  </div>
</template>
