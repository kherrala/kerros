---
layout: home
hero:
  name: Kerros
  text: Indoor mapping, in 2D and 3D
  tagline: An open-source React + MapLibre + Three.js toolkit to model and visualize multi-floor premises on real map geometry.
  image:
    src: /media/editor-3d.png
    alt: The Kerros editor showing a building in 3D
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Live demo
      link: https://kherrala.fi/kerros/app.html
    - theme: alt
      text: GitHub
      link: https://github.com/kherrala/kerros
features:
  - title: Real geometry, 2D & 3D
    details: Draw multi-floor buildings in metric coordinates over MapLibre basemaps, with a Three.js floor cutaway and building stack.
  - title: Indoor navigation
    details: Author a route network and get turn-by-turn, cross-floor directions — even headless, with no DOM.
  - title: Bring your own live data
    details: Objects carry a host-owned feed id, and a StatusFeed overlays whatever state you publish under it. The toolkit renders it; what it means is yours to decide.
  - title: Themeable & extensible
    details: Design tokens, custom icons, map-colour callbacks, category + metadata, and host slots — impose your own design system.
  - title: Three composable packages
    details: A framework-free schema core, a read-only viewer, and a full editor. Install only what you use.
  - title: Open source
    details: MIT licensed. A reference editor and viewer application show a real integration end to end.
---

## See it in action

The reference editor descending the floors of a real Helsinki building in 3D, one level at a time inside the cutaway:

<video autoplay loop muted playsinline poster="/media/editor-3d.png" style="width:100%;border-radius:12px;margin:1.5rem 0;box-shadow:0 8px 30px rgba(0,0,0,0.12)">
  <source src="/media/showcase.mp4" type="video/mp4" />
  <img src="/media/editor-3d.png" alt="The Kerros editor showing a building in 3D" style="width:100%" />
</video>

## A model, not an application

Kerros describes premises — what exists, what contains what, what connects to what, in which
direction, and how far a crossing can be trusted. It never says who may pass, when, or why, and it
ships no opinion about what you are building: wayfinding, facility management, evacuation planning,
reservations, access control, a digital twin. Those are your application, and the join between it and
the model is an id.

That boundary is deliberate. Keep your own rules in your own store, keyed by a space, zone or portal
id, and the two halves stay independently changeable — somebody redraws a floor, and your application
is still about the same zone.

Read the [guide](/guide/getting-started), browse the [schema reference](/reference/schema), or open
the [reference editor](https://kherrala.fi/kerros/app.html).
