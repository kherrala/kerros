import { applyMutations, emptyProject, findRoute, geoOrigin } from '@kerros/schema';

export function connectedPlan() {
  const initial = emptyProject(geoOrigin([24.94, 60.17]), 'Open-plan office');
  const floorId = initial.floors[0].id;
  // Coordinates are local metres. The virtual divider keeps two semantic spaces open to each other.
  const result = applyMutations(initial, [
    { kind: 'drawBarrier', floorId, a: [-4, -3], b: [4, -3] },
    { kind: 'drawBarrier', floorId, a: [4, -3], b: [4, 3] },
    { kind: 'drawBarrier', floorId, a: [4, 3], b: [-4, 3] },
    { kind: 'drawBarrier', floorId, a: [-4, 3], b: [-4, -3] },
    { kind: 'drawBoundary', floorId, a: [0, -3], b: [0, 3] },
    { kind: 'encloseRoom', floorId, point: [-2, 0], name: 'Lobby' },
    { kind: 'encloseRoom', floorId, point: [2, 0], name: 'Cafe' },
  ]);
  if (!result.ok) throw new Error(result.error);
  const project = result.project;
  const lobby = project.objects.find(o => o.name === 'Lobby')!;
  const cafe = project.objects.find(o => o.name === 'Cafe')!;
  const route = findRoute(project, lobby.id, cafe.id);
  return { project, lobby, cafe, route };
}
