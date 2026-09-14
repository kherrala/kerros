// The validity layer, in one place: every rule a Kerros document must satisfy — structural, ontological,
// geometric, navigational — and the transaction gate that enforces them on every change.
//
// The contract the rest of the library leans on: a ProjectDocument in circulation is ALWAYS valid.
// Loading validates (importProject, parseExport, the repositories), and editing validates through
// `transact`, which works on a clone and refuses to return a document that fails any rule — so an
// invalid state is never observable, only reported as the error that would have created it.
import { synchronizeGeometry, validateSpaceBoundaries } from './boundaries';
import {
  MIN_SEGMENT,
  OPENING_MIN_SEGMENT,
  barrierEnds,
  containedBy,
  distance,
  intersects,
  openRing,
  objectArea,
  pointInRing,
  ringArea,
} from './geometry';
import { navEdges, navNodes } from './navigation';
import { EXTERIOR_PRESETS } from './materials';
import { AMBIENCE_PRESETS, OBJECT_KINDS, isArea, isOpening, isSpace } from './types';
import type { Ambience, Point, ProjectDocument, Ring, SiteObject } from './types';
import { MIN_FACE_AREA, MIN_SPACE_AREA } from './precision';

/** How far from the site origin a coordinate may sit, in metres. A guard against corrupt data, not a
 *  modelling limit: no site is 100 km across, but a NaN that became 1e15 through arithmetic would
 *  otherwise sail through every finite() check and break projection math much later and much worse. */
export const COORD_LIMIT = 100_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown) =>
  Array.isArray(v) && v.length === 2 && v.every(n => finite(n) && Math.abs(n) <= COORD_LIMIT);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const distinct = (ids: readonly unknown[]) => new Set(ids).size === ids.length;

/** Geometric sanity of an area's rings: a real outer boundary, no self-crossings, holes inside and
 *  disjoint. Returns an error message or null. */
export function validateRings(rings: Ring[], minEdge = 0.001, minArea = 0.01): string | null {
  if (!rings.length) return 'Draw an outer boundary first.';
  for (const ring of rings) {
    const p = openRing(ring);
    if (p.length < 3 || ringArea(p) < minArea) return 'An area needs at least three vertices and a non-zero area.';
    for (let i = 0; i < p.length; i++) {
      if (distance(p[i], p[(i + 1) % p.length]) < minEdge) return 'Remove duplicate vertices.';
      for (let j = i + 1; j < p.length; j++) {
        if (j === i + 1 || (i === 0 && j === p.length - 1)) continue;
        if (intersects(p[i], p[(i + 1) % p.length], p[j], p[(j + 1) % p.length]))
          return 'Area boundaries cannot cross themselves.';
      }
    }
  }
  for (let i = 1; i < rings.length; i++) {
    if (!rings[i].every(p => pointInRing(p, rings[0]))) return 'A hole must be completely inside the outer boundary.';
    for (let j = 0; j < i; j++) {
      const a = openRing(rings[i]),
        b = openRing(rings[j]);
      for (let k = 0; k < a.length; k++)
        for (let l = 0; l < b.length; l++)
          if (intersects(a[k], a[(k + 1) % a.length], b[l], b[(l + 1) % b.length]))
            return 'Hole boundaries must not touch or overlap.';
      if (j > 0 && (pointInRing(a[0], b) || pointInRing(b[0], a))) return 'Holes cannot overlap.';
    }
  }
  return null;
}

/** Spatial relationships between entities: ring sanity per object, parent containment without
 *  cycles, and openings that actually fit the barriers they sit in. */
