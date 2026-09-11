import { describe, expect, it } from 'vitest';
import {
  addPortalGroup,
  addZone,
  captive,
  entryInto,
  nestZone,
  perimeter,
  pruneOntology,
  removePortalGroup,
  removeZone,
  setPortalGroupMembers,
  setZoneMembers,
  zoneSpaces,
} from './ontology';
import { findRoute } from './navigation';
import { validateProject } from './validate';
import { addFloor, addPortal as portal, addSpace as space, addTestZone as zone, newProject } from './testFixtures';
import { rectangle, removeFloor } from './geometry';
import { uid, type Point, type ProjectDocument, type Zone } from './types';

describe('direction is asked, not stored', () => {
  it('reads both ways through an open portal', () => {
    const p = portal(newProject(), 'lobby', 'office');
    expect(entryInto(p, 'office')).toBe('a-to-b');
    expect(entryInto(p, 'lobby')).toBe('b-to-a');
  });
  it('refuses the wrong way through a one-way portal', () => {
    const fire = portal(newProject(), 'stair', 'street', { passage: 'a-to-b' });
    expect(entryInto(fire, 'street')).toBe('a-to-b'); // out is fine
    expect(entryInto(fire, 'stair')).toBeNull(); // in is not
  });
  it('lets nobody through a sealed portal', () => {
    const sealed = portal(newProject(), 'a', 'b', { passage: 'none' });
    expect([entryInto(sealed, 'a'), entryInto(sealed, 'b')]).toEqual([null, null]);
  });
});

describe('zones', () => {
  const nested = () => {
    const p = newProject();
    space(p, 'vault', 'floor-ground', [0, 0]);
    space(p, 'strongroom', 'floor-ground', [6, 0]);
    space(p, 'lobby', 'floor-ground', [12, 0]);
    const inner = zone(p, 'Vault', ['vault', 'strongroom']);
    const outer = zone(p, 'Secure floor', ['lobby'], { childZoneIds: [inner.id] });
    return { p, inner, outer };
  };
  it('gathers spaces through nested zones', () => {
    const { p, outer } = nested();
    expect(zoneSpaces(p, outer).sort()).toEqual(['lobby', 'strongroom', 'vault']);
  });
  it('survives a cycle rather than hanging', () => {
    const { p, inner, outer } = nested();
    inner.childZoneIds = [outer.id]; // a bug in the document, not a reason to spin forever
    expect(zoneSpaces(p, outer).sort()).toEqual(['lobby', 'strongroom', 'vault']);
  });
  it('separates perimeter from captive portals', () => {
    const { p, inner } = nested();
    const inside = portal(p, 'vault', 'strongroom'); // wholly within the zone
    const boundary = portal(p, 'strongroom', 'lobby'); // one side in, one side out
    expect(perimeter(p, inner).map(x => x.id)).toEqual([boundary.id]);
    expect(captive(p, inner).map(x => x.id)).toEqual([inside.id]);
  });
});

