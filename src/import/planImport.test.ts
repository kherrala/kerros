import { describe, expect, it } from 'vitest';
import { bridgeDoorways, importPlanEntities, type PlanEntity } from './planImport';
import {
  addBarrier,
  enclosedRegions,
  flights,
  primaryShafts,
  servedFloors,
  validateProject,
  type Point,
} from '../schema';
import { newProject } from '../model/testFixtures';

// A synthetic two-room house in the prefab-CAD idiom the importer understands: the envelope drawn
// as silhouette + inner face (0.4 m apart), a partition as a face pair (0.1 m), a doorway gap in
// each with a door symbol standing nearby, one window symbol cluster, and two room labels.
const HOUSE: PlanEntity[] = [
  // Envelope silhouette — continuous.
  { type: 'LINE', layer: '12_ULKOPINTA', a: [0, 0], b: [10, 0] },
  { type: 'LINE', layer: '12_ULKOPINTA', a: [10, 0], b: [10, 8] },
  { type: 'LINE', layer: '12_ULKOPINTA', a: [10, 8], b: [0, 8] },
  { type: 'LINE', layer: '12_ULKOPINTA', a: [0, 8], b: [0, 0] },
  // Envelope inner face — broken by the 1 m entrance on the south side.
  { type: 'LINE', layer: '13_SISÄPINTA', a: [0.4, 0.4], b: [4.5, 0.4] },
  { type: 'LINE', layer: '13_SISÄPINTA', a: [5.5, 0.4], b: [9.6, 0.4] },
  { type: 'LINE', layer: '13_SISÄPINTA', a: [9.6, 0.4], b: [9.6, 7.6] },
  // North inner face breaks at the window opening, exactly as real drawings do.
  { type: 'LINE', layer: '13_SISÄPINTA', a: [9.6, 7.6], b: [5.6, 7.6] },
  { type: 'LINE', layer: '13_SISÄPINTA', a: [4.4, 7.6], b: [0.4, 7.6] },
  { type: 'LINE', layer: '13_SISÄPINTA', a: [0.4, 7.6], b: [0.4, 0.4] },
  // Partition at x = 6: both faces on the outline layer, with a 2 m doorway.
  { type: 'LINE', layer: '196_SIS_EI-K_SEINÄ_ÄÄRIVII', a: [5.95, 0.4], b: [5.95, 3.1] },
  { type: 'LINE', layer: '196_SIS_EI-K_SEINÄ_ÄÄRIVII', a: [5.95, 5.1], b: [5.95, 7.6] },
  { type: 'LINE', layer: '196_SIS_EI-K_SEINÄ_ÄÄRIVII', a: [6.05, 0.4], b: [6.05, 3.1] },
  { type: 'LINE', layer: '196_SIS_EI-K_SEINÄ_ÄÄRIVII', a: [6.05, 5.1], b: [6.05, 7.6] },
  // Door symbols: a leaf near each doorway gap.
  { type: 'LINE', layer: '27_OVET', a: [4.6, 0.6], b: [5.4, 0.6] },
  { type: 'ARC', layer: '27_OVET', center: [6.2, 3.4], r: 0.8, start: 0, end: 90 },
  // A window cluster on the north wall.
  { type: 'LINE', layer: '26_IKKUNAT', a: [4.4, 7.7], b: [5.6, 7.7] },
  { type: 'LINE', layer: '26_IKKUNAT', a: [4.4, 7.9], b: [5.6, 7.9] },
  // Room labels — and one bare area figure that must be ignored.
  { type: 'TEXT', layer: '55_HUONETUNNUKSET', at: [3, 4], text: 'OLOHUONE' },
  { type: 'TEXT', layer: '55_HUONETUNNUKSET', at: [8, 4], text: 'MH' },
  { type: 'TEXT', layer: '55_HUONETUNNUKSET', at: [3, 3.5], text: '20.5' },
];

