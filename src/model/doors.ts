import type { Point, ProjectDocument, SiteObject } from './types';
import { add, barrierEnds, objectPosition, objectRotation, rotate } from './geometry';

/** One hinge and signed rotation for plan symbols, drag previews and the animated 3D leaf. */
export function doorGeometry(project: ProjectDocument, door: SiteObject) {
  const position = objectPosition(project, door),
    rotation = objectRotation(project, door);
  const hand = door.doorHinge === 'right' ? -1 : 1;
  const swing = (door.doorSwing ?? 1) * hand;
  const hinge = add(position, rotate([(-hand * door.width) / 2, 0], rotation));
  const tip = (degrees: number) => add(hinge, rotate([hand * door.width, 0], rotation + swing * degrees));
  return { hinge, swing, tip, arc: Array.from({ length: 16 }, (_, i) => tip(i * 6)) };
}

/** A small dead zone retains the original side during an ordinary along-wall drag. */
export function draggedDoorSwing(project: ProjectDocument, door: SiteObject, pointer: Point): 1 | -1 {
  const barrier = project.barriers.find(b => b.id === door.barrierId);
  if (!barrier) return door.doorSwing ?? 1;
  const [a, b] = barrierEnds(project, barrier);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const side = ((b[0] - a[0]) * (pointer[1] - a[1]) - (b[1] - a[1]) * (pointer[0] - a[0])) / length;
  return Math.abs(side) <= Math.max(0.08, barrier.thickness / 2) ? (door.doorSwing ?? 1) : side > 0 ? 1 : -1;
}

/** All moving leaves, shared by the plan and 3D renderer. Double doors meet in the centre. */
export function doorLeaves(project: ProjectDocument, door: SiteObject) {
  if (door.doorType === 'sliding') return [];
  if (door.doorType !== 'double') return [doorGeometry(project, door)];
  const position = objectPosition(project, door),
    rotation = objectRotation(project, door);
  return (['left', 'right'] as const).map((doorHinge, i) =>
    doorGeometry(project, {
      ...door,
      barrierId: undefined,
      position: add(position, rotate([((i ? 1 : -1) * door.width) / 4, 0], rotation)),
      rotation,
      width: door.width / 2,
      doorHinge,
    }),
  );
}

/** Architectural symbol (or a feed's current state), including a rail and travel arrow for sliders. */
export function doorSymbol(project: ProjectDocument, door: SiteObject, open?: boolean): Point[][] {
  if (door.doorType !== 'sliding')
    return doorLeaves(project, door).flatMap(leaf => [
      leaf.arc,
      [leaf.hinge, leaf.tip(open === undefined ? 90 : open ? 72 : 5)],
    ]);
  const position = objectPosition(project, door),
    rotation = objectRotation(project, door);
  const thickness = project.barriers.find(b => b.id === door.barrierId)?.thickness ?? 0.2;
  const side = door.doorSwing ?? 1,
    travel = door.doorHinge === 'right' ? 1 : -1;
  const at = (x: number, y: number) => add(position, rotate([x, y], rotation));
  const y = side * (thickness / 2 + 0.08),
    offset = open ? travel * door.width : 0;
  const head = travel * door.width * 0.7,
    tail = -travel * door.width * 0.15,
    arrowY = y + side * 0.2;
  return [
    [at(-door.width / 2 + offset, y), at(door.width / 2 + offset, y)],
    [at(tail, arrowY), at(head, arrowY)],
    [at(head - travel * 0.12, arrowY - 0.09), at(head, arrowY), at(head - travel * 0.12, arrowY + 0.09)],
  ];
}
