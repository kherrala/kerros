// The described layer: zones, portals and portal groups — what groups with what, what connects to
// what, in which direction, and how far a crossing can be trusted. Everything here is semantics over
// ids; no geometry is read. Reading the plan itself (inferring portals, dividing spaces) lives in
// inference.ts, and turning this description into a routing graph lives in topology.ts.
import { isSpace, uid, type Portal, type PortalGroup, type ProjectDocument, type Zone } from './types';

/** Which way you must cross `portal` to arrive in `spaceId`, or null if you cannot get there that way.
 *  Direction is asked, never stored: a door's entry side is relative to the area you mean. */
export function entryInto(portal: Portal, spaceId: string): 'a-to-b' | 'b-to-a' | null {
  const passage = portal.passage ?? 'both';
  if (passage === 'none') return null;
  if (portal.b === spaceId && passage !== 'b-to-a') return 'a-to-b';
  if (portal.a === spaceId && passage !== 'a-to-b') return 'b-to-a';
  return null;
}

const memberSet = (project: ProjectDocument, zone: Zone, seen = new Set<string>()): Set<string> => {
  if (seen.has(zone.id)) return new Set(); // zones nest as a DAG; a cycle is a bug, not a hang
  seen.add(zone.id);
  const out = new Set(zone.spaceIds);
  for (const childId of zone.childZoneIds ?? []) {
    const child = project.zones?.find(z => z.id === childId);
    if (child) for (const id of memberSet(project, child, seen)) out.add(id);
  }
  return out;
};
/** Every space in `zone`, including those reached through nested zones. */
export const zoneSpaces = (project: ProjectDocument, zone: Zone): string[] => [...memberSet(project, zone)];

/** Portals on the boundary of `zone` — one side in, one side out. These are the ways in, and the
 *  thing software without a floor plan to ask makes you enumerate by hand. Derived, so it cannot go
 *  stale when the building is redrawn. */
export function perimeter(project: ProjectDocument, zone: Zone): Portal[] {
  const inside = memberSet(project, zone);
  return (project.portals ?? []).filter(p => inside.has(p.a) !== inside.has(p.b));
}
/** Portals wholly inside `zone`. Not decorative: anything tracking where somebody ended up needs to
 *  know that crossing one of these does not change which zone you are in. */
export function captive(project: ProjectDocument, zone: Zone): Portal[] {
  const inside = memberSet(project, zone);
  return (project.portals ?? []).filter(p => inside.has(p.a) && inside.has(p.b));
}

// ——— Authoring. Zones are the part a person actually writes: portals are read off the plan, but
// what counts as "Finance" or "the secure floor" is a decision nobody can derive.

/** Create a zone over the given spaces. Ids that are not spaces are dropped rather than rejected —
 *  a selection usually contains a door or a fixture alongside the rooms, and losing the whole gesture
 *  over that would be tiresome. */
export function addZone(project: ProjectDocument, name: string, spaceIds: string[], purpose?: string): Zone {
  const zone: Zone = {
    id: uid(),
    name,
    spaceIds: [...new Set(spaceIds)].filter(id => project.objects.some(o => o.id === id && isSpace(o.kind))),
  };
  if (purpose) zone.purpose = purpose;
  (project.zones ??= []).push(zone);
  return zone;
}
/** Remove a zone, and any nesting reference to it. A dangling childZoneIds entry fails validation. */
export function removeZone(project: ProjectDocument, zoneId: string) {
  project.zones = (project.zones ?? []).filter(z => z.id !== zoneId);
  for (const z of project.zones)
    if (z.childZoneIds?.includes(zoneId)) z.childZoneIds = z.childZoneIds.filter(id => id !== zoneId);
}
/** Add or remove spaces on a zone. Membership is a set: adding twice is not an error, and neither is
 *  removing something that was never there. */