describe('deterministic plan import', () => {
  const imported = () => {
    const p = newProject();
    const report = importPlanEntities(p, structuredClone(HOUSE), { floorId: 'floor-ground' });
    return { p, report };
  };
  it('builds the walls, rooms and openings the drawing describes', () => {
    const { report } = imported();
    expect(report.walls).toBe(5); // 4 envelope + 1 partition
    expect(report.rooms).toBe(2);
    expect(report.doors).toBe(2);
    expect(report.windows).toBe(1);
    expect(report.named).toBe(2);
  });
  it('stands its walls at the height of the storey it imports onto', () => {
    const p = newProject();
    // A basement is the case that shows: 3.5 m walls on a 2.6 m storey rise above ground level.
    p.floors = [{ id: 'floor-ground', buildingId: p.buildings[0].id, name: 'Cellar', elevation: -2.6, height: 2.6 }];
    importPlanEntities(p, structuredClone(HOUSE), { floorId: 'floor-ground' });
    expect(p.barriers.length).toBeGreaterThan(0);
    expect(p.barriers.every(b => b.height === 2.6)).toBe(true);
  });
  it('produces a valid document — the import obeys every schema rule', () => {
    const { p } = imported();
    expect(() => validateProject(structuredClone(p))).not.toThrow();
  });
  it('names each room after the label standing in it, ignoring area figures', () => {
    const { p } = imported();
    const names = p.objects
      .filter(o => o.kind === 'room')
      .map(o => o.name)
      .sort();
    expect(names).toEqual(['MH', 'OLOHUONE']);
  });
  it('binds the openings to their walls', () => {
    const { p } = imported();
    const doors = p.objects.filter(o => o.kind === 'door');
    const windows = p.objects.filter(o => o.kind === 'window');
    expect(doors).toHaveLength(2);
    expect(doors.every(d => d.barrierId && d.offset !== undefined)).toBe(true);
    expect(windows).toHaveLength(1);
    expect(windows[0].barrierId).toBeDefined();
  });
  it('reads the doorways back as portals, so the rooms are connected', () => {
    const { p } = imported();
    // refreshPortals ran inside the import; the partition doorway joins the two rooms.
    const rooms = new Set(p.objects.filter(o => o.kind === 'room').map(o => o.id));
    expect((p.portals ?? []).some(x => rooms.has(x.a) && rooms.has(x.b))).toBe(true);
  });
  it('retracts one end of a staggered junction instead of leaving sub-minimum wall debris', () => {
    // Two partitions meet the central wall from opposite sides only 0.3 m apart — a staggered
    // junction. An end landing on the wall's centreline welds a junction that splits it, so
    // welding BOTH would leave a 0.3 m piece the document refuses; one end must retract to the
    // wall's face instead.
    const entities: PlanEntity[] = [
      ...HOUSE,
      { type: 'LINE', layer: '196_SIS_EI-K_SEINÄ_ÄÄRIVII', a: [0.4, 1.95], b: [5.95, 1.95] },
      { type: 'LINE', layer: '196_SIS_EI-K_SEINÄ_ÄÄRIVII', a: [0.4, 2.05], b: [5.95, 2.05] },
      { type: 'LINE', layer: '196_SIS_EI-K_SEINÄ_ÄÄRIVII', a: [6.05, 2.25], b: [9.6, 2.25] },
      { type: 'LINE', layer: '196_SIS_EI-K_SEINÄ_ÄÄRIVII', a: [6.05, 2.35], b: [9.6, 2.35] },
    ];
    const p = newProject();
    const report = importPlanEntities(p, structuredClone(entities), { floorId: 'floor-ground' });
    expect(() => validateProject(structuredClone(p))).not.toThrow();
    const at = (id: string) => p.junctions.find(j => j.id === id)!.position;
    for (const b of p.barriers) {
      const [a, z] = [at(b.startId), at(b.endId)];
      expect(Math.hypot(z[0] - a[0], z[1] - a[1])).toBeGreaterThanOrEqual(0.5);
    }
    expect(report.rooms).toBe(4);
    // The central wall was split by the surviving weld — its doorway still found a piece to sit in.
    expect(report.doors).toBe(2);
  });
  it('turns a symbol-less partition gap into an open passage, not a sealed wall', () => {
    const p = newProject();
    // Strip the partition's door swing: the gap remains with nothing standing in it — a doorless
    // opening. Sealing it with a continuous barrier would wall off two rooms the drawing says
    // flow into each other; the barrier must split around it instead.
    const entities = HOUSE.filter(e => !(e.layer === '27_OVET' && e.type === 'ARC'));
    const report = importPlanEntities(p, structuredClone(entities), { floorId: 'floor-ground' });
    expect(report.passages).toBe(1);
    expect(report.doors).toBe(1); // the entrance keeps its leaf
    expect(p.barriers.filter(b => b.name === 'Partition')).toHaveLength(2);
    // The rooms connect through the open boundary, read back as a portal.
    const rooms = new Set(p.objects.filter(o => o.kind === 'room').map(o => o.id));
    expect((p.portals ?? []).some(x => rooms.has(x.a) && rooms.has(x.b))).toBe(true);
  });
});

