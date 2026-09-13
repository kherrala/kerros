---
layout: false
title: A floor plan you can walk through
description: Draw connected spaces on a real map, explore buildings in 3D, and navigate between floors. Watch three recordings from the working Kerros editor.
---

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { mountLanding } from '../website/landing.js';
import '../website/landing.css';
let cleanup;
onMounted(() => { cleanup = mountLanding(); });
onUnmounted(() => cleanup?.());
</script>

<!--@include: ../website/landing.html-->