describe('authoring zones', () => {
  const withSpaces = () => {
    const p = newProject();
    space(p, 'a', 'floor-ground', [0, 0]);
    space(p, 'b', 'floor-ground', [8, 0]);
    space(p, 'reader-1', 'floor-ground', [4, 4], 'reader');
    p.objects.find(o => o.id === 'reader-1')!.rings = undefined;
    return p;
  };
  it('keeps the spaces out of a selection and drops the rest', () => {
    const p = withSpaces();
    const z = addZone(p, 'Suite', ['a', 'b', 'reader-1', 'ghost']);
    expect(z.spaceIds.sort()).toEqual(['a', 'b']);
    expect(() => validateProject(p)).not.toThrow();
  });
  it('adds and removes members without minding repeats', () => {
    const p = withSpaces();
    const z = addZone(p, 'Suite', ['a']);
    setZoneMembers(p, z.id, ['a', 'b'], true);
    setZoneMembers(p, z.id, ['b'], true); // again: still a set
    expect(z.spaceIds.sort()).toEqual(['a', 'b']);
    setZoneMembers(p, z.id, ['b', 'never-there'], false);
    expect(z.spaceIds).toEqual(['a']);
  });
  it('takes a nested zone with it when the parent is deleted', () => {
    const p = withSpaces();
    const inner = addZone(p, 'Inner', ['a']);
    const outer = addZone(p, 'Outer', ['b']);
    expect(nestZone(p, outer.id, inner.id)).toBe(true);
    removeZone(p, inner.id);
    expect(outer.childZoneIds).toEqual([]);
    expect(() => validateProject(p), 'no dangling child reference').not.toThrow();
  });
  it('refuses a nesting that would make a cycle', () => {
    const p = withSpaces();
    const one = addZone(p, 'One', ['a']);
    const two = addZone(p, 'Two', ['b']);
    expect(nestZone(p, one.id, two.id)).toBe(true);
    expect(nestZone(p, two.id, one.id), 'two already contains one').toBe(false);
    expect(nestZone(p, one.id, one.id), 'nor itself').toBe(false);
    expect(() => validateProject(p)).not.toThrow();
  });
});

describe('authoring portal groups', () => {
  const withPortals = () => {
    const p = newProject();
    space(p, 'a', 'floor-ground', [0, 0]);
    space(p, 'b', 'floor-ground', [8, 0]);
    space(p, 'c', 'floor-ground', [16, 0]);
    return { p, one: portal(p, 'a', 'b'), two: portal(p, 'b', 'c') };
  };
  it('keeps the portals out of a selection and drops the rest', () => {
    const { p, one } = withPortals();
    const g = addPortalGroup(p, 'Shutters', [one.id, 'ghost']);
    expect(g.portalIds).toEqual([one.id]);
    expect(() => validateProject(p)).not.toThrow();
  });
  it('adds and removes members without minding repeats', () => {
    const { p, one, two } = withPortals();
    const g = addPortalGroup(p, 'Shutters', [one.id]);
    setPortalGroupMembers(p, g.id, [one.id, two.id], true);
    setPortalGroupMembers(p, g.id, [two.id], true); // again: still a set
    expect(g.portalIds.sort()).toEqual([one.id, two.id].sort());
    setPortalGroupMembers(p, g.id, [two.id, 'never-there'], false);
    expect(g.portalIds).toEqual([one.id]);
  });
  it('removes a group cleanly', () => {
    const { p, one } = withPortals();
    const g = addPortalGroup(p, 'Shutters', [one.id]);
    removePortalGroup(p, g.id);
    expect(p.portalGroups).toEqual([]);
    expect(() => validateProject(p)).not.toThrow();
  });
});

describe('the document rejects a malformed ontology', () => {
  const withSpaces = () => {
    const p = newProject();
    space(p, 'a', 'floor-ground', [0, 0]);
    space(p, 'b', 'floor-ground', [8, 0]);
    return p;
  };
  const refuses = (build: (p: ProjectDocument) => void, because: RegExp) => {
    const p = withSpaces();
    build(p);
    expect(() => validateProject(p)).toThrow(because);
  };
  it('accepts a well-formed one', () => {
    const p = withSpaces();
    portal(p, 'a', 'b');
    zone(p, 'Suite', ['a', 'b']);
    expect(() => validateProject(p)).not.toThrow();
  });
  it('refuses a portal onto a space that is not an area', () => {
    refuses(p => portal(p, 'a', 'nowhere'), /two areas that exist/);
  });
  it('refuses a portal joining a space to itself', () => {
    refuses(p => portal(p, 'a', 'a'), /two different spaces/);
  });
  it('refuses a zone that contains itself', () => {
    refuses(p => {
      const z = zone(p, 'Loop', ['a']);
      z.childZoneIds = [z.id];
    }, /cannot contain themselves/);
  });
  it('refuses a zone listing something with no footprint', () => {
    refuses(p => {
      space(p, 'reader-1', 'floor-ground', [2, 2], 'reader');
      p.objects.find(o => o.id === 'reader-1')!.rings = undefined;
      zone(p, 'Bad', ['reader-1']);
    }, /not an area object/);
  });
  it('refuses a portal group listing a portal that does not exist', () => {
    refuses(p => {
      (p.portalGroups ??= []).push({ id: uid(), name: 'Shutters', portalIds: ['ghost'] });
    }, /portals that exist/);
  });
  it('refuses an invalid passage direction', () => {
    refuses(p => portal(p, 'a', 'b', { passage: 'sideways' as never }), /passage direction/);
  });
});