export function validateRelationships(project: ProjectDocument): string | null {
  // Reject degenerate segments, while allowing real returns and jambs below the drawing-grid size.
  for (const barrier of project.barriers) {
    const [a, b] = barrierEnds(project, barrier);
    if (distance(a, b) < MIN_SEGMENT - 1e-6) return `A wall or fence must be at least ${MIN_SEGMENT} m long.`;
  }
  for (const object of project.objects) {
    if (object.rings) {
      const shared = object.geometry?.mode === 'boundaries';
      const error = validateRings(object.rings, shared ? 1e-6 : 0.001, shared ? MIN_FACE_AREA : 0.01);
      if (error) return error;
    }
    if (object.parentId) {
      const parent = project.objects.find(o => o.id === object.parentId);
      if (
        !parent?.rings ||
        !object.rings ||
        parent.floorId !== object.floorId ||
        !containedBy(object.rings, parent.rings)
      )
        return 'A nested zone must remain inside its parent on the same floor.';
      const seen = new Set([object.id]);
      let ancestor: SiteObject | undefined = parent;
      while (ancestor) {
        if (seen.has(ancestor.id)) return 'Zone parents cannot form a cycle.';
        seen.add(ancestor.id);
        ancestor = project.objects.find(o => o.id === ancestor!.parentId);
      }
    }
    if (object.barrierId) {
      // Only an opening belongs in a barrier: a camera "set into" a wall is a placement bug, and
      // validating it as an opening would let it punch a hole through the rendering.
      if (!isOpening(object.kind)) return 'Only a door, window or gate can sit in a barrier.';
      const barrier = project.barriers.find(b => b.id === object.barrierId);
      if (!barrier || barrier.floorId !== object.floorId)
        return 'Opening references a missing barrier or a different floor.';
      const [a, b] = barrierEnds(project, barrier);
      // Actual opening width decides the required wall length, including narrow windows and doors.
      if (distance(a, b) < OPENING_MIN_SEGMENT - 1e-6)
        return `A door, window or gate needs a segment at least ${OPENING_MIN_SEGMENT} m long to sit in.`;
      const offset = object.offset ?? 0;
      if (offset - object.width / 2 < -0.001 || offset + object.width / 2 > distance(a, b) + 0.001)
        return `The barrier is too short for its attached opening. Opening "${object.name || object.id}" (${object.id}) on barrier ${barrier.id}: width ${object.width.toFixed(2)} m, centre offset ${offset.toFixed(2)} m, segment length ${distance(a, b).toFixed(2)} m. The centre offset must be between ${(object.width / 2).toFixed(2)} and ${(distance(a, b) - object.width / 2).toFixed(2)} m; if that interval is empty, choose a longer host segment.`;
      if (
        project.objects.some(
          o =>
            o.id !== object.id &&
            o.barrierId === barrier.id &&
            Math.abs((o.offset ?? 0) - offset) < (o.width + object.width) / 2 - 0.001,
        )
      )
        return 'Attached openings cannot overlap.';
    }
  }
  return null;
}

/** Semantic validation of the navigation graph — authored or derived; structural checks (ids,
 *  uniqueness) live in validateProject. Returns an error message or null. */
export function validateNavigation(p: ProjectDocument): string | null {
  const nodes = navNodes(p),
    byId = new Map(nodes.map(n => [n.id, n]));
  const floorIds = new Set(p.floors.map(f => f.id));
  for (const n of nodes) {
    if (!point(n.position)) return 'A route node needs a valid position.';
    if (n.floorId !== null && !floorIds.has(n.floorId)) return 'A route node references an unknown floor.';
    if (n.objectId !== undefined && !p.objects.some(o => o.id === n.objectId))
      return 'A route node references a missing object.';
  }
  for (const e of navEdges(p)) {
    if (!['walk', 'door', 'stairs', 'elevator'].includes(e.kind)) return 'Unknown route edge kind.';
    const a = byId.get(e.aId),
      b = byId.get(e.bId);
    if (!a || !b || e.aId === e.bId) return 'A route edge must join two different route nodes.';
    if (e.weight !== undefined && (typeof e.weight !== 'number' || !Number.isFinite(e.weight) || e.weight <= 0))
      return 'A route edge weight must be a positive number.';
    const vertical = e.kind === 'stairs' || e.kind === 'elevator';
    if (vertical && a.floorId === b.floorId) return 'Stairs and elevator edges must join different floors.';
    if (e.kind === 'walk' && a.floorId !== b.floorId) return 'Walk edges must stay on one floor.';
    if (e.kind === 'door' && a.floorId !== b.floorId && a.floorId !== null && b.floorId !== null)
      return 'Door edges must stay on one floor or step outside.';
    if (e.objectId === undefined) continue;
    const object = p.objects.find(o => o.id === e.objectId);
    if (!object) return 'A route edge references a missing object.';
    if (e.kind === 'door' && !['door', 'gate', 'turnstile'].includes(object.kind))
      return 'A door edge must bind a door, gate or turnstile.';
    if (vertical && object.kind !== e.kind) return 'A vertical edge must bind a matching stairs or elevator object.';
    // Only meaningful when the object declares which floors it serves. A lift whose floors come from
    // a zone's `connects` declares nothing here, and is correct by construction — the edges were
    // generated from that zone's own membership, so there is no second list to disagree with.
    if (
      vertical &&
      object.servedFloorIds &&
      [a, b].some(n => n.floorId !== null && !object.servedFloorIds!.includes(n.floorId))
    )
      return 'A vertical edge joins a floor its stairs or elevator does not serve.';
  }
  return null;
}

