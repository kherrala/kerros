# Remaining rendering and POV findings

Verified against the code on 2026-09-13. Resolved findings and historical closure reports have been removed.

- **Walls below a mezzanine:** walking collision uses active-floor wall pieces; walls from the host storey that reach the walking height are not included. Source: `walkWalls` in `src/map/MapCanvas.tsx`.
- **Unsupported outer floor edges:** authored gallery holes can drop onto a lower floor, but walking past an exposed outer plate edge has no support constraint. Preserve intentional gallery drops while handling edges without a landing. Sources: `src/map/walkSurfaces.ts`, `src/map/walk.ts`.