// Northwharf House — the worked example in docs/guide/ontology.md, built exactly as documented so
// the manual cannot quietly drift away from what the code does.
describe('the manual’s worked example', () => {
  const northwharf = () => {
    const p = newProject();
    const first = addFloor(p, 'floor-1', 4);
    for (const [id, floorId, at] of [
      ['street', null, [0, -20]],
      ['yard', null, [0, 20]],
      ['lobby', 'floor-ground', [0, 0]],
      ['cafe', 'floor-ground', [8, 0]],
      ['car-g', 'floor-ground', [-8, 0]],
      ['open-plan-1', first, [0, 0]],
      ['server-room', first, [10, 0]],
      ['car-1', first, [-8, 0]],
    ] as [string, string | null, Point][])
      space(p, id, floorId as string, at, id.startsWith('car-') ? 'elevator' : 'room');
    for (const [id, at] of [
      ['turnstile-1', [0, -10]],
      ['door-server', [5, 0]],
      ['door-fire', [0, 10]],
    ] as [string, Point][])
      space(p, id, 'floor-ground', at, 'door');
    space(p, 'door-lift-1', first, [-4, 0], 'door'); // the lift landing door on the first floor
    const server = zone(p, 'Server room', ['server-room']);
    const finance = zone(p, 'Finance', ['open-plan-1'], { childZoneIds: [server.id] });
    zone(p, 'Lift A', ['car-g', 'car-1'], { connects: 'all' });
    portal(p, 'street', 'lobby', { openingId: 'turnstile-1' });
    const serverDoor = portal(p, 'open-plan-1', 'server-room', { openingId: 'door-server' });
    portal(p, 'lobby', 'yard', { openingId: 'door-fire', passage: 'a-to-b' });
    portal(p, 'lobby', 'cafe'); // an open boundary: no door in it at all
    portal(p, 'car-1', 'open-plan-1', { openingId: 'door-lift-1', attests: 'none' });
    return { p, finance, server, serverDoor };
  };
  it('gathers a nested zone upwards, as the manual claims', () => {
    const { p, finance } = northwharf();
    expect(zoneSpaces(p, finance).sort()).toEqual(['open-plan-1', 'server-room']);
  });
  it('returns exactly the one door that controls the server room', () => {
    const { p, server, serverDoor } = northwharf();
    expect(perimeter(p, server).map(x => x.id)).toEqual([serverDoor.id]);
  });
  it('lets you out of the fire exit and never back in', () => {
    const { p } = northwharf();
    const fire = p.portals!.find(x => x.openingId === 'door-fire')!;
    expect(entryInto(fire, 'yard')).toBe('a-to-b');
    expect(entryInto(fire, 'lobby')).toBeNull();
  });
  it('treats the open boundary to the café as a real connection', () => {
    const { p } = northwharf();
    expect(findRoute(p, 'street', 'cafe')).not.toBeNull();
  });
  it('reaches the first floor by lift, with no vertical portal authored', () => {
    const { p } = northwharf();
    expect(p.portals!.every(x => x.a !== 'car-g' || x.b !== 'car-1')).toBe(true);
    expect(findRoute(p, 'car-g', 'open-plan-1')).not.toBeNull();
  });
  it('is a valid document', () => {
    expect(() => validateProject(northwharf().p)).not.toThrow();
  });
});

