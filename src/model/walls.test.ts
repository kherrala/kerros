import { describe, expect, it } from 'vitest';
import { addBarrier, holdAngle, snapPoint } from './geometry';
import { axisDelta, axisOf, fitOpening, floorOutline, mainAxis, proposeWall, referenceAxis } from './walls';
import { exteriorWalls } from '../map/exteriors';
import { enclosedRegion, enclosedRegions, refitEnclosedRooms } from './spaces';
import { barrierEnds, centroid, closeRing, ringArea } from './geometry';
import { createObject } from './factory';
import { newProject } from './testFixtures';
import type { Point, ProjectDocument, Ring } from './types';
import { uid } from './types';

/** A floor outline, as the top-level zone the app treats as the floor's own footprint. */
const outline = (p: ProjectDocument, ring: Ring, floorId = 'floor-ground') => {
  p.objects.push({
    id: uid(),
    kind: 'zone',
    floorId,
    name: 'Footprint',
    position: [0, 0],
    rotation: 0,
    rings: [ring],
    width: 1,
    depth: 1,
    height: 0,
  });
};
/** A 30 × 20 rectangle turned `degrees` off the site grid, about the origin. */
const turned = (degrees: number): Ring => {
  const rad = (degrees * Math.PI) / 180;
  return (
    [
      [0, 0],
      [30, 0],
      [30, 20],
      [0, 20],
    ] as Point[]
  ).map(([x, y]): Point => [x * Math.cos(rad) - y * Math.sin(rad), x * Math.sin(rad) + y * Math.cos(rad)]);
};

describe('axes', () => {
  it('reads a wall and the same wall reversed as one direction', () => {
    expect(axisOf([0, 0], [10, 10])).toBeCloseTo(45);
    expect(axisOf([10, 10], [0, 0])).toBeCloseTo(45);
  });
  it('measures across the 0/180 wrap the short way', () => {
    expect(axisDelta(179, 1)).toBeCloseTo(2);
    expect(axisDelta(1, 179)).toBeCloseTo(-2);
  });
});

describe('main axis', () => {
  it('follows the building outline, not true north', () => {
    const p = newProject();
    outline(p, turned(31));
    expect(mainAxis(p, 'floor-ground')).toBeCloseTo(31, 4);
  });
  it('averages a ragged outline into the one direction it is really drawn on', () => {
    const p = newProject();
    // The long pair of edges is off by a degree either way; a person would still call this 0°.
    outline(p, [
      [0, 0],
      [40, 0.7],
      [40, 20],
      [0, 19.3],
    ]);
    expect(Math.abs(axisDelta(0, mainAxis(p, 'floor-ground')))).toBeLessThan(1.5);
  });
  it('falls back to the walls already drawn when there is no outline', () => {
    const p = newProject();
    addBarrier(p, [0, 0], [20, 20], 'floor-ground', 'wall');
    expect(mainAxis(p, 'floor-ground')).toBeCloseTo(45);
  });
  it('falls back to the site grid on an empty floor', () => {
    expect(mainAxis(newProject(), 'floor-ground')).toBe(0);
  });
});

describe('reference axis', () => {
  it('prefers the wall being drawn beside over the building average', () => {
    const p = newProject();
    outline(p, turned(0));
    addBarrier(p, [10, 5], [10.5, 15], 'floor-ground', 'wall'); // a deliberately skew partition
    const near = referenceAxis(p, 'floor-ground', [11, 10], 3);
    expect(near.source).toBe('wall');
    expect(near.angle).toBeCloseTo(axisOf([10, 5], [10.5, 15]));
  });
  it('squares to the raked end of a space when that is what you are standing next to', () => {
    const p = newProject();
    // A room with one raked end: its long walls run level, its right-hand end is cut at a slant.
    outline(p, [
      [0, 0],
      [30, 0],
      [24, 20],
      [0, 20],
    ]);
    const raked = referenceAxis(p, 'floor-ground', [26, 10], 5);
    expect(raked.source).toBe('exterior');
    expect(axisDelta(axisOf([30, 0], [24, 20]), raked.angle)).toBeCloseTo(0);
    // Away from it, the long walls the room is really laid out on win instead.
    expect(axisDelta(0, referenceAxis(p, 'floor-ground', [10, 1], 5).angle)).toBeCloseTo(0);
  });
  it('falls back to the building once out of reach of any wall', () => {
    const p = newProject();
    outline(p, turned(31));
    addBarrier(p, [10, 5], [10.5, 15], 'floor-ground', 'wall');
    const far = referenceAxis(p, 'floor-ground', [200, 200], 3);
    expect(far.source).toBe('building');
    expect(far.angle).toBeCloseTo(31, 4);
  });
});

