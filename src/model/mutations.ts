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
import type { ObjectKind, Origin, Point, Portal, PortalGroup, ProjectDocument, SiteObject, Zone } from './types';
import { addBarrier, splitRoom } from './geometry';
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

/** Every mutation the schema can execute, as data. `kind` names the operation; the rest are its
 *  arguments, exactly as the underlying authoring function takes them. */
export type Mutation =
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
      const portal = (draft.portals ?? []).find(x => x.id === m.portalId);
      if (!portal) throw new Error('No such portal.');
      Object.assign(portal, m.set);
      return portal.id;
    }
    case 'patchObject': {
      const object = draft.objects.find(x => x.id === m.objectId);
      if (!object) throw new Error('No such object.');
      Object.assign(object, m.set);
      return object.id;
    }
    case 'addObject': {
      const object = createObject(m.objectKind, m.position, m.floorId, m.name);
      if (m.set) Object.assign(object, m.set);
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
      addBarrier(draft, m.a, m.b, m.floorId, m.barrierKind);
      return undefined;
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
  }
};

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
    for (const mutation of mutations) outcomes.push(run(draft, mutation));
  });
  return result.ok ? { ...result, outcomes } : result;
}
