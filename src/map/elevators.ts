import type { Point, ProjectDocument, SiteObject } from '../model/types';
import { add, objectPosition, objectRotation, rectangle, rotate } from '../model/geometry';
import { servedFloors } from '../model/vertical';

export const cabinDimensions = (o: SiteObject) => ({
  width: Math.max(0.7, o.width - 0.28),
  depth: Math.max(0.7, o.depth - 0.28),
});
/** The car supplies the floor inside its footprint, even at the shaft's lowest landing. */
export function cabinFloorVoids(project: ProjectDocument, floorId: string, primary: Set<string>) {
  return project.objects
    .filter(o => o.kind === 'elevator' && primary.has(o.id) && servedFloors(project, o).some(f => f.id === floorId))
    .map(o => {
      const { width, depth } = cabinDimensions(o);
      return rectangle(objectPosition(project, o), width, depth, objectRotation(project, o));
    });
}

export const elevatorDoorWidth = (o: SiteObject, turn = 0) =>
  Math.max(0.7, Math.min(1.6, (turn % 180 ? o.depth : o.width) - 0.5));
export const elevatorFacing = (o: SiteObject) =>
  o.rotation + { front: 0, right: 90, back: 180, left: 270 }[o.doorSides?.[0] ?? 'front'];
export const elevatorLanding = (o: SiteObject): Point => {
  const turn = elevatorFacing(o) - o.rotation;
  return add(o.position, rotate([0, (turn % 180 ? o.width : o.depth) / 2 + 0.8], elevatorFacing(o)));
};
export function insideElevator(o: SiteObject, at: Point) {
  const local = rotate([at[0] - o.position[0], at[1] - o.position[1]], -o.rotation);
  return Math.abs(local[0]) < o.width / 2 - 0.2 && Math.abs(local[1]) < o.depth / 2 - 0.2;
}
/** Shaft faces and their jambs, shared by collision and the visible cabin. */
export function elevatorWalls(o: SiteObject, open: boolean) {
  const rings: Point[][] = [];
  for (const [face, turn] of [
    ['front', 0],
    ['right', 90],
    ['back', 180],
    ['left', 270],
  ] as const) {
    const across = turn % 180 ? o.depth : o.width,
      depth = turn % 180 ? o.width : o.depth;
    const gap = elevatorDoorWidth(o, turn);
    const doorway = open && (o.doorSides ?? ['front']).includes(face);
    const strip = (x: number, width: number) =>
      rings.push(
        rectangle(add(o.position, rotate([x, depth / 2 - 0.1], o.rotation + turn)), width, 0.2, o.rotation + turn),
      );
    if (!doorway) strip(0, across);
    else for (const sign of [-1, 1]) strip((sign * (across + gap)) / 4, (across - gap) / 2);
  }
  return rings;
}

/** Prefer the back wall for a mirror, and a side wall for a through-car lift. */
export const elevatorMirrorFace = (o: SiteObject) =>
  (['back', 'left', 'right', 'front'] as const).find(face => !(o.doorSides ?? ['front']).includes(face));
export function elevatorMirrorPoint(o: SiteObject): Point {
  const turn = { front: 0, right: 90, back: 180, left: 270 }[elevatorMirrorFace(o) ?? 'back'];
  return add(o.position, rotate([0, (turn % 180 ? o.width : o.depth) / 2], o.rotation + turn));
}
