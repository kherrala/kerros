// Dev-only fixtures for the library's own unit tests — small, valid sample projects, deliberately
// simpler than the reference app's sample data. Never imported by a facade, so nothing here ships.
// The rich Stockmann/Silo generators live in app/demo and are exercised by integration
// tests there against the public @kerros/schema surface (findRoute, validateProject, …).
import {
  uid,
  type ObjectKind,
  type Point,
  type Portal,
  type ProjectDocument,
  type SiteObject,
  type Zone,
} from './types';
import { createObject, emptyProject } from './factory';
import { geoOrigin, rectangle } from './geometry';

/** An empty single-floor site anchored in Helsinki — the base most unit tests build on. */
export function newProject(name = 'Untitled site'): ProjectDocument {
  const p = emptyProject(geoOrigin([24.946, 60.185]), name);
  p.description = 'New site · Helsinki, Finland';
  return p;
}

// ——— Ontology-test vocabulary, shared by the spaces/ontology/inference/topology suites so each can
// speak in the same four verbs: add a floor, stand a space on it, join two spaces, name a zone.

/** A floor above the fixture's ground floor, so vertical cases have somewhere to go. */
export const addFloor = (p: ProjectDocument, id: string, elevation: number) => {
  p.floors.push({ id, buildingId: p.buildings[0].id, name: `Level ${elevation}`, elevation, height: 3 });
  return id;
};
/** A 4×4 space named after its own id, of any spatial kind. */
export const addSpace = (
  p: ProjectDocument,
  id: string,
  floorId: string | null,
  at: Point,
  kind: ObjectKind = 'room',
) => {
  p.objects.push({
    id,
    kind,
    floorId,
    name: id,
    position: at,
    rotation: 0,
    rings: [rectangle(at, 4, 4)],
    width: 4,
    depth: 4,
    height: 0,
  });
  return id;
};
/** A portal pushed straight onto the document, defaults and all. */
export const addPortal = (p: ProjectDocument, a: string, b: string, extra: Partial<Portal> = {}) => {
  const made: Portal = { id: uid(), a, b, ...extra };
  (p.portals ??= []).push(made);
  return made;
};
/** A zone pushed straight onto the document. */
export const addTestZone = (p: ProjectDocument, name: string, spaceIds: string[], extra: Partial<Zone> = {}) => {
  const made: Zone = { id: uid(), name, spaceIds, ...extra };
  (p.zones ??= []).push(made);
  return made;
};

/** A compact but valid two-floor building: a ground floor with rooms, two bound objects and a stair up. */
export function sampleProject(): ProjectDocument {
  const p = newProject('Sample building');
  p.floors.push({
    id: 'floor-1',
    buildingId: 'building-main',
    name: 'Level 1',
    elevation: 3.5,
    height: 3.5,
    code: '2',
  });
  const room = (name: string, center: [number, number], size: number): SiteObject => {
    const o = createObject('room', center, 'floor-ground', name);
    o.width = o.depth = size;
    o.rings = [rectangle(center, size, size)];
    return o;
  };
  const door = createObject('door', [0, -4], 'floor-ground', 'Front door');
  door.feedId = 'dev-door';
  const camera = createObject('camera', [4, 4], 'floor-ground', 'Lobby camera');
  camera.feedId = 'dev-cam';
  const stair = createObject('stairs', [8, 0], 'floor-ground', 'Stair');
  stair.servedFloorIds = ['floor-ground', 'floor-1'];
  p.objects.push(room('Lobby', [0, 0], 8), room('Office', [12, 0], 6), door, camera, stair);
  return p;
}
