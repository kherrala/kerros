// Describe the demo buildings with the ontology as well as the geometry, so the reference apps have
// something real to browse rather than an empty structure panel.
//
// Deliberately derived rather than hand-written: the vertical cores come from the landings already on
// the plan, and the portals are read off the doors. If a demo grows a floor, this follows.
import { inferOpenBoundaries, inferPortals } from '../../src/model/inference';
import { servedFloors, shaftKey } from '../../src/model/vertical';
import { uid, type ProjectDocument, type SiteObject, type Zone } from '../../src/model/types';

/** How a shaft's landings reach each other. A lift ride is direct, a stair passes every level on the
 *  way both ways, and an escalator carries you one way — which way is the object's own `travel`,
 *  not something to be guessed from what somebody called it. */
const connectsBy = (shaft: SiteObject): Zone['connects'] =>
  shaft.kind === 'elevator' ? 'all' : shaft.stairModel === 'escalator' ? (shaft.travel ?? 'up') : 'adjacent';
/** Landings that share a kind, a name and a position are one shaft. */
function cores(project: ProjectDocument): Zone[] {
  const groups = new Map<string, SiteObject[]>();
  for (const o of project.objects) {
    if (o.kind !== 'elevator' && o.kind !== 'stairs') continue;
    // Name AND place. A shaft is a vertical column standing somewhere, so two escalators at opposite
    // ends of a building that happen to share a name are two shafts, not one — group them together
    // and a route will walk you into the north escalator and out of the south one.
    const key = shaftKey(o);
    const group = groups.get(key);
    if (group) group.push(o);
    else groups.set(key, [o]);
  }
  const out: Zone[] = [];
  for (const members of groups.values()) {
    // A single landing is not a shaft — unless it says otherwise. A plan drawn sheet by sheet gives
    // one landing per storey and they group; a plan that draws the core once and lists the floors it
    // serves makes exactly the same claim in one object, and dropping it left every lift in the
    // Stockmann demo out of the structure panel because it was authored the second way.
    if (members.length < 2 && servedFloors(project, members[0]).length < 2) continue;
    out.push({
      id: uid(),
      name: members[0].name,
      spaceIds: members.map(m => m.id),
      connects: connectsBy(members[0]),
      purpose: 'circulation',
    });
  }
  return out;
}

/** Attach zones and portals to a demo project. Safe to call on any of them. */
export function attachOntology(project: ProjectDocument) {
  project.zones = cores(project);
  // Doors are the minority of a building's connections. A department store is mostly open plan, and
  // a lift car meets its lobby with no door object between them — read those off the geometry too, or
  // 86% of this building has no way in or out of it.
  project.portals = [...inferPortals(project), ...inferOpenBoundaries(project)];
  return project;
}
