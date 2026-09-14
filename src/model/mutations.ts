// A uniform, serializable representation of change. Every mutation is plain data — a kind and its
// arguments — executed through the same atomic gate (`transact`): clone, apply, run every rule,
// commit or refuse. What that buys:
//
//   - one execution path to reason about, instead of a hand-rolled clone/validate at every call site
//   - mutations can be logged, replayed, table-tested and sent over a wire, because they are data
//   - a sequence is atomic as a whole (`applyMutations`): a migration that fails at step 7 of 12
//     leaves the document exactly as it was, not seven-twelfths changed
//
// The vocabulary maps 1:1 onto the authoring functions the modules already export — this file adds
// no new behaviour, only a data shape for the behaviour that exists. Interactive gestures (dragging
// a wall, tracing a footprint) stay as plain `transact` callbacks in the editor; a Mutation is for
// changes worth naming.
import type {
  Barrier,
  Building,
  Floor,
  NavEdge,
  NavNode,
  ObjectKind,
  Origin,
  Point,
  Portal,
  PortalGroup,
  ProjectDocument,
  Ring,
  SiteObject,
  Zone,
} from './types';
import { uid } from './types';
import { addBarrier, duplicateFloor, removeBarrier, removeFloor, splitRoom } from './geometry';
import { applyGeometryDrag, drawBarrier, encloseRoom, type GeometryDrag } from './authoring';
import { createObject } from './factory';
import {
  addPortalGroup,
  addZone,
  nestZone,
  pruneOntology,
  removePortalGroup,
  removeZone,
  setPortalGroupMembers,
  setZoneMembers,
} from './ontology';
import { divideSpaces, mergeSpaces, refreshPortals } from './inference';
import { transact, type TransactResult } from './validate';
import { addBoundaryHole, addVirtualBoundary, connectSpace, disconnectSpace, drawVirtualBoundary } from './boundaries';

/** Every mutation the schema can execute, as data. `kind` names the operation; the rest are its
 *  arguments, exactly as the underlying authoring function takes them. */
export type Mutation =
  | { kind: 'addBuilding'; building: Building }
  | { kind: 'patchBuilding'; buildingId: string; set: Partial<Omit<Building, 'id'>> }
  | { kind: 'addFloor'; floor: Floor }
  | { kind: 'patchFloor'; floorId: string; set: Partial<Omit<Floor, 'id' | 'buildingId'>> }
  | { kind: 'removeFloor'; floorId: string }
  | { kind: 'duplicateFloor'; floorId: string }
  | { kind: 'patchProject'; set: Partial<Pick<ProjectDocument, 'name' | 'description' | 'datum' | 'initialFloorId'>> }
  | { kind: 'patchBarrier'; barrierId: string; set: Partial<Omit<Barrier, 'id' | 'startId' | 'endId' | 'floorId'>> }
  | { kind: 'removeBarrier'; barrierId: string }
  | { kind: 'moveGeometry'; move: GeometryDrag }
  | { kind: 'drawBoundary'; a: Point; b: Point; floorId: string | null }
  | { kind: 'drawBarrier'; a: Point; b: Point; floorId: string | null; barrierKind?: 'wall' | 'fence' }
  | { kind: 'encloseRoom'; floorId: string | null; point: Point; name?: string }
  | { kind: 'addHole'; objectId: string; ring: Ring }
  | { kind: 'patchZone'; zoneId: string; set: Partial<Pick<Zone, 'name' | 'purpose' | 'connects' | 'metadata'>> }
  | { kind: 'addPortal'; portal: Omit<Portal, 'id'> }
  | { kind: 'removePortal'; portalId: string }
  | { kind: 'setNavigation'; nodes: NavNode[]; edges: NavEdge[] }
  | { kind: 'addZone'; name: string; spaceIds: string[]; purpose?: string }
  | { kind: 'removeZone'; zoneId: string }
  | { kind: 'setZoneMembers'; zoneId: string; spaceIds: string[]; member: boolean }
  | { kind: 'nestZone'; parentId: string; childId: string }
  | { kind: 'addPortalGroup'; name: string; portalIds: string[] }
  | { kind: 'removePortalGroup'; groupId: string }
  | { kind: 'setPortalGroupMembers'; groupId: string; portalIds: string[]; member: boolean }
  // patchPortal deliberately cannot touch a/b/openingId — which spaces a portal joins is the
  // plan's to say (inference or an explicit new portal), never a field edit. patchObject is wide
  // open bar id and kind: every field it can set is re-checked by the full rule set on commit.
  | { kind: 'patchPortal'; portalId: string; set: Partial<Omit<Portal, 'id' | 'a' | 'b' | 'openingId'>> }
  | { kind: 'patchObject'; objectId: string; set: Partial<Omit<SiteObject, 'id' | 'kind'>> }
  // addObject seeds with createObject's defaults, then applies the given fields — so a mutation
  // script says only what differs (rings, width, a barrier binding), not every dimension.
  | {
      kind: 'addObject';
      objectKind: ObjectKind;
      name: string;
      position: Point;
      floorId: string | null;
      set?: Partial<Omit<SiteObject, 'id' | 'kind'>>;
    }
  | { kind: 'removeObjects'; ids: string[] }
  | { kind: 'refreshPortals' }
  | { kind: 'pruneOntology' }
  | { kind: 'addBarrier'; a: Point; b: Point; floorId: string | null; barrierKind: 'wall' | 'fence' }
  | { kind: 'addBoundary'; a: Point; b: Point; floorId: string | null }
  | { kind: 'connectSpace'; objectId: string; source?: 'outline' | 'walls' }
  | { kind: 'disconnectSpace'; objectId: string }
  | { kind: 'splitRoom'; roomId: string; a: Point; b: Point; wall?: boolean }
  | { kind: 'divideSpaces'; floorId: string | null; a: Point; b: Point }
  | { kind: 'mergeSpaces'; keepId: string; absorbedId: string }
  /** Move or turn the whole site. The geometry is untouched — local metres stay what they were; only
   *  where the frame is pinned and which way it faces change. A plan carries no heading, so this is
   *  how an imported one is squared onto the street it actually stands on. */
  | { kind: 'setOrigin'; origin: Origin };

