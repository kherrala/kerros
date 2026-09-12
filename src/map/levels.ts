// Where a storey's surfaces sit above its datum.
//
// Apart from SceneLayer because they are the one thing the flat plan needs from the 3D renderer: walk
// mode solves its eye height from them, and importing them used to drag three.js and every material,
// texture and geometry behind it into any bundle that touched MapCanvas.
/** Clearance between the floor's datum and the underside of its slab. */
export const LIFT = 0.15;
/** The slab itself. */
export const SLAB = 0.18;