// Some offices draw a wall as four lines — sheathing, both sides of the stud frame, inner lining —
// rather than two. Nearest-partner pairing then reads two thin walls standing inside each other.
describe('walls drawn with more than two face lines', () => {
  // A 6 x 4 m box whose every wall is drawn as FOUR parallel lines 0.30 m apart: the outer pair on
  // the exterior-face layer, the inner pair on the interior-face one. Nearest-partner pairing reads
  // that as two 0.25 m walls standing inside each other.
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => ({
    type: 'LINE' as const,
    layer,
    a: [x1, y1] as Point,
    b: [x2, y2] as Point,
  });
  const OUT = '12_ULKOPINTA',
    IN = '13_SISAPINTA';
  const FOUR_LINE: PlanEntity[] = [
    line(OUT, 0, 0, 6, 0),
    line(OUT, 0, 0.05, 6, 0.05),
    line(IN, 0, 0.25, 6, 0.25),
    line(IN, 0, 0.3, 6, 0.3),
    line(OUT, 0, 4, 6, 4),
    line(OUT, 0, 3.95, 6, 3.95),
    line(IN, 0, 3.75, 6, 3.75),
    line(IN, 0, 3.7, 6, 3.7),
    line(OUT, 0, 0, 0, 4),
    line(OUT, 0.05, 0, 0.05, 4),
    line(IN, 0.25, 0, 0.25, 4),
    line(IN, 0.3, 0, 0.3, 4),
    line(OUT, 6, 0, 6, 4),
    line(OUT, 5.95, 0, 5.95, 4),
    line(IN, 5.75, 0, 5.75, 4),
    line(IN, 5.7, 0, 5.7, 4),
    { type: 'TEXT', layer: '55_HUONETUNNUKSET', at: [3, 2], text: 'VAR' },
  ];
  it('reads one wall per side, spanning the outermost faces', () => {
    const p = newProject();
    const report = importPlanEntities(p, structuredClone(FOUR_LINE), { floorId: 'floor-ground' });
    expect(report.walls).toBe(4);
    // 0 -> 0.30 is the full wall, not the 0.20 m between the inner pair.
    expect(p.barriers.every(b => Math.abs(b.thickness - 0.3) < 0.02)).toBe(true);
    expect(() => validateProject(structuredClone(p))).not.toThrow();
  });
});

describe('an oblique doorway the Manhattan pass cannot see', () => {
  // A box with a partition that stops short of the south wall, leaving a loose end, and the
  // envelope corner it should reach across. The gap between them is the doorway.
  const cutCorner = () => {
    const p = newProject();
    const f = 'floor-ground';
    for (const [a, b] of [
      // The south wall is drawn in two runs, so there is a junction at [7, 0] for the doorway to
      // reach — which is what an envelope corner or a wall end gives you on a real plan.
      [
        [0, 0],
        [7, 0],
      ],
      [
        [7, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 8],
      ],
      [
        [10, 8],
        [0, 8],
      ],
      [
        [0, 8],
        [0, 0],
      ],
      // The partition, stopping short of the south wall: a loose end at [6, 1.4].
      [
        [6, 8],
        [6, 1.4],
      ],
    ] as [Point, Point][])
      addBarrier(p, a, b, f, 'wall');
    for (const b of p.barriers) b.thickness = 0.12;
    return p;
  };
  // Door symbols strung along the line from the partition's loose end to the south-east corner.
  const doorPts = (from: Point, to: Point): Point[] =>
    [0.02, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.98].map(t => [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
    ]);
  const obliques = (p: ReturnType<typeof cutCorner>) =>
    p.barriers.filter(b => {
      const a = p.junctions.find(j => j.id === b.startId)!.position,
        c = p.junctions.find(j => j.id === b.endId)!.position;
      return Math.abs(a[0] - c[0]) > 0.05 && Math.abs(a[1] - c[1]) > 0.05;
    });
  const report = () => ({ walls: 0, stairs: 0, rooms: 0, doors: 0, windows: 0, passages: 0, named: 0, skipped: [] });

  it('bridges the gap a door is drawn across, and closes the room', () => {
    const p = cutCorner();
    const was = enclosedRegions(p, 'floor-ground').length;
    bridgeDoorways(p, 'floor-ground', doorPts([6, 1.4], [7, 0]), report());
    const built = obliques(p);
    expect(built, 'the doorway the drawing shows a door in').toHaveLength(1);
    // …carrying the door, which is the whole reason it could be found at all.
    expect(p.objects.filter(o => o.barrierId === built[0].id && o.kind === 'door')).toHaveLength(1);
    // …and it closed something, which is the only reason it is worth drawing.
    expect(enclosedRegions(p, 'floor-ground').length).toBeGreaterThan(was);
    expect(() => validateProject(p)).not.toThrow();
  });
  it('bridges nothing when the drawing shows no door there', () => {
    // The same gap with no door symbols is just a gap. Inventing a wall across it would be the
    // importer drawing something the plan does not.
    const p = cutCorner();
    bridgeDoorways(p, 'floor-ground', [], report());
    expect(obliques(p)).toHaveLength(0);
  });
  it('leaves an axis-aligned gap alone', () => {
    // A break in a straight wall is the Manhattan pass\'s own business — a doorway it already found,
    // or a passage it meant to leave open. Bridging it again would seal what the drawing opened.
    const p = cutCorner();
    bridgeDoorways(p, 'floor-ground', doorPts([6, 1.4], [6, 0]), report());
    expect(obliques(p)).toHaveLength(0);
  });
});