export function setZoneMembers(project: ProjectDocument, zoneId: string, spaceIds: string[], member: boolean) {
  const zone = project.zones?.find(z => z.id === zoneId);
  if (!zone) return;
  const eligible = spaceIds.filter(id => project.objects.some(o => o.id === id && isSpace(o.kind)));
  const next = new Set(zone.spaceIds);
  for (const id of eligible)
    if (member) next.add(id);
    else next.delete(id);
  zone.spaceIds = [...next];
}
/** Nest one zone inside another, refusing anything that would make a cycle. Zones form a DAG, and a
 *  cycle is the one shape the validator will not accept. */
export function nestZone(project: ProjectDocument, parentId: string, childId: string): boolean {
  const parent = project.zones?.find(z => z.id === parentId);
  if (!parent || parentId === childId || !project.zones?.some(z => z.id === childId)) return false;
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (project.zones?.find(z => z.id === from)?.childZoneIds ?? []).some(id => reaches(id, target, seen));
  };
  if (reaches(childId, parentId)) return false; // the child already contains us
  parent.childZoneIds = [...new Set([...(parent.childZoneIds ?? []), childId])];
  return true;
}

/** Create a portal group over the given portals. The escape hatch for sets that are not a zone
 *  boundary — "all loading-bay shutters", "every door on the night circuit". Where a set *is* a zone
 *  boundary, derive it with `perimeter` instead; a derived list cannot go stale. Ids that are not
 *  portals are dropped rather than rejected, mirroring addZone. */
export function addPortalGroup(project: ProjectDocument, name: string, portalIds: string[]): PortalGroup {
  const group: PortalGroup = {
    id: uid(),
    name,
    portalIds: [...new Set(portalIds)].filter(id => (project.portals ?? []).some(p => p.id === id)),
  };
  (project.portalGroups ??= []).push(group);
  return group;
}
/** Remove a portal group. Nothing references groups, so nothing needs cleaning up after one. */
export function removePortalGroup(project: ProjectDocument, groupId: string) {
  project.portalGroups = (project.portalGroups ?? []).filter(g => g.id !== groupId);
}
/** Add or remove portals on a group. Membership is a set, exactly as setZoneMembers. */
export function setPortalGroupMembers(project: ProjectDocument, groupId: string, portalIds: string[], member: boolean) {
  const group = project.portalGroups?.find(g => g.id === groupId);
  if (!group) return;
  const eligible = portalIds.filter(id => (project.portals ?? []).some(p => p.id === id));
  const next = new Set(group.portalIds);
  for (const id of eligible)
    if (member) next.add(id);
    else next.delete(id);
  group.portalIds = [...next];
}

/** Drop ontology references to things that no longer exist.
 *
 *  Every reference here is validated, so a delete that skips this step produces an invalid document
 *  and gets refused — from the outside that looks like the delete silently doing nothing, which is
 *  the worst way for a bug to present. Call it after removing objects, from every path that can.
 *
 *  A portal whose opening is gone goes with it: the door was the way through, and keeping a portal
 *  that no longer has one would quietly turn a closed doorway into an open boundary. */
export function pruneOntology(project: ProjectDocument) {
  const alive = new Set(project.objects.map(o => o.id));
  const spaceIds = new Set(project.objects.filter(o => isSpace(o.kind)).map(o => o.id));
  if (project.portals)
    project.portals = project.portals.filter(
      p => spaceIds.has(p.a) && spaceIds.has(p.b) && (!p.openingId || alive.has(p.openingId)),
    );
  const portalIds = new Set((project.portals ?? []).map(p => p.id));
  if (project.zones) {
    const zoneIds = new Set(project.zones.map(z => z.id));
    for (const zone of project.zones) {
      zone.spaceIds = zone.spaceIds.filter(id => spaceIds.has(id));
      if (zone.childZoneIds) zone.childZoneIds = zone.childZoneIds.filter(id => zoneIds.has(id));
    }
  }
  if (project.portalGroups)
    for (const group of project.portalGroups) group.portalIds = group.portalIds.filter(id => portalIds.has(id));
}
