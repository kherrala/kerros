import type { Point, ProjectDocument, SiteObject } from '@kerros/schema';
import { SILO_ID } from './ids';
import { addNavEdge, addNavNode, chainVertical, closeRing, createObject, geoOrigin, navPath } from '@kerros/schema';
import { newProject } from './demo';
import { attachOntology } from './ontology';

// The Silo: a fictional, fully below-ground hundred-level cylinder buried beneath Ympyrätalo in
// Hakaniemi, Helsinki — a nod to dystopian silo fiction. A central shaft with a great spiral
// staircase runs the full depth; each level hangs off it via a landing bridge, with a ring
// walkway and wedge-shaped rooms around the rim. Every floor is underground, so the map renders
// the soil treatment on all of them.
// R and SHAFT follow Ympyrätalo's real footprint measured from the MML z14 vector tile
// (mtk 416821460: outer wall r≈37.9 m, courtyard r≈20.8 m; courtyard pavilion r≈15 m).
const R = 37.5,
  SHAFT = 14.5,
  WALK = 3.2,
  LEVELS = 100,
  STOREY = 7;
const circle = (r: number, steps = 36): Point[] =>
  Array.from(
    { length: steps },
    (_, i) => [r * Math.cos((2 * Math.PI * i) / steps), r * Math.sin((2 * Math.PI * i) / steps)] as Point,
  );
const wedge = (r1: number, r2: number, a1: number, a2: number): Point[] => {
  const arc = (r: number, from: number, to: number) => {
    const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 12));
    return Array.from({ length: steps + 1 }, (_, i) => {
      const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
      return [r * Math.cos(a), r * Math.sin(a)] as Point;
    });
  };
  return [...arc(r1, a1, a2), ...arc(r2, a2, a1)];
};

// Themed bands from the book's world: up-top civic levels, mid farms and homes, deep machinery.
const BAND = (level: number) => (level <= 20 ? 'up' : level <= 65 ? 'mids' : 'deep');
const WEDGE_NAMES: Record<string, string[]> = {
  up: ['Apartments', 'School', 'Clinic', 'Commons'],
  mids: ['Dirt farm', 'Hydroponics', 'Apartments', 'Bazaar'],
  deep: ['Workshops', 'Supply depot', 'Apartments', 'Pump hall'],
};
const WEDGE_TONES: Record<string, string[]> = {
  up: ['#c9d3e4', '#c4dcc8', '#e0d4b8', '#d4cce4'],
  mids: ['#bcd8b0', '#b4d2c4', '#c9d3e4', '#e0cfa8'],
  deep: ['#d0c5b0', '#bfc7d4', '#c9d3e4', '#b8c2b4'],
};
const SPECIALS: Record<number, [string, string]> = {
  1: ['Cafeteria & airlock', '#e8dfca'],
  10: ['Sheriff & holding', '#dcd7e2'],
  34: ['IT & servers', '#ccd7e2'],
  50: ['Supply central', '#e0d8c6'],
  99: ['Down deep mess hall', '#e3dcc9'],
  100: ['Mechanical · generators', '#cfd2ce'],
};