/** What a mutation reports back, beyond the new document: the entity it created, or whether it did
 *  anything at all. Read it off the result rather than hunting the document for what changed.
 *  Entity outcomes are views INTO the frozen result — read them freely, but editing one throws;
 *  the next change goes through the next transaction like every other. */
export type MutationOutcome = Zone | PortalGroup | string[] | string | boolean | number | undefined;

const run = (draft: ProjectDocument, m: Mutation): MutationOutcome => {
  switch (m.kind) {
    case 'addBuilding':
      draft.buildings.push(structuredClone(m.building));
      return m.building.id;
    case 'patchBuilding':
      return patch(draft.buildings, m.buildingId, m.set, ['id']);
    case 'addFloor':
      draft.floors.push(structuredClone(m.floor));
      return m.floor.id;
    case 'patchFloor':
      return patch(draft.floors, m.floorId, m.set, ['id', 'buildingId']);
    case 'removeFloor':
      return removeFloor(draft, m.floorId);
    case 'duplicateFloor':
      if (!draft.floors.some(f => f.id === m.floorId)) throw new Error('No such floor.');
      return duplicateFloor(draft, m.floorId);
    case 'patchProject':
      for (const key of Object.keys(m.set))
        if (!['name', 'description', 'datum', 'initialFloorId'].includes(key))
          throw new Error(`Cannot patch project ${key}.`);
      Object.assign(draft, m.set);
      return draft.id;
    case 'patchBarrier':
      return patch(draft.barriers, m.barrierId, m.set, ['id', 'startId', 'endId', 'floorId']);
    case 'removeBarrier':
      removeBarrier(draft, m.barrierId);
      pruneOntology(draft);
      return undefined;
    case 'moveGeometry':
      applyGeometryDrag(draft, m.move);
      return m.move.id;
    case 'drawBoundary':
      return drawVirtualBoundary(draft, m.floorId, m.a, m.b);
    case 'drawBarrier':
      return drawBarrier(draft, m.floorId, m.a, m.b, m.barrierKind)?.id;
    case 'encloseRoom': {
      const result = encloseRoom(draft, m.floorId, m.point);
      if (!result) throw new Error('No enclosed region at that point. Complete its walls or virtual boundaries first.');
      if (m.name) result.room.name = m.name;
      return result.room.id;
    }
    case 'addHole': {
      const object = draft.objects.find(o => o.id === m.objectId);
      if (!object?.rings?.length) throw new Error('Select an area with a footprint.');
      if (object.geometry?.mode === 'boundaries') addBoundaryHole(draft, object, m.ring);
      else object.rings.push(structuredClone(m.ring));
      return object.id;
    }
    case 'patchZone':
      for (const key of Object.keys(m.set))
        if (!['name', 'purpose', 'connects', 'metadata'].includes(key)) throw new Error(`Cannot patch zone ${key}.`);
      return patch(draft.zones ?? [], m.zoneId, m.set, ['id']);
    case 'addPortal': {
      const id = uid();
      (draft.portals ??= []).push({ ...structuredClone(m.portal), id });
      return id;
    }
    case 'removePortal':
      draft.portals = (draft.portals ?? []).filter(p => p.id !== m.portalId);
      pruneOntology(draft);
      return undefined;
    case 'setNavigation':
      draft.navNodes = structuredClone(m.nodes);
      draft.navEdges = structuredClone(m.edges);
      return undefined;
    case 'addZone':
      return addZone(draft, m.name, m.spaceIds, m.purpose);
    case 'removeZone':
      removeZone(draft, m.zoneId);
      return undefined;
    case 'setZoneMembers':
      setZoneMembers(draft, m.zoneId, m.spaceIds, m.member);
      return undefined;
    case 'nestZone': {
      // A refused nesting (it would cycle) is an error, not a shrug: data-shaped callers cannot
      // check a boolean the way code-shaped callers can, so the refusal must surface as one.
      if (!nestZone(draft, m.parentId, m.childId)) throw new Error('That nesting would make a zone contain itself.');
      return true;
    }
    case 'addPortalGroup':
      return addPortalGroup(draft, m.name, m.portalIds);
    case 'removePortalGroup':
      removePortalGroup(draft, m.groupId);
      return undefined;
    case 'setPortalGroupMembers':
      setPortalGroupMembers(draft, m.groupId, m.portalIds, m.member);
      return undefined;
    case 'patchPortal': {
      return patch(draft.portals ?? [], m.portalId, m.set, ['id', 'a', 'b', 'openingId']);
    }
    case 'patchObject': {
      return patch(draft.objects, m.objectId, m.set, ['id', 'kind']);
    }
    case 'addObject': {
      const object = createObject(m.objectKind, m.position, m.floorId, m.name);
      if (m.set) patch([object], object.id, m.set, ['id', 'kind']);
      draft.objects.push(object);
      return object.id;
    }
    case 'removeObjects': {
      const gone = new Set(m.ids);
      const before = draft.objects.length;
      draft.objects = draft.objects.filter(o => !gone.has(o.id));
      // Everything that pointed at the removed objects follows them out: ontology references via
      // pruneOntology, and any authored graph nodes/edges bound to them — validation refuses
      // dangling references, so leaving them would turn this delete into a refused transaction.
      if (draft.navNodes) {
        const deadNodes = new Set(draft.navNodes.filter(n => n.objectId && gone.has(n.objectId)).map(n => n.id));
        draft.navNodes = draft.navNodes.filter(n => !deadNodes.has(n.id));
        draft.navEdges = (draft.navEdges ?? []).filter(
          e => !deadNodes.has(e.aId) && !deadNodes.has(e.bId) && (!e.objectId || !gone.has(e.objectId)),
        );
      }
      pruneOntology(draft);
      return before - draft.objects.length;
    }
    case 'refreshPortals':
      return refreshPortals(draft);
    case 'pruneOntology':
      pruneOntology(draft);
      return undefined;
    case 'addBarrier':
      return addBarrier(draft, m.a, m.b, m.floorId, m.barrierKind)?.id;
    case 'addBoundary':
      return addVirtualBoundary(draft, m.floorId, m.a, m.b);
    case 'connectSpace':
      connectSpace(draft, m.objectId, m.source);
      return m.objectId;
    case 'disconnectSpace':
      disconnectSpace(draft, m.objectId);
      return m.objectId;
    case 'splitRoom':
      return splitRoom(draft, m.roomId, m.a, m.b, m.wall);
    case 'divideSpaces':
      return divideSpaces(draft, m.floorId, m.a, m.b);
    case 'setOrigin': {
      draft.origin = [...m.origin] as Origin;
      return draft.origin.join(',');
    }
    case 'mergeSpaces': {
      if (!mergeSpaces(draft, m.keepId, m.absorbedId))
        throw new Error('Those spaces do not touch, so there is nothing to merge.');
      return true;
    }
    default:
      throw new Error(`Unknown mutation: ${String((m as { kind?: unknown }).kind)}`);
  }
};