describe('deleting things the ontology points at', () => {
  const wired = () => {
    const p = newProject();
    space(p, 'a', 'floor-ground', [0, 0]);
    space(p, 'b', 'floor-ground', [8, 0]);
    const door = space(p, 'door-1', 'floor-ground', [4, 0], 'door');
    const through = portal(p, 'a', 'b', { openingId: door });
    const open = portal(p, 'a', 'b');
    const zone = addZone(p, 'Suite', ['a', 'b']);
    (p.portalGroups ??= []).push({ id: uid(), name: 'Doors', portalIds: [through.id] });
    return { p, through, open, zone };
  };
  it('is valid to begin with', () => {
    const { p } = wired();
    expect(() => validateProject(p)).not.toThrow();
  });
  it('takes the portal with the door it went through', () => {
    const { p, open } = wired();
    p.objects = p.objects.filter(o => o.id !== 'door-1');
    pruneOntology(p);
    expect(p.portals!.map(x => x.id)).toEqual([open.id]); // the doorway goes; the open edge stays
    expect(p.portalGroups![0].portalIds, 'and the group forgets it').toEqual([]);
    expect(() => validateProject(p)).not.toThrow();
  });
  it('drops a space from its zone and from every portal that reached it', () => {
    const { p, zone } = wired();
    p.objects = p.objects.filter(o => o.id !== 'b');
    pruneOntology(p);
    expect(zone.spaceIds).toEqual(['a']);
    expect(p.portals).toEqual([]);
    expect(() => validateProject(p)).not.toThrow();
  });
  it('cascades through removeFloor as well', () => {
    const { p } = wired();
    p.floors.push({ id: 'floor-1', buildingId: p.buildings[0].id, name: 'One', elevation: 4, height: 3 });
    removeFloor(p, 'floor-ground');
    expect(p.portals).toEqual([]);
    expect(p.zones![0].spaceIds).toEqual([]);
    expect(() => validateProject(p)).not.toThrow();
  });
});