describe('holding an angle', () => {
  it('reproduces the old vertical lock exactly', () => {
    expect(holdAngle([0, 0], [0.3, 5], 0, 0.7)?.point).toEqual([0, 5]);
  });
  it('holds 45° off the reference axis', () => {
    const held = holdAngle([0, 0], [7.2, 6.9], 0, 0.7);
    expect(held?.quarter).toBe(1);
    expect(axisOf([0, 0], held!.point)).toBeCloseTo(45);
  });
  it('holds square to a building that is itself askew', () => {
    // Aiming across a 31° building: 121° is square to it, and nowhere near a site-grid direction.
    const rad = (121.6 * Math.PI) / 180;
    const held = holdAngle([0, 0], [12 * Math.cos(rad), 12 * Math.sin(rad)], 31, 0.7);
    expect(held?.quarter).toBe(2);
    expect(axisOf([0, 0], held!.point)).toBeCloseTo(121);
  });
  it('leaves a deliberately odd angle alone', () => {
    expect(holdAngle([0, 0], [10, 4], 0, 0.7)).toBeNull();
  });
  it('keeps its grip tighter the further the wall runs', () => {
    // Same 3° error: snapped when the wall is short, left free once it is long enough to aim by hand.
    const off = (length: number): Point => [length * Math.cos(0.0524), length * Math.sin(0.0524)];
    expect(holdAngle([0, 0], off(5), 0, 0.7)).not.toBeNull();
    expect(holdAngle([0, 0], off(40), 0, 0.7)).toBeNull();
  });
  it('reaches snapPoint through its axis argument', () => {
    const p = newProject();
    const straight = snapPoint(p, 'floor-ground', [12, 7.4], 0.7, [0, 0], false, 31);
    expect(straight.label).toBe('Parallel');
    expect(axisOf([0, 0], straight.point)).toBeCloseTo(31);
  });
});

describe('proposing a wall', () => {
  /** A bare 30 × 20 room: outline only, no partitions yet. */
  const room = () => {
    const p = newProject();
    outline(p, turned(0));
    return p;
  };
  it('offers a partition square to the building, spanning wall to wall', () => {
    const proposal = proposeWall(room(), 'floor-ground', [12, 9]);
    expect(proposal).not.toBeNull();
    expect(axisDelta(90, proposal!.axis)).toBeCloseTo(0);
    // Square to a 30-wide, 20-deep room means the 20 m direction, landing on both long walls.
    expect(proposal!.segment.map(s => s[0])).toEqual([12, 12]);
    expect([...proposal!.segment.map(s => s[1])].sort((a, b) => a - b)).toEqual([0, 20]);
  });
  it('squares to the building even when the building is askew', () => {
    const p = newProject();
    outline(p, turned(31));
    const rad = (31 * Math.PI) / 180;
    const inside: Point = [12 * Math.cos(rad) - 9 * Math.sin(rad), 12 * Math.sin(rad) + 9 * Math.cos(rad)];
    const proposal = proposeWall(p, 'floor-ground', inside);
    expect(axisDelta(121, proposal!.axis)).toBeCloseTo(0, 4);
  });
  it('offers to cross a partition rather than duplicate it', () => {
    const p = room();
    addBarrier(p, [12, 0], [12, 20], 'floor-ground', 'wall');
    // Standing beside a partition, the useful offer is the wall that crosses it, not a second copy.
    expect(axisDelta(0, proposeWall(p, 'floor-ground', [12.4, 9])!.axis)).toBeCloseTo(0);
  });
  it('says nothing where a wall already runs that way', () => {
    const p = room();
    addBarrier(p, [12, 0], [12, 20], 'floor-ground', 'wall');
    addBarrier(p, [0, 9], [30, 9], 'floor-ground', 'wall');
    // Nearest here is the partition, so the offer would run across it — but that crossing wall
    // already exists a metre away, and this corner of the plan is divided as far as it needs to be.
    expect(proposeWall(p, 'floor-ground', [12.4, 10])).toBeNull();
    expect(proposeWall(p, 'floor-ground', [20, 15])).not.toBeNull(); // open quarter: still worth offering
  });
  it('stops at the partition already there rather than running through it', () => {
    const p = room();
    addBarrier(p, [12, 0], [12, 20], 'floor-ground', 'wall');
    const proposal = proposeWall(p, 'floor-ground', [20, 9]);
    // Nearest wall is now that partition, so the proposal squares to *it* and lands on it at x=12.
    expect(proposal!.segment.map(s => s[0]).sort((a, b) => a - b)).toEqual([12, 30]);
  });
  it('says nothing out in the open, where a wall would have no end', () => {
    expect(proposeWall(room(), 'floor-ground', [200, 200])).toBeNull();
  });
});