/** Parse and validate an unknown value into a ProjectDocument; throws with a reason on any failure.
 *  Every rule the schema has lives behind this one entry point. */
export function validateProject(value: unknown): ProjectDocument {
  const fail = (message: string): never => {
    throw new Error(`Invalid project: ${message}`);
  };
  // One version until the first release. The schema is still being cut, so rather than carry
  // migrations for shapes nobody has shipped against, anything else is simply not a Kerros document.
  if (!object(value) || value.schemaVersion !== 1)
    fail(
      'unsupported schema version (expected 1). The schema is still changing before release — re-create the project.',
    );
  const v = value as Record<string, unknown>;
  // Origin is [lng, lat, bearing?] in WGS84 — the range check also flags pre-v2 projected (metre) origins.
  const origin = (o: unknown) =>
    Array.isArray(o) &&
    (o.length === 2 || o.length === 3) &&
    o.every(finite) &&
    Math.abs(o[0]) <= 180 &&
    Math.abs(o[1]) <= 90;
  if (
    !string(v.id) ||
    !string(v.name) ||
    !origin(v.origin) ||
    typeof v.description !== 'string' ||
    typeof v.datum !== 'string' ||
    !string(v.updatedAt)
  )
    fail('missing project metadata.');
  for (const key of ['buildings', 'floors', 'junctions', 'barriers', 'objects', 'drawings'])
    if (!Array.isArray(v[key]) || (v[key] as unknown[]).some(x => !object(x) || !string(x.id)))
      fail(`malformed ${key}.`);
  for (const key of ['navNodes', 'navEdges', 'zones', 'portals', 'portalGroups', 'virtualBoundaries'] as const)
    if (
      v[key] !== undefined &&
      (!Array.isArray(v[key]) || (v[key] as unknown[]).some(x => !object(x) || !string(x.id)))
    )
      fail(`malformed ${key}.`);
  const p = v as unknown as ProjectDocument;
  const all = [
    ...p.buildings,
    ...p.floors,
    ...p.junctions,
    ...p.barriers,
    ...(p.virtualBoundaries ?? []),
    ...p.objects,
    ...p.drawings,
    ...(p.navNodes ?? []),
    ...(p.navEdges ?? []),
    ...(p.zones ?? []),
    ...(p.portals ?? []),
    ...(p.portalGroups ?? []),
  ];
  if (new Set(all.map(x => x.id)).size !== all.length) fail('duplicate entity IDs.');
  const floorIds = new Set(p.floors.map(f => f.id)),
    buildingIds = new Set(p.buildings.map(b => b.id));
  if (
    !p.buildings.length ||
    p.buildings.some(
      b => !string(b.name) || (b.sourceId !== undefined && !string(b.sourceId) && !finite(b.sourceId)),
    ) ||
    !p.floors.length ||
    p.floors.some(
      f =>
        !buildingIds.has(f.buildingId) || !string(f.name) || !finite(f.elevation) || !finite(f.height) || f.height <= 0,
    )
  )
    fail('invalid buildings or floors.');
  // An escalator runs one way; a stair does not have a way to run. Saying a staircase travels up
  // describes nothing, and something downstream would eventually believe it.
  if (
    p.objects.some(o => o.travel !== undefined && (o.kind !== 'stairs' || (o.travel !== 'up' && o.travel !== 'down')))
  )
    fail('travel belongs to an escalator and must be up or down.');
  // A lamp that exists: a colour temperature inside the range a luminaire is actually made in, and
  // a level between off and fully lit. Absent is the common case and means a fluorescent ceiling.
  if (
    p.floors.some(
      f =>
        f.light !== undefined &&
        (!finite(f.light.kelvin) ||
          f.light.kelvin < 1000 ||
          f.light.kelvin > 12000 ||
          !finite(f.light.level) ||
          f.light.level < 0 ||
          f.light.level > 1 ||
          (f.light.tint !== undefined && (typeof f.light.tint !== 'string' || !/^#[0-9a-f]{6}$/i.test(f.light.tint)))),
    )
  )
    fail('a floor names a light that is not a lamp.');
  const badAmbience = (a: Ambience | undefined) =>
    a !== undefined &&
    (!AMBIENCE_PRESETS.includes(a.preset) ||
      (a.level !== undefined && (!finite(a.level) || a.level < 0 || a.level > 1)));
  if (p.floors.some(f => badAmbience(f.ambience)) || p.objects.some(o => badAmbience(o.ambience)))
    fail('an ambience names a preset that does not exist, or a level outside 0..1.');
  if (p.initialFloorId !== undefined && p.initialFloorId !== null && !p.floors.some(f => f.id === p.initialFloorId))
    fail('initialFloorId names a floor that does not exist.');
  if (p.buildings.some(b => b.exteriorPreset !== undefined && !Object.hasOwn(EXTERIOR_PRESETS, b.exteriorPreset)))
    fail('unknown exterior preset.');
  for (const e of [...p.junctions, ...p.barriers, ...p.objects, ...p.drawings])
    if (e.floorId !== null && !floorIds.has(e.floorId)) fail('unknown floor reference.');
  if (p.junctions.some(j => !point(j.position))) fail('invalid junction coordinates.');
  for (const edge of p.virtualBoundaries ?? []) {
    const a = p.junctions.find(j => j.id === edge.startId),
      b = p.junctions.find(j => j.id === edge.endId);
    if (
      !a ||
      !b ||
      a.floorId !== edge.floorId ||
      b.floorId !== edge.floorId ||
      distance(a.position, b.position) < 0.001 - 1e-6
    )
      fail('invalid virtual boundary.');
  }
  if (
    p.barriers.some(
      b =>
        !['wall', 'fence'].includes(b.kind) ||
        !string(b.name) ||
        !p.junctions.some(j => j.id === b.startId && j.floorId === b.floorId) ||
        !p.junctions.some(j => j.id === b.endId && j.floorId === b.floorId) ||
        b.startId === b.endId ||
        !finite(b.height) ||
        b.height <= 0 ||
        !finite(b.thickness) ||
        b.thickness <= 0,
    )
  )
    fail('invalid barrier.');
  // The drawn areas of each level, gathered once: the served-floor rule below asks what is under a
  // shaft on every level it claims, and a department store asks that a couple of hundred times.
  const areasByFloor = new Map<string, SiteObject[]>();
  for (const o of p.objects)
    if (o.floorId && isArea(o.kind) && Array.isArray(o.rings) && Array.isArray(o.rings[0]))
      areasByFloor.set(o.floorId, [...(areasByFloor.get(o.floorId) ?? []), o]);
  for (const o of p.objects) {
    if (
      !(OBJECT_KINDS as readonly string[]).includes(o.kind) ||
      !string(o.name) ||
      !point(o.position) ||
      !finite(o.rotation) ||
      !finite(o.width) ||
      o.width <= 0 ||
      !finite(o.depth) ||
      o.depth <= 0 ||
      !finite(o.height) ||
      o.height < 0
    )
      fail('invalid object dimensions or type.');
    if (o.rings && (!Array.isArray(o.rings) || o.rings.some(r => !Array.isArray(r) || r.some(p => !point(p)))))
      fail('invalid polygon coordinates.');
    if (o.servedFloorIds && (!Array.isArray(o.servedFloorIds) || o.servedFloorIds.some(id => !floorIds.has(id))))
      fail('unknown served floor.');
    if (o.servedFloorIds && !distinct(o.servedFloorIds)) fail('served floors must be listed once each.');
    // A shaft stands in one place and reaches a list of levels, so the plan has to agree with itself
    // about that place: where the drawn areas of the levels it serves put floor under it, they all
    // have to. One that lands on twelve plates and falls outside the thirteenth is the real case —
    // a lift core beside a mezzanine gallery, its doors opening onto the hall two storeys down, and
    // routing sending someone through them. Judged on outer boundaries only (a hole is exactly where
    // a shaft belongs: a stair in a light well, a lift in an atrium), and only against levels that
    // are drawn at all — a plan whose floors are not areas yet says nothing about any of its shafts,
    // which is why a shaft standing off every one of them is left alone.
    if (o.servedFloorIds && (o.kind === 'stairs' || o.kind === 'elevator')) {
      const drawn = o.servedFloorIds.map(id => areasByFloor.get(id)).filter(areas => !!areas?.length);
      const on = drawn.map(areas => areas!.some(a => pointInRing(o.position, (a.rings as Ring[])[0])));
      if (on.some(Boolean) && !on.every(Boolean))
        fail('a stair or lift serves a level it does not stand on — its landing there opens onto nothing.');
    }
    if (o.doorHinge !== undefined || o.doorSwing !== undefined || o.doorType !== undefined) {
      if (o.kind !== 'door') fail('only doors carry mechanism, hinge and swing settings.');
      if (o.doorType !== undefined && !['hinged', 'sliding', 'double'].includes(o.doorType))
        fail('door type must be hinged, sliding or double.');
      if (o.doorHinge !== undefined && !['left', 'right'].includes(o.doorHinge))
        fail('door hinge must be left or right.');
      if (o.doorSwing !== undefined && o.doorSwing !== 1 && o.doorSwing !== -1) fail('door swing must be 1 or -1.');
    }
    if (o.doorSides !== undefined) {
      if (o.kind !== 'elevator') fail('only an elevator lists door sides.');
      if (
        !Array.isArray(o.doorSides) ||
        !o.doorSides.length ||
        o.doorSides.some(d => !['front', 'back', 'left', 'right'].includes(d as string)) ||
        !distinct(o.doorSides as string[])
      )
        fail('door sides are front, back, left or right, listed once each.');
    }
    if (o.wellGroup !== undefined && (o.kind !== 'stairs' || !string(o.wellGroup) || !o.wellGroup.trim()))
      fail('only stairs carry a non-empty shared well group.');
    if (o.stairModel !== undefined) {
      if (o.kind !== 'stairs') fail('only stairs carry a stair model.');
      if (!['straight', 'switchback', 'dogleg', 'spiral', 'escalator'].includes(o.stairModel as string))
        fail('a stair model is straight, switchback, dogleg, spiral or escalator.');
    }
    if (o.light !== undefined || o.kind === 'light') {
      const lamp = o.light;
      if (
        o.kind !== 'light' ||
        !object(lamp) ||
        (lamp.mountHeight !== undefined &&
          (!finite(lamp.mountHeight) || lamp.mountHeight < -20 || lamp.mountHeight > 100)) ||
        !finite(lamp.kelvin) ||
        lamp.kelvin < 1000 ||
        lamp.kelvin > 12000 ||
        !finite(lamp.intensity) ||
        lamp.intensity < 0 ||
        lamp.intensity > 10000 ||
        !finite(lamp.range) ||
        lamp.range <= 0 ||
        lamp.range > 100 ||
        (lamp.flicker !== undefined && (!finite(lamp.flicker) || lamp.flicker < 0 || lamp.flicker > 1))
      )
        fail('a light needs a valid colour temperature, intensity, range and optional flicker.');
    }
    if (o.watchedIds && (!Array.isArray(o.watchedIds) || o.watchedIds.some(id => !p.objects.some(x => x.id === id))))
      fail('unknown watched object.');
    if (o.watchedIds && !distinct(o.watchedIds)) fail('watched objects must be listed once each.');
    if (
      o.ceilingHeight !== undefined &&
      (!['room', 'zone'].includes(o.kind as string) || !finite(o.ceilingHeight) || o.ceilingHeight <= 0)
    )
      fail('a space ceiling height must be positive.');
    if (
      o.baseHeight !== undefined &&
      (o.kind !== 'fixture' || !finite(o.baseHeight) || o.baseHeight < 0 || o.baseHeight > 100)
    )
      fail('a raised fixture needs a base height between 0 and 100 m.');
    if (o.water !== undefined) {
      const water = o.water;
      if (
        !['room', 'zone'].includes(o.kind as string) ||
        !o.rings ||
        !object(water) ||
        !finite(water.depth) ||
        water.depth <= 0 ||
        water.depth > 20 ||
        (water.ripple !== undefined && (!finite(water.ripple) || water.ripple < 0 || water.ripple > 0.1))
      )
        fail('water needs an area, a depth up to 20 m and ripples up to 10 cm.');
    }
    if (o.slide !== undefined) {
      const slide = o.slide;
      if (
        o.kind !== 'fixture' ||
        !object(slide) ||
        !finite(slide.radius) ||
        slide.radius <= 0 ||
        !Array.isArray(slide.path) ||
        slide.path.length < 2 ||
        slide.path.length > 100 ||
        !slide.path.every(p => Array.isArray(p) && p.length === 3 && p.every(finite) && (p[2] as number) >= 0)
      )
        fail('a water slide needs a positive radius and a finite path above its floor.');
    }
    if (o.slope !== undefined) {
      const s = o.slope;
      if (
        !object(s) ||
        !Array.isArray(s.axis) ||
        s.axis.length !== 2 ||
        !s.axis.every(point) ||
        !finite(s.high) ||
        !finite(s.low) ||
        distance(s.axis[0] as Point, s.axis[1] as Point) < 0.01 ||
        s.high < s.low
      )
        fail('invalid slope: needs a downhill two-point axis (high >= low) of non-zero length.');
      if (!o.rings) fail('a sloped object must be an area with a footprint.');
    }
    if (o.category !== undefined && !string(o.category)) fail('object category must be a string.');
    if (o.metadata !== undefined && !object(o.metadata)) fail('object metadata must be an object.');
    if (o.barrierId && !finite(o.offset)) fail('missing opening offset.');
    if (o.feedId !== undefined && typeof o.feedId !== 'string') fail('invalid feed binding.');
    if (o.coverageRange !== undefined && (!finite(o.coverageRange) || o.coverageRange <= 0))
      fail('invalid camera range.');
    if (o.coverageAngle !== undefined && (!finite(o.coverageAngle) || o.coverageAngle <= 0 || o.coverageAngle > 360))
      fail('invalid camera angle.');
  }
  for (const d of p.drawings)
    if (
      !string(d.assetId) ||
      !string(d.name) ||
      !point(d.origin) ||
      !finite(d.scale) ||
      d.scale <= 0 ||
      !finite(d.width) ||
      d.width <= 0 ||
      !finite(d.height) ||
      d.height <= 0 ||
      !finite(d.rotation) ||
      !finite(d.opacity) ||
      d.opacity < 0 ||
      d.opacity > 1 ||
      typeof d.visible !== 'boolean' ||
      typeof d.locked !== 'boolean'
    )
      fail('invalid reference drawing.');
  // ——— The spatial ontology. Spaces are the ringed area objects; zones and portals only reference
  // them, so every reference has to resolve or the derived graph would quietly lose edges.
  const spaceIds = new Set(p.objects.filter(o => isSpace(o.kind)).map(o => o.id));
  const kindById = new Map(p.objects.map(o => [o.id, o.kind]));
  const zoneIds = new Set((p.zones ?? []).map(z => z.id));
  for (const z of p.zones ?? []) {
    if (!string(z.name) || !Array.isArray(z.spaceIds)) fail('a zone needs a name and a list of spaces.');
    if (z.spaceIds.some(id => !spaceIds.has(id))) fail('a zone lists a space that is not an area object.');
    if (!distinct(z.spaceIds)) fail('a zone must list each space once — membership is a set.');
    if (z.childZoneIds && z.childZoneIds.some(id => !zoneIds.has(id))) fail('a zone nests a zone that does not exist.');
    if (z.childZoneIds && !distinct(z.childZoneIds)) fail('a zone must nest each child once.');
    if (z.connects !== undefined && !['all', 'adjacent', 'up', 'down'].includes(z.connects))
      fail("a zone's connects must be 'all', 'adjacent', 'up' or 'down'.");
  }
  // Zones nest as a DAG. Cycles are tolerated at read time (ontology.ts guards) but are still a
  // malformed document, and saying so here is cheaper than debugging a zone that contains itself.
  const walking = new Set<string>(),
    settled = new Set<string>();
  const cycles = (id: string): boolean => {
    if (settled.has(id)) return false;
    if (walking.has(id)) return true;
    walking.add(id);
    const found = ((p.zones ?? []).find(z => z.id === id)?.childZoneIds ?? []).some(cycles);
    walking.delete(id);
    settled.add(id);
    return found;
  };
  if ([...zoneIds].some(cycles)) fail('zones cannot contain themselves.');
  for (const portal of p.portals ?? []) {
    if (!spaceIds.has(portal.a) || !spaceIds.has(portal.b))
      fail('a portal must join two areas that exist on the plan.');
    if (portal.a === portal.b) fail('a portal must join two different spaces.');
    // A window is an opening but never a portal — you cannot walk through it. Same list as
    // inference's TRAVERSABLE, inlined so the rules depend on nothing that changes at runtime.
    if (portal.openingId && !['door', 'gate', 'turnstile'].includes(kindById.get(portal.openingId) ?? ''))
      fail("a portal's opening must be a door, gate or turnstile.");
    if (portal.passage !== undefined && !['both', 'a-to-b', 'b-to-a', 'none'].includes(portal.passage))
      fail('invalid portal passage direction.');
    if (portal.attests !== undefined && !['confirmed', 'assumed', 'none'].includes(portal.attests))
      fail('invalid portal attestation.');
  }
  const portalIds = new Set((p.portals ?? []).map(x => x.id));
  for (const g of p.portalGroups ?? []) {
    if (!string(g.name) || !Array.isArray(g.portalIds) || g.portalIds.some(id => !portalIds.has(id)))
      fail('a portal group needs a name and must list portals that exist.');
    if (!distinct(g.portalIds)) fail('a portal group must list each portal once.');
  }
  const error = validateRelationships(p);
  if (error) fail(error);
  validateSpaceBoundaries(p);
  const navError = validateNavigation(p);
  if (navError) fail(navError);
  return p;
}

// ——— The transaction gate.

/** Deep-freeze a document in place and return it. Writes to a frozen document throw (modules run in
 *  strict mode), so an out-of-band mutation — one that dodged `transact` — fails at the assignment
 *  that would have corrupted the document, not three renders later. */
export function freezeProject(project: ProjectDocument): ProjectDocument {
  const walk = (value: unknown) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const inner of Object.values(value)) walk(inner);
    }
  };
  walk(project);
  return project;
}

