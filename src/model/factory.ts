// Core domain factories for building indoor-mapping documents from scratch — no app defaults, no
// demo data. Part of the schema contract so library users can construct valid projects and objects.
import type { ObjectKind, Origin, Point, ProjectDocument, SiteObject } from './types';

/** An empty, valid single-floor project anchored at an explicit EPSG:3067 origin (with optional site bearing). */
export function emptyProject(
  origin: Origin,
  name = 'Untitled site',
  datum = 'Site ground level = 0 m',
): ProjectDocument {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    description: name,
    updatedAt: new Date().toISOString(),
    origin,
    datum,
    buildings: [{ id: 'building-main', name: 'Main building' }],
    floors: [{ id: 'floor-ground', buildingId: 'building-main', name: 'Ground floor', elevation: 0, height: 3.5 }],
    junctions: [],
    barriers: [],
    objects: [],
    drawings: [],
  };
}
/** Create a site object of the given kind at a position, seeded with sensible default dimensions. */
export function createObject(kind: ObjectKind, position: Point, floorId: string | null, name?: string): SiteObject {
  const sizes: Partial<Record<ObjectKind, [number, number, number]>> = {
    door: [1, 0.2, 2.1],
    window: [1.2, 0.15, 1.6],
    gate: [4, 0.15, 2],
    turnstile: [1, 1, 1.1],
    elevator: [2.6, 2.6, 2.5],
    stairs: [2.5, 4.5, 2.7],
    office: [6, 3, 2.6],
    container: [6, 2.4, 2.6],
    storage: [8, 6, 0.1],
    camera: [0.5, 0.5, 2.4],
    sensor: [0.35, 0.35, 0.25],
    alarm: [0.4, 0.4, 0.4],
    equipment: [1.4, 0.9, 1.4],
  };
  const [width, depth, height] = sizes[kind] ?? [1, 1, 0];
  return {
    id: crypto.randomUUID(),
    kind,
    floorId,
    name: name ?? kind[0].toUpperCase() + kind.slice(1),
    position,
    rotation: 0,
    width,
    depth,
    height,
    symbol: kind === 'poi' ? 'personnel' : undefined,
    coverageAngle: kind === 'camera' ? 70 : undefined,
    coverageRange: kind === 'camera' ? 12 : undefined,
    servedFloorIds: kind === 'stairs' || kind === 'elevator' ? (floorId ? [floorId] : []) : undefined,
  };
}