function patch<T extends { id: string }>(items: T[], id: string, set: object, immutable: string[]) {
  const item = items.find(x => x.id === id);
  if (!item) throw new Error(`No such entity: ${id}`);
  for (const key of Object.keys(set))
    if (immutable.includes(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error(`Cannot patch ${key}.`);
  Object.assign(item, structuredClone(set));
  return id;
}

export type MutationResult = TransactResult & { outcomes?: MutationOutcome[] };

/** Execute one mutation atomically. Sugar over `applyMutations` with a single step. */
export const applyMutation = (project: ProjectDocument, mutation: Mutation): MutationResult =>
  applyMutations(project, [mutation]);

/** Execute a sequence of mutations as ONE transaction: all of them apply and the result passes
 *  every rule, or none of them do and `error` says why. `outcomes` reports what each step returned
 *  (created zones, split-off ids), in order — present only on success. */
export function applyMutations(project: ProjectDocument, mutations: Mutation[]): MutationResult {
  const outcomes: MutationOutcome[] = [];
  const result = transact(project, draft => {
    for (const [index, mutation] of mutations.entries()) {
      try {
        outcomes.push(run(draft, mutation));
      } catch (error) {
        throw new Error(
          `Mutation #${index + 1} (${mutation.kind}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });
  return result.ok ? { ...result, outcomes } : result;
}