describe('windows are read from their jambs', () => {
  // A bank of three casements as Vertex draws them: a small block at each jamb, the glass between
  // left empty, and a 100 mm mullion between neighbours. The gap INSIDE a window is seven times the
  // gap between two of them, so no clustering by gap size can tell them apart — and clustering by a
  // gap wide enough to separate the windows splits each one down its own middle instead.
  const bank: PlanEntity[] = [
    ...HOUSE.filter(e => e.layer !== '26_IKKUNAT'),
    ...[
      [2.0, 2.05, 2.75, 2.8],
      [2.9, 2.95, 3.65, 3.7],
      [3.8, 3.85, 4.55, 4.6],
    ].flatMap(([a, b, c, d]) => [
      { type: 'LINE' as const, layer: '26_IKKUNAT', a: [a, 7.7] as Point, b: [b, 7.7] as Point },
      { type: 'LINE' as const, layer: '26_IKKUNAT', a: [c, 7.7] as Point, b: [d, 7.7] as Point },
      // The sill, spanning the whole opening — the stroke whose sampling used to fill the glass in.
      { type: 'LINE' as const, layer: '26_IKKUNAT', a: [a, 7.85] as Point, b: [d, 7.85] as Point },
    ]),
  ];
  it('reads three windows where three are drawn, not one and not none', () => {
    const p = newProject();
    const report = importPlanEntities(p, structuredClone(bank), { floorId: 'floor-ground' });
    expect(report.windows).toBe(3);
    const widths = p.objects
      .filter(o => o.kind === 'window')
      .map(o => o.width)
      .sort();
    // Each is its own opening, about 0.8 m — not one 2.6 m hole, and not nothing at all.
    for (const w of widths) expect(w).toBeGreaterThan(0.6);
    for (const w of widths) expect(w).toBeLessThan(1);
  });
});

describe('stairs are read off the drawing', () => {
  // Treads: parallel lines across the run, which is how a plan draws a flight.
  const withStair = (x0: number): PlanEntity[] => [
    ...HOUSE,
    ...Array.from({ length: 8 }, (_, i) => ({
      type: 'LINE' as const,
      layer: '82_PORTAAT',
      a: [x0, 2 + i * 0.26] as Point,
      b: [x0 + 1.1, 2 + i * 0.26] as Point,
    })),
  ];
  it('places a flight where the treads are, serving the floor it is drawn on', () => {
    const p = newProject();
    const report = importPlanEntities(p, structuredClone(withStair(2)), { floorId: 'floor-ground' });
    expect(report.stairs).toBe(1);
    const [stair] = p.objects.filter(o => o.kind === 'stairs');
    expect(stair).toBeTruthy();
    expect(stair.position[0]).toBeCloseTo(2.55, 1);
    // A sheet knows only its own storey; what the stair connects is read across the sheets later.
    expect(stair.servedFloorIds).toEqual(['floor-ground']);
    expect(() => validateProject(p)).not.toThrow();
  });
  it('gives a floor with no stair drawn on it no stair', () => {
    const p = newProject();
    const report = importPlanEntities(p, structuredClone(HOUSE), { floorId: 'floor-ground' });
    expect(report.stairs).toBe(0);
    expect(p.objects.filter(o => o.kind === 'stairs')).toHaveLength(0);
  });
  it('reads one shaft from the same stair drawn on two storeys', () => {
    // What importing a real set of sheets does: the same flight, once per floor it appears on. Read
    // together they are one stair connecting both, which is what servedFloors answers.
    const p = newProject();
    p.floors.push({ id: 'floor-1', buildingId: 'building-main', name: 'First', elevation: 3, height: 3 });
    importPlanEntities(p, structuredClone(withStair(2)), { floorId: 'floor-ground' });
    importPlanEntities(p, structuredClone(withStair(2)), { floorId: 'floor-1' });
    const stairs = p.objects.filter(o => o.kind === 'stairs');
    expect(stairs).toHaveLength(2);
    expect(servedFloors(p, stairs[0]).map(f => f.id)).toEqual(['floor-ground', 'floor-1']);
    expect(flights(p, stairs[0])).toHaveLength(1);
    // One of them draws; the other is the same stair seen again.
    expect([...primaryShafts(p)].filter(id => stairs.some(s => s.id === id))).toHaveLength(1);
  });
});