describe('fitting an opening', () => {
  it('refuses a segment too short to carry an opening, exactly as validation would', () => {
    // The hover preview and the click that commits must agree: validation refuses openings on
    // sub-metre stubs, so the fit must never offer one.
    const p = newProject();
    addBarrier(p, [0, 0], [0.8, 0], 'floor-ground', 'wall');
    expect(fitOpening(p, 'floor-ground', 'door', [0.4, 0.1], 0.7, 1)).toBeNull();
    addBarrier(p, [0, 5], [1.4, 5], 'floor-ground', 'wall');
    const fit = fitOpening(p, 'floor-ground', 'door', [0.7, 5.1], 0.7, 1);
    expect(fit).not.toBeNull();
    expect(fit!.offset).toBeCloseTo(0.7, 5);
  });
});

// A floor with rooms but no zone over them still has an outline. Imported plans are exactly that,
// and before the union fell in, not one of their walls counted as exterior.
describe('floorOutline on a floor with no zone', () => {
  const roomFloor = () => {
    const p = newProject();
    for (const [name, x] of [
      ['West', 0],
      ['East', 4],
    ] as [string, number][]) {
      const room = createObject('room', [x + 2, 2], 'floor-ground', name);
      room.rings = [
        [
          [x, 0],
          [x + 4, 0],
          [x + 4, 4],
          [x, 4],
        ],
      ];
      p.objects.push(room);
    }
    return p;
  };
  it('takes the union of the rooms, not the empty site footprint', () => {
    const rings = floorOutline(roomFloor(), 'floor-ground');
    expect(rings).toHaveLength(1);
    const xs = rings[0].map(pt => pt[0]);
    // The two rooms merge into one 8 x 4 outline; the shared edge at x=4 is gone.
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(8);
  });
  it('makes the walls on that outline read as exterior', () => {
    const p = roomFloor();
    addBarrier(p, [0, 0], [8, 0], 'floor-ground', 'wall'); // along the outline
    addBarrier(p, [4, 0.5], [4, 3.5], 'floor-ground', 'wall'); // the partition between the rooms
    const exterior = exteriorWalls(p);
    expect(exterior.has(p.barriers[0].id)).toBe(true);
    expect(exterior.has(p.barriers[1].id)).toBe(false);
  });
});

