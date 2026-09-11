import type { ProjectDocument, SiteObject } from './types';
import { add, rotate } from './geometry';

export function copyProject(project: ProjectDocument): ProjectDocument {
  const copy = structuredClone(project);
  copy.id = crypto.randomUUID();
  copy.name = `${project.name} copy`;
  copy.updatedAt = new Date().toISOString();
  copy.objects.forEach(object => {
    delete object.feedId;
  });
  return copy;
}

/** Apply dimensions in the object's own axes, then rotate and translate its polygon. */
export function transformObject(object: SiteObject, patch: Partial<SiteObject>) {
  const oldRotation = object.rotation;
  const target = patch.position ?? object.position;
  if (object.rings) {
    const sx = (patch.width ?? object.width) / object.width;
    const sy = (patch.depth ?? object.depth) / object.depth;
    object.rings = object.rings.map(ring =>
      ring.map(point => {
        const local = rotate([point[0] - object.position[0], point[1] - object.position[1]], -oldRotation);
        return add(target, rotate([local[0] * sx, local[1] * sy], patch.rotation ?? oldRotation));
      }),
    );
  }
  Object.assign(object, patch);
}

/** The floor a viewer should open on: the document's own `initialFloorId` when it names a floor that
 *  still exists, otherwise the ground floor, otherwise the lowest one. An explicit `null` is a real
 *  answer — it means the outdoor site — so it is distinguished from the field being absent. */
export function openingFloorId(project: ProjectDocument): string | null {
  const preferred = project.initialFloorId;
  if (preferred === null) return null;
  if (preferred !== undefined && project.floors.some(f => f.id === preferred)) return preferred;
  return project.floors.find(f => f.elevation === 0)?.id ?? project.floors[0]?.id ?? null;
}