// A portal stores both of its sides and settles direction only when asked. A host that needs a
// record per direction of travel derives one; this is that projection, kept as a test so the
// schema stays sufficient for it. What the host does with those records is its own business.
describe('projecting a zone perimeter into directional crossings', () => {
  interface AccessPoint {
    token: string;
    door: string;
    areaFrom?: string;
    areaTo?: string;
    attested: boolean;
  }
  function accessPoints(project: ProjectDocument, zone: Zone): AccessPoint[] {
    const inside = new Set(zoneSpaces(project, zone));
    return perimeter(project, zone).flatMap(portal => {
      if (!portal.openingId) return []; // an open boundary is a gap to close, not an access point
      const [inSide, outSide] = inside.has(portal.a) ? [portal.a, portal.b] : [portal.b, portal.a];
      const attested = portal.attests === 'confirmed';
      const points: AccessPoint[] = [];
      if (entryInto(portal, inSide) !== null)
        points.push({ token: `${portal.id}:in`, door: portal.openingId, areaTo: zone.id, attested });
      if (entryInto(portal, outSide) !== null)
        points.push({ token: `${portal.id}:out`, door: portal.openingId, areaFrom: zone.id, attested });
      return points;
    });
  }
  /** A lobby zone with a monitored two-way turnstile, a one-way fire exit, and an open boundary. */
  const site = () => {
    const p = newProject();
    space(p, 'street', null as unknown as string, [0, -10]);
    space(p, 'yard', null as unknown as string, [0, 10]);
    space(p, 'lobby', 'floor-ground', [0, 0]);
    space(p, 'cafe', 'floor-ground', [8, 0]);
    space(p, 'turnstile-1', 'floor-ground', [0, -4], 'turnstile');
    space(p, 'door-fire', 'floor-ground', [0, 4], 'door');
    const front = portal(p, 'street', 'lobby', { openingId: 'turnstile-1', attests: 'confirmed' });
    const fire = portal(p, 'lobby', 'yard', { openingId: 'door-fire', passage: 'a-to-b' });
    portal(p, 'lobby', 'cafe'); // an open boundary on the very same perimeter
    const lobbyZone = addZone(p, 'Lobby', ['lobby'], 'controlled');
    return { p, front, fire, lobbyZone };
  };
  it('gives a two-way doorway two directional access points', () => {
    const { p, front, lobbyZone } = site();
    const points = accessPoints(p, lobbyZone);
    const inward = points.find(x => x.token === `${front.id}:in`)!;
    const outward = points.find(x => x.token === `${front.id}:out`)!;
    expect(inward).toMatchObject({ door: 'turnstile-1', areaTo: lobbyZone.id, attested: true });
    expect(outward).toMatchObject({ door: 'turnstile-1', areaFrom: lobbyZone.id, attested: true });
  });
  it('gives a fire exit exactly one, outbound', () => {
    const { p, fire, lobbyZone } = site();
    const points = accessPoints(p, lobbyZone).filter(x => x.token.startsWith(fire.id));
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ token: `${fire.id}:out`, areaFrom: lobbyZone.id });
  });
  it('refuses an open boundary rather than minting an unwatchable access point', () => {
    const { p, lobbyZone } = site();
    // The boundary to the café is on the perimeter, but has no leaf to control. Its absence from
    // the projection is the audit finding, not an oversight.
    expect(perimeter(p, lobbyZone).some(x => !x.openingId)).toBe(true);
    expect(accessPoints(p, lobbyZone)).toHaveLength(3); // turnstile in + out, fire exit out
  });
  it('marks unattested crossings so occupancy can ignore them', () => {
    const { p, fire, lobbyZone } = site();
    const out = accessPoints(p, lobbyZone).find(x => x.token === `${fire.id}:out`)!;
    expect(out.attested).toBe(false); // nothing watches the fire door; a grant is not a passage
  });
  it('is a valid document', () => {
    expect(() => validateProject(site().p)).not.toThrow();
  });
});

// The patterns guide tells hosts that an operable partition — the airwall between two meeting rooms
// — is one portal whose `passage` they toggle. That is a claim about routing, so it is tested here
// rather than asserted in prose.
describe('an operable partition is a portal you open and close', () => {
  const rooms = () => {
    const p = newProject();
    p.objects = [];
    p.barriers = [];
    p.junctions = [];
    space(p, 'meeting-3', 'floor-ground', [0, 0]);
    space(p, 'meeting-4', 'floor-ground', [6, 0]);
    p.objects.find(o => o.id === 'meeting-3')!.rings = [rectangle([0, 0], 6, 6)];
    p.objects.find(o => o.id === 'meeting-4')!.rings = [rectangle([6, 0], 6, 6)];
    return { p, airwall: portal(p, 'meeting-3', 'meeting-4') };
  };
  it('folded back, the two rooms are one bookable space', () => {
    const { p } = rooms();
    expect(findRoute(p, 'meeting-3', 'meeting-4')).not.toBeNull();
  });
  it('closed, they are two', () => {
    const { p, airwall } = rooms();
    airwall.passage = 'none';
    expect(findRoute(p, 'meeting-3', 'meeting-4')).toBeNull();
  });
  it('and the zone boundary follows it either way', () => {
    const { p, airwall } = rooms();
    const suite = addZone(p, 'Meeting 3', ['meeting-3']);
    expect(perimeter(p, suite), 'open: the airwall bounds the zone').toHaveLength(1);
    airwall.passage = 'none';
    expect(perimeter(p, suite), 'closed: still the boundary, simply shut').toHaveLength(1);
    expect(entryInto(airwall, 'meeting-3'), 'but nothing may cross it').toBeNull();
  });
});