// A room stores its own outline, which is what lets a space exist where no wall does. The cost used
// to be that moving a wall left the room it bounded behind — two things to keep in step by hand.
describe('rooms follow the walls that enclose them', () => {
  const boxed = () => {
    const p = newProject();
    const f = 'floor-ground';
    for (const [a, b] of [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 6],
      ],
      [
        [10, 6],
        [0, 6],
      ],
      [
        [0, 6],
        [0, 0],
      ],
      [
        [5, 0],
        [5, 6],
      ], // the divider we will slide
    ] as [Point, Point][])
      addBarrier(p, a, b, f, 'wall');
    for (const ring of enclosedRegions(p, f)) {
      const room = createObject('room', centroid(ring), f, 'Room');
      room.rings = [closeRing(ring)];
      room.width = 1;
      room.depth = 1;
      p.objects.push(room);
    }
    return p;
  };
  it('re-fits a room whose wall moved, and leaves a drawn one alone', () => {
    const p = boxed();
    expect(p.objects.filter(o => o.kind === 'room')).toHaveLength(2);
    // A freehand area over the same floor, matching no enclosed region.
    const drawn = createObject('zone', [2, 2], 'floor-ground', 'Drawn');
    drawn.rings = [
      [
        [1, 1],
        [3, 1],
        [3, 3],
        [1, 3],
      ],
    ];
    p.objects.push(drawn);
    const before = enclosedRegions(p, 'floor-ground');
    const west = p.objects.find(o => o.kind === 'room' && centroid(o.rings![0])[0] < 5)!;
    const wasWide = Math.max(...west.rings![0].map(q => q[0]));
    // Slide the divider two metres east: both junctions move, so the rooms either side change size.
    for (const j of p.junctions) if (Math.abs(j.position[0] - 5) < 0.01) j.position = [7, j.position[1]];
    expect(refitEnclosedRooms(p, 'floor-ground', before)).toBe(2);
    expect(Math.max(...west.rings![0].map(q => q[0]))).toBeGreaterThan(wasWide + 1.5);
    // The freehand zone is untouched: it was never defined by a wall.
    expect(drawn.rings![0]).toEqual([
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ]);
  });
  it('re-fits when a wall thickens, which eats into the rooms beside it', () => {
    const p = boxed();
    const before = enclosedRegions(p, 'floor-ground');
    const west = p.objects.find(o => o.kind === 'room' && centroid(o.rings![0])[0] < 5)!;
    const wasWide = Math.max(...west.rings![0].map(q => q[0]));
    const divider = p.barriers.find(b => barrierEnds(p, b).every(e => Math.abs(e[0] - 5) < 0.01))!;
    divider.thickness = 1;
    expect(refitEnclosedRooms(p, 'floor-ground', before)).toBe(2);
    expect(Math.max(...west.rings![0].map(q => q[0]))).toBeLessThan(wasWide - 0.3);
  });
  it('reads the region under a point, and nothing outside the walls', () => {
    const p = boxed();
    const west = enclosedRegion(p, 'floor-ground', [2, 3]);
    const east = enclosedRegion(p, 'floor-ground', [8, 3]);
    expect(west && Math.abs(ringArea(west))).toBeGreaterThan(20);
    expect(east && Math.abs(ringArea(east))).toBeGreaterThan(20);
    // Two different rooms, not the same one twice.
    expect(centroid(west!)[0]).toBeLessThan(centroid(east!)[0]);
    // Outside the building encloses nothing, however near the wall the click lands.
    expect(enclosedRegion(p, 'floor-ground', [-3, 3])).toBeNull();
    expect(enclosedRegion(p, 'floor-ground', [5, 9])).toBeNull();
  });
  it('declines to re-fit when one region is claimed by two rooms', () => {
    // Removing the divider leaves ONE region where there were two, and both rooms would grow to
    // fill it — two rooms drawn over each other. Refusing keeps the plan honest and leaves the
    // question (merge them? keep both?) to whoever deleted the wall.
    const p = boxed();
    const before = enclosedRegions(p, 'floor-ground');
    const shapes = p.objects.filter(o => o.kind === 'room').map(o => JSON.stringify(o.rings));
    const divider = p.barriers.find(b => barrierEnds(p, b).every(e => Math.abs(e[0] - 5) < 0.01))!;
    p.barriers = p.barriers.filter(b => b.id !== divider.id);
    expect(refitEnclosedRooms(p, 'floor-ground', before)).toBe(0);
    expect(p.objects.filter(o => o.kind === 'room').map(o => JSON.stringify(o.rings))).toEqual(shapes);
  });
});