export function createSilo(): ProjectDocument {
  const p = newProject('The Silo');
  p.id = SILO_ID;
  // Buried beneath Ympyrätalo (the round house) at Hakaniemi — the surface basemap shows the
  // real building footprint directly above the shaft.
  p.origin = geoOrigin([24.948866, 60.180343]);
  p.description = 'Ympyrätalo & underground silo · Hakaniemi, Helsinki';
  p.datum = 'Street level at Ympyrätalo = 0 m';
  p.referenceNote =
    'The ten above-ground storeys follow the real Ympyrätalo (nine occupied + building services; interior layouts approximate). The hundred-level silo below is fiction.';
  p.buildings[0].name = 'Ympyrätalo & the Silo';
  p.floors = Array.from({ length: LEVELS }, (_, i) => {
    const level = i + 1;
    return {
      id: `silo-${String(level).padStart(3, '0')}`,
      buildingId: 'building-main',
      name:
        SPECIALS[level]?.[0] ??
        `Level ${level} · ${BAND(level) === 'up' ? 'Up top' : BAND(level) === 'mids' ? 'The mids' : 'Down deep'}`,
      elevation: -STOREY * level,
      height: 5.2,
      code: `L${level}`,
    };
  });
  const poly = (
    kind: 'zone' | 'room',
    name: string,
    ring: Point[],
    floorId: string,
    color: string,
    holes: Point[][] = [],
  ) => {
    const o = createObject(kind, [0, 0], floorId, name);
    const xs = ring.map(pt => pt[0]),
      ys = ring.map(pt => pt[1]);
    o.position = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    o.width = Math.max(...xs) - Math.min(...xs);
    o.depth = Math.max(...ys) - Math.min(...ys);
    o.rings = [
      closeRing(ring.map(pt => [...pt] as Point)),
      ...holes.map(h => closeRing(h.map(pt => [...pt] as Point))),
    ];
    o.color = color;
    p.objects.push(o);
    return o;
  };
  // The parcel is the silo's own circle: the plan paper hugs the shaft, not the city block.
  const parcel = poly('zone', 'Silo perimeter', circle(R + 7), p.floors[0].id, '#e8e6df');
  parcel.kind = 'parcel';
  parcel.floorId = null;
  const allFloors = p.floors.map(f => f.id);
  for (const [i, f] of p.floors.entries()) {
    const level = i + 1,
      band = BAND(level),
      bridgeAngle = (level * 137.5) % 360;
    // Concrete plate with the open shaft at its heart; the void stacks the full hundred levels.
    poly('zone', f.name, circle(R), f.id, SPECIALS[level]?.[1] ?? '#e5e2da', [circle(SHAFT)]);
    // Ring walkway around the shaft and the landing bridge out to the rim rooms.
    poly('room', 'Ring walkway', circle(SHAFT + WALK), f.id, '#efece4', [circle(SHAFT)]);
    const rad = (bridgeAngle * Math.PI) / 180,
      ux = Math.cos(rad),
      uy = Math.sin(rad),
      px = -uy,
      py = ux;
    const inner = SHAFT + WALK;
    poly(
      'room',
      'Landing bridge',
      [
        [inner * ux + px * 1.1, inner * uy + py * 1.1],
        [(R - 1) * ux + px * 1.1, (R - 1) * uy + py * 1.1],
        [(R - 1) * ux - px * 1.1, (R - 1) * uy - py * 1.1],
        [inner * ux - px * 1.1, inner * uy - py * 1.1],
      ],
      f.id,
      '#ddd6c8',
    );
    // Four wedge rooms fill the rim, rotated with the bridge so every level reads differently.
    const wedges: [SiteObject, Point][] = [];
    for (let w = 0; w < 4; w++) {
      const a1 = bridgeAngle + 14 + w * 86,
        a2 = a1 + 74,
        mid = ((a1 + 37) * Math.PI) / 180,
        rr = SHAFT + WALK + 8;
      const room = poly(
        'room',
        `${WEDGE_NAMES[band][w]} ${level}`,
        wedge(SHAFT + WALK + 0.4, R - 0.6, a1, a2),
        f.id,
        WEDGE_TONES[band][w],
      );
      wedges.push([room, [rr * Math.cos(mid), rr * Math.sin(mid)]]);
    }
    // The great spiral staircase — one continuous stair serving all hundred levels.
    const stair = createObject('stairs', [0, 0], f.id, 'The Great Staircase');
    stair.width = 4.4;
    stair.depth = 4.4;
    stair.servedFloorIds = allFloors;
    p.objects.push(stair);
    // Nav: a ring walkway loop starting on the bridge axis, the landing bridge out to the rim, a spur
    // into the shaft (welded to the staircase node) and each wedge room bound to a node off the bridge.
    const RW = SHAFT + WALK / 2,
      ringPts = Array.from({ length: 12 }, (_, k) => {
        const a = ((bridgeAngle + k * 30) * Math.PI) / 180;
        return [RW * Math.cos(a), RW * Math.sin(a)] as Point;
      });
    navPath(p, f.id, [...ringPts, ringPts[0]]);
    const bo: Point = [(R - 2) * ux, (R - 2) * uy];
    navPath(p, f.id, [ringPts[0], bo]);
    navPath(p, f.id, [ringPts[0], [0, 0]]);
    for (const [room, mp] of wedges) {
      addNavNode(p, f.id, mp, room.id);
      navPath(p, f.id, [bo, mp]);
    }
  }
  // A feed binding on a sample of the living levels: what publishes under it — a headcount, a
  // booking system, a sensor — is the host's business, and the demo supplies no feed at all.
  for (const o of p.objects)
    if (o.kind === 'room' && o.name.startsWith('Apartments') && Number(o.name.split(' ').at(-1)) % 7 === 1)
      o.feedId = `occ-${o.id.slice(-8)}`;
  const gate = createObject('door', [0, R - 2], p.floors[0].id, 'Airlock');
  gate.feedId = 'silo-airlock';
  p.objects.push(gate);
  // One vertical chain through the Great Staircase across all hundred levels, and the L1 airlock as a
  // bound destination welded to the shaft node so a route from any level narrates one long descent.
  chainVertical(p, p.objects.find(o => o.kind === 'stairs' && o.name === 'The Great Staircase')!);
  addNavNode(p, p.floors[0].id, gate.position, gate.id);
  navPath(p, p.floors[0].id, [gate.position, [0, 0]]);
  // ——— The real Ympyrätalo above: ten storeys (nine occupied + a building-services top floor per
  // the city record) on the measured ring footprint, courtyard open through every level. Interiors
  // are approximations; the tower connects to the silo through the airlock descent.
  const COURT = 20.8,
    TOWER_STOREY = 3.4;
  const UNIT_TONES = ['#dfe5ef', '#e3efe0', '#efe7d6', '#e6e0ef', '#efe0dc', '#e0ecec'];
  const towerIds: string[] = [];
  const towerIdsAll = Array.from({ length: 10 }, (_, k) => `ymp-${String(k + 1).padStart(2, '0')}`);
  const TOWER: [string, string[]][] = [
    ['Shops & arcade', ['Arcade shops', 'Café Ympyrä', 'Grocery', 'Pharmacy', 'Bank hall', 'Kiosk & lotto']],
    ['Shops & services', ['Fashion', 'Optician', 'Hair & beauty', 'Travel agency', 'Post', 'Photo studio']],
    ...Array.from({ length: 7 }, (_, k): [string, string[]] => [
      `Offices · level ${k + 3}`,
      ['Suite A', 'Suite B', 'Suite C', 'Suite D', 'Suite E', 'Suite F'].map(u => `${u}${k + 3}`),
    ]),
    [
      'Building services',
      ['Ventilation', 'Heat exchange', 'Lift machinery', 'Sprinkler room', 'Telecom', 'Roof access'],
    ],
  ];
  TOWER.forEach(([name, units], ti) => {
    const fid = `ymp-${String(ti + 1).padStart(2, '0')}`;
    towerIds.push(fid);
    p.floors.push({
      id: fid,
      buildingId: 'building-main',
      name,
      elevation: ti * TOWER_STOREY,
      height: ti === 9 ? 3 : TOWER_STOREY - 0.4,
      code: String(ti + 1),
    });
    poly('zone', name, circle(R), fid, ti < 2 ? '#eef0ea' : ti === 9 ? '#e3e5e2' : '#e9ecef', [circle(COURT)]);
    poly('room', 'Courtyard gallery', circle(COURT + 2.6), fid, '#f1efe8', [circle(COURT)]);
    const RG = COURT + 1.3,
      ringPts = Array.from({ length: 12 }, (_, k) => {
        const a = (k * 30 * Math.PI) / 180;
        return [RG * Math.cos(a), RG * Math.sin(a)] as Point;
      });
    navPath(p, fid, [...ringPts, ringPts[0]]);
    units.forEach((u, w) => {
      const a1 = w * 60 + 8,
        mid = ((a1 + 22) * Math.PI) / 180,
        room = poly('room', u, wedge(COURT + 3, R - 0.6, a1, a1 + 44), fid, UNIT_TONES[w]);
      room.feedId = `occ-${room.id.slice(-8)}`;
      const mp: Point = [(COURT + 9) * Math.cos(mid), (COURT + 9) * Math.sin(mid)];
      addNavNode(p, fid, mp, room.id);
      navPath(p, fid, [ringPts[Math.round(((a1 + 22) % 360) / 30) % 12], mp]);
    });
    for (const [nm, ang] of [
      ['Ympyrä lift east', 98],
      ['Ympyrä lift west', 278],
      ['Ympyrä stair', 8],
    ] as [string, number][]) {
      const a = (ang * Math.PI) / 180,
        pos: Point = [(COURT + 1.7) * Math.cos(a), (COURT + 1.7) * Math.sin(a)];
      const core = createObject(nm.includes('stair') ? 'stairs' : 'elevator', pos, fid, nm);
      core.servedFloorIds = towerIdsAll;
      if (core.kind === 'elevator') core.feedId = `${nm.replace(/\s/g, '-')}-${fid}`;
      p.objects.push(core);
      navPath(p, fid, [ringPts[Math.round(ang / 30) % 12], pos]);
    }
  });
  for (const nm of ['Ympyrä lift east', 'Ympyrä lift west', 'Ympyrä stair'])
    chainVertical(p, p.objects.find(o => o.name === nm)!);
  // Ground connections: street doors out to Hakaniemi, and the airlock descent down into the silo.
  const doors = createObject('door', [(R - 2) * Math.cos(-0.6), (R - 2) * Math.sin(-0.6)], 'ymp-01', 'Street doors');
  doors.feedId = 'ymp-doors';
  p.objects.push(doors);
  const inside = addNavNode(p, 'ymp-01', doors.position, doors.id);
  navPath(p, 'ymp-01', [[COURT + 1.3, 0], doors.position]);
  const streetPoi = createObject(
    'poi',
    [(R + 9) * Math.cos(-0.6), (R + 9) * Math.sin(-0.6)] as Point,
    null,
    'Street level · Hakaniemi',
  );
  streetPoi.symbol = 'personnel';
  p.objects.push(streetPoi);
  const outside = addNavNode(p, null, streetPoi.position, streetPoi.id);
  addNavEdge(p, 'door', inside, outside, doors.id);
  const descent = createObject('stairs', [0, R - 6], 'ymp-01', 'Airlock descent');
  descent.servedFloorIds = ['ymp-01', p.floors[0].id];
  p.objects.push(descent);
  navPath(p, 'ymp-01', [
    [0, COURT + 1.3],
    [0, R - 6],
  ]);
  chainVertical(p, descent);
  navPath(p, p.floors[0].id, [
    [0, R - 6],
    [0, R - 2],
  ]);
  // Describe the tower as well as draw it, so the structure panel has something to browse here too:
  // the staircase and lift cores become zones, and the portals are read off the plan.
  attachOntology(p);
  return p;
}
