/** Numerical tolerances are independent of the user's positioning grid. All values are metres. */
export const GEOMETRY_EPS = 1e-6;
export const JOIN_EPS = 0.001;
export const MIN_WALL_LENGTH = 0.01;
export const MIN_RING_EDGE = 0.001;
/** Usable floor area, after subtracting holes and physical walls, in square metres. */
export const MIN_SPACE_AREA = 1;
/** Topological faces and holes may be smaller than a labelled space. Square metres. */
export const MIN_FACE_AREA = 1e-8;
/** Only derived polygon-clipping inputs use this precision; junctions retain their coordinates. */
export const CLIP_SCALE = 1e4;
