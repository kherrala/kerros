import { applyMutations, emptyProject, findRoute, geoOrigin } from '@kerros/schema';

export function createConnectedPlan() {
  const initial = emptyProject(geoOrigin([24.94, 60.17]), 'Connected spaces');
  const floorId = initial.floors[0].id;
  // Coordinates are local metres. The virtual divider keeps two semantic spaces open to each other.
  const result = applyMutations(initial, [
    { kind: 'drawBarrier', floorId, a: [-4, -3], b: [4, -3] },
    { kind: 'drawBarrier', floorId, a: [4, -3], b: [4, 3] },
    { kind: 'drawBarrier', floorId, a: [4, 3], b: [-4, 3] },
    { kind: 'drawBarrier', floorId, a: [-4, 3], b: [-4, -3] },
    { kind: 'drawBoundary', floorId, a: [0, -3], b: [0, 3] },
    { kind: 'encloseRoom', floorId, point: [-2, 0], name: 'West room' },
    { kind: 'encloseRoom', floorId, point: [2, 0], name: 'East room' },
  ]);
  if (!result.ok) throw new Error(result.error);
  const project = result.project;
  const west = project.objects.find(o => o.name === 'West room')!;
  const east = project.objects.find(o => o.name === 'East room')!;
  const route = findRoute(project, west.id, east.id);
  return { project, west, east, route };
}
