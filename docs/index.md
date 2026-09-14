---
layout: false
title: A floor plan you can walk through
description: Draw or import connected floor plans with AI, explore buildings in 3D, and navigate between floors. Embed the editor, viewer and Node.js import backend in your application.
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