export type TransactResult = { ok: true; project: ProjectDocument } | { ok: false; error: string };

/** Apply a change atomically: work on a clone, run every rule, and only then hand the result back —
 *  frozen, so nothing can edit it except the next transaction. If the change throws, or the outcome
 *  breaks any rule, the original is untouched and the reason comes back as `error`; there is no
 *  state in which a caller holds a partly-applied or invalid document.
 *
 *  `updatedAt` is deliberately not stamped here — that belongs to whoever owns persistence and
 *  history (see commitHistory), which also stamps undo and redo. */
export function transact(
  project: ProjectDocument,
  change: (draft: ProjectDocument) => void,
  options?: { freeze?: boolean },
): TransactResult {
  try {
    const draft = structuredClone(project); // clones of frozen objects are mutable: drafts stay editable
    change(draft);
    synchronizeGeometry(project, draft);
    // Older imported outlines remain readable. New or resized areas use the same usable-area
    // minimum as enclosure and splitting; changing a name never invalidates a legacy small area.
    for (const o of draft.objects)
      if (isArea(o.kind) && objectArea(o) < MIN_SPACE_AREA) {
        const old = project.objects.find(previous => previous.id === o.id && isArea(previous.kind));
        if (!old || objectArea(old) !== objectArea(o))
          throw new Error(
            `A space needs at least ${MIN_SPACE_AREA} m² of usable area. "${o.name || o.id}" (${o.id}) has ${objectArea(o).toFixed(3)} m².`,
          );
      }
    validateProject(draft);
    return { ok: true, project: options?.freeze === false ? draft : freezeProject(draft) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
