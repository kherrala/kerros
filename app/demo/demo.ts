import { stockmannOffices } from './stockmannOffices';
import { STOCKMANN_ID } from './ids';
import { attachOntology } from './ontology';
import { stockmannGarage } from './stockmannGarage';
import type { ModelKind, ObjectKind, Point, ProjectDocument, Ring, SiteObject } from '@kerros/schema';
import {
  addBarrier,
  addNavEdge,
  addNavNode,
  barrierEnds,
  centroid,
  chainVertical,
  closeRing,
  createObject,
  distance,
  geoOrigin,
  isArea,
  isVertical,
  navPath,
  objectPosition,
  PITCH,
  pointInRing,
  primaryShafts,
  rectangle,
  runFor,
  segmentProjection,
} from '@kerros/schema';

// The reference app's default new project lives in blank.ts, so the picker can offer an empty site
// without loading the campus that happens to share this file. Re-exported here for the tests and
// scripts that have always reached for it at this name.
import { newProject } from './blank';
export { newProject };
export { createObject } from '@kerros/schema';
function poly(
  p: ProjectDocument,
  kind: ObjectKind,
  name: string,
  points: Point[],
  floorId: string | null,
  color?: string,
) {
  const object = createObject(kind, centroid(points), floorId, name);
  const xs = points.map(pt => pt[0]),
    ys = points.map(pt => pt[1]);
  object.width = Math.max(...xs) - Math.min(...xs);
  object.depth = Math.max(...ys) - Math.min(...ys);
  object.rings = [closeRing(points.map(pt => [...pt] as Point))];
  object.color = color;
  p.objects.push(object);
  return object;
}
function attached(
  p: ProjectDocument,
  kind: 'door' | 'gate' | 'window',
  name: string,
  point: Point,
  floorId: string | null,
  width = 1.1,
) {
  const nearest = p.barriers
    .filter(b => b.floorId === floorId && b.kind === (kind === 'gate' ? 'fence' : 'wall'))
    .map(b => ({ b, ...segmentProjection(point, ...barrierEnds(p, b)) }))
    .sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) return;
  const object = createObject(kind, nearest.point, floorId, name);
  object.barrierId = nearest.b.id;
  object.offset = nearest.t * nearest.length;
  object.width = width;
  if (kind !== 'window') object.feedId = `feed-${object.id}`;
  p.objects.push(object);
  return object;
}

const FACADE = (b: { name: string; thickness: number; color?: string }) => {
  b.name = 'Facade wall';
  b.thickness = 0.45;
  b.color = '#a6acb8';
};
function outlineWalls(p: ProjectDocument, f: string, ring: Point[]) {
  const from = p.barriers.length;
  const closed = closeRing(ring);
  for (let i = 1; i < closed.length; i++) addBarrier(p, closed[i - 1], closed[i], f, 'wall');
  p.barriers.slice(from).forEach(FACADE);
}
function partitions(p: ProjectDocument, f: string, segments: [Point, Point][]) {
  const from = p.barriers.length;
  for (const [a, b] of segments) addBarrier(p, a, b, f, 'wall');
  p.barriers
    .slice(from)
    .filter(b => !b.color)
    .forEach(b => {
      b.name = 'Partition';
      b.thickness = 0.18;
      b.color = '#c3c8d0';
    });
}
// Portrait windows in an even rhythm along every facade edge, skipping doors and wall junctions.
/** `bay` is the centre-to-centre spacing of the openings; width/height their proportions. Defaults
 *  suit a domestic façade — a tall civic one states its own. */
function windowsAlong(
  p: ProjectDocument,
  f: string,
  ring: Point[],
  name: string,
  { width = 1.4, height = 0, bay = 3.4 } = {},
) {
  const closed = closeRing(ring);
  for (let i = 1; i < closed.length; i++) {
    const [a, b] = [closed[i - 1], closed[i]];
    const len = distance(a, b);
    if (len < 4.5) continue;
    const count = Math.max(1, Math.floor((len - 2.4) / bay));
    const step = (len - 2.4) / count;
    for (let k = 0; k <= count; k++) {
      const t = 1.2 + k * step;
      const point: Point = [a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len];
      const nearest = p.barriers
        .filter(x => x.floorId === f && x.kind === 'wall')
        .map(x => ({ b: x, ...segmentProjection(point, ...barrierEnds(p, x)) }))
        .sort((x, y) => x.distance - y.distance)[0];
      if (!nearest || nearest.distance > 0.1) continue;
      const offset = nearest.t * nearest.length;
      if (offset < 0.9 || offset > nearest.length - 0.9) continue;
      if (
        p.objects.some(
          o => o.barrierId === nearest.b.id && Math.abs((o.offset ?? 0) - offset) < (o.width + 1.4) / 2 + 0.2,
        )
      )
        continue;
      const window = createObject('window', nearest.point, f, name);
      window.barrierId = nearest.b.id;
      window.offset = offset;
      window.width = width;
      if (height) window.height = height;
      p.objects.push(window);
    }
  }
}
export function createDemo(): ProjectDocument {
  const p = createCampus();
  // Describe the building as well as draw it: vertical cores become zones, doors become portals, so
  // the structure panel and the router have something real to work with.
  attachOntology(p);
  return p;
}

// ——— Stockmann Helsinki: modelled on the real Stockmann department store in central Helsinki. The
// footprint is the actual MML building outline (mtk_id 417563654), so it sits exactly on the
// basemap parcel. Seven retail floors plus a food-hall basement ring a central glass-roofed atrium;
// escalators and lift/stair cores cluster around the void, echoing the store's real layout.
const STK: Point[] = [
  [21.3, -56.7],
  [-15.8, -42.8],
  [-23.8, -34.8],
  [-24.5, -36],
  [-24.5, -34.2],
  [-51.6, 2.5],
  [3.6, 41.9],
  [4.4, 40.7],
  [5.9, 41.7],
  [4.9, 43.2],
  [34.6, 64.6],
  [35.6, 63.1],
  [36.8, 63.9],
  [40.7, 59],
  [42.5, 60.5],
  [57.2, 40.2],
];
// The glass-roofed light well, punched through every floor so the void reads top to bottom.
const ATRIUM: Point[] = [
  [-9, -9],
  [17, -9],
  [17, 17],
  [-9, 17],
];
// Structural columns ringing the atrium (posts on the slab just outside the void).
const PILLARS: Point[] = [
  [-11, -11],
  [4, -11],
  [19, -11],
  [19, 4],
  [19, 19],
  [4, 19],
  [-11, 19],
  [-11, 4],
];
// Two enclosed service cores (lift + stair + WC), walled off with partitions — the interior walls
// that in a department store only really exist around the cores.
const CORE_E: Point[] = [
  [20, -4],
  [31, -4],
  [31, 17],
  [20, 17],
];
const CORE_W: Point[] = [
  [-37, -14],
  [-27, -14],
  [-27, -1],
  [-37, -1],
];
const boxWalls = (r: Point[]): [Point, Point][] => r.map((pt, i) => [pt, r[(i + 1) % r.length]] as [Point, Point]);
// The central escalator spine plus a spiral stair at each end, alongside the atrium.
// name, x, y, rotation, which way it carries you. A bank runs alternate ways so you step off one
// and turn to step onto the next, and the direction is stated rather than read out of the name.
//
// The banks stand clear of the void, not over it. A flight runs along the object's DEPTH axis with a
// comb plate at each end, so the run reaches half its length either side of the position given here —
// standing at y -12 and 20 the inner end of every run, and the landing on it, hung over the atrium on
// each of the floors that punch the void through their plate, and you stepped off into a hole.
const STK_ESCALATORS: [string, number, number, number, 'up' | 'down'][] = [
  ['Escalator up', 6, -15.5, 0, 'up'],
  ['Escalator down', 11, -15.5, 0, 'down'],
  ['Escalator up', 6, 23.5, 0, 'up'],
  ['Escalator down', 11, 23.5, 0, 'down'],
];
/** The flat comb plate at each end of an escalator run, in metres — the length `SceneLayer.flight()`
 *  takes out of the footprint before it lays the steps out, so the incline is `depth - 2 * COMB`. */
const COMB = 1;
// Clear of the escalator bank and sized like the feature stair it is. At 2.2 m across and two
// metres from the escalators' flank, the spirals were a pair of fire-escape ladders crowding the
// spine; a department store's spiral is a 3.6 m drum you can pass someone on, standing on its own.
const STK_SPIRALS: Point[] = [
  [16.5, -11],
  [16.5, 19],
];
const STK_SPIRAL_SIZE = 3.6;
// name, elevation, storey height, colour, ground-floor sub-departments, isOffice
// Two storeys are taller than the rest because each has a mezzanine standing inside it: the ground
// hall carries the entresol gallery half way up it, Herkku the pharmacy gallery. At 4.2 m neither
// host had room for a level anyone could stand up in — the entresol was 1.6 m under a soffit, a
// walker's eye is 2.03 — so the hall is 5.6 m and the food market 4.6 m, and the selling floors
// above start from the hall's own top rather than from a nominal 4.2.
// Every storey shares one brightness: an elevation-graded ladder read as the lower floors being
// badly lit rather than lower, and a visitor stepping between levels expects the same daylight.
// Every level wears a light cool neutral — daylight grey rather than the warm putty these plates
// used to carry, which under a strong sun read as beige and made a whole department store look like
// a model made of cardboard. Offices sit a shade bluer than retail, and basements only a step darker
// so below-grade still reads below-grade.
const STK_FLOORS: [string, string, number, number, string, string[], boolean][] = [
  ['floor-basement', 'Herkku food market', -9, 4.8, '#d2d8de', ['Bakery', 'Deli & sushi', 'Alko'], false],
  [
    'floor-b1',
    'Electronics & services',
    -4.2,
    4.2,
    '#d2d8de',
    ['Power electronics', 'Shoe repair', 'Pet supplies'],
    false,
  ],
  ['floor-ground', 'Beauty & cosmetics', 0, 5.6, '#e1e6ea', ['Fragrances', 'Skincare', 'Watches & jewellery'], false],
  ['floor-01', 'Womenswear', 5.6, 4.2, '#e1e6ea', ['Designer studio', 'Knitwear', 'Lingerie'], false],
  ['floor-02', 'Menswear & denim', 9.8, 4.2, '#e1e6ea', ['Suits', 'Casual', 'Shoes'], false],
  ['floor-03', 'Shoes & accessories', 14, 4.2, '#e1e6ea', ['Handbags', 'Travel', 'Sunglasses'], false],
  ['floor-04', 'Kids & sport', 18.2, 4.2, '#e1e6ea', ['Toys', 'Outdoor', 'Denim junior'], false],
  ['floor-05', 'Home & interior', 22.4, 4.2, '#e1e6ea', ['ISKU Koti', 'Kitchen', 'Textiles'], false],
  [
    'floor-06',
    'Books, toys & café',
    26.6,
    4.2,
    '#e1e6ea',
    ['Academic bookstore', 'Restaurant', 'Crazy Days hall'],
    false,
  ],
  ['floor-07', 'Offices · buying & admin', 30.8, 4.2, '#dfe6ec', [], true],
  ['floor-08', 'Offices · marketing & HR', 35, 4.2, '#dfe6ec', [], true],
  ['floor-09', 'Offices · management & F8 lounge', 39.2, 4.2, '#dfe6ec', [], true],
];
// A floor plate is the footprint with the atrium (and, for offices, the cores) punched out.
/** Push a ring outward from its centre by `metres` — a serviceable buffer for the broadly convex
 *  footprints these demos use, without pulling in a polygon-offset library for one call. */
function outset(ring: Point[], metres: number): Point[] {
  const c = centroid(ring);
  return ring.map(pt => {
    const dx = pt[0] - c[0],
      dy = pt[1] - c[1],
      len = Math.hypot(dx, dy) || 1;
    return [pt[0] + (dx / len) * metres, pt[1] + (dy / len) * metres] as Point;
  });
}
function plate(p: ProjectDocument, kind: 'zone' | 'room', f: string, name: string, holes: Point[][], color: string) {
  const object = createObject(kind, centroid(STK), f, name);
  const xs = STK.map(pt => pt[0]),
    ys = STK.map(pt => pt[1]);
  object.width = Math.max(...xs) - Math.min(...xs);
  object.depth = Math.max(...ys) - Math.min(...ys);
  object.rings = [
    closeRing(STK.map(pt => [...pt] as Point)),
    ...holes.map(h => closeRing(h.map(pt => [...pt] as Point))),
  ];
  object.color = color;
  p.objects.push(object);
  return object;
}
function pillars(p: ProjectDocument, f: string, height: number) {
  for (const [x, y] of PILLARS) {
    const o = createObject('fixture', [x, y], f, 'Column');
    o.model = 'post' as ModelKind;
    o.width = o.depth = 0.8;
    o.height = height;
    o.color = '#c4cad0';
    p.objects.push(o);
  }
}
function core(
  p: ProjectDocument,
  f: string,
  ring: Point[],
  lifts: [string, Point][],
  stair: [string, Point],
  wc: Point,
  all: string[],
) {
  const coreWalls = p.barriers.length;
  partitions(p, f, boxWalls(ring));
  // A core boxed in by four walls and no door is a sealed shaft — the plan describes a stairwell
  // nobody can enter. The authored route graph hid that by wiring the landings together directly.
  const built = p.barriers.slice(coreWalls);
  const longest = built.sort(
    (x, y) => distance(...(barrierEnds(p, y) as [Point, Point])) - distance(...(barrierEnds(p, x) as [Point, Point])),
  )[0];
  if (longest) {
    const [wa, wb] = barrierEnds(p, longest) as [Point, Point];
    const door = createObject('door', [(wa[0] + wb[0]) / 2, (wa[1] + wb[1]) / 2], f, `${stair[0]} core door`);
    door.barrierId = longest.id;
    door.offset = distance(wa, wb) / 2;
    p.objects.push(door);
  }
  // The core walls, door and washroom belong to each storey; the lift and the stair do not. A shaft
  // is ONE object standing in one place and reaching a list of levels — `servedFloorIds` has always
  // said so, and repeating it per storey was a workaround from before anything read that list. Built
  // on the lowest level it serves, which is where its flights count up from.
  if (f === all[0]) {
    lifts.forEach(([name, pt]) => {
      const l = createObject('elevator', pt, f, name);
      l.servedFloorIds = all;
      l.feedId = name.replace(/\s/g, '-').toLowerCase();
      p.objects.push(l);
    });
    const s = createObject('stairs', stair[1], f, stair[0]);
    s.stairModel = 'switchback';
    s.servedFloorIds = all;
    p.objects.push(s);
  }
  const toilet = createObject('fixture', wc, f, 'Washrooms');
  toilet.model = 'toilet' as ModelKind;
  toilet.width = 1.6;
  toilet.depth = 1;
  toilet.height = 1;
  p.objects.push(toilet);
}

/** Where a shaft sets you down. A lift or a stair lands inside its own footprint; an escalator lands
 *  a run away at each end, on the comb plates `SceneLayer.flight()` lays out along the object's DEPTH
 *  axis — and it is those, not the middle of the truss, that need floor under them. */
function landings(o: SiteObject): Point[] {
  if (o.stairModel !== 'escalator') return [o.position];
  const rad = (o.rotation * Math.PI) / 180;
  const reach = o.depth / 2 - Math.min(COMB, o.depth / 4) / 2;
  return [1, -1].map(
    side => [o.position[0] + Math.sin(rad) * reach * side, o.position[1] - Math.cos(rad) * reach * side] as Point,
  );
}
/** Is there floor under this point on that level — inside some area's outline and clear of its holes? */
const standsOn = (p: ProjectDocument, floorId: string, pt: Point) =>
  p.objects.some(
    o =>
      o.floorId === floorId &&
      isArea(o.kind) &&
      o.rings?.length &&
      pointInRing(pt, o.rings[0]) &&
      !o.rings.slice(1).some(hole => pointInRing(pt, hole)),
  );
/** Every shaft reaching this level, as its footprint plus a metre of landing margin. The office
 *  fit-out keeps these clear: a partition drawn across an escalator well is a wall standing in a
 *  hole in the floor, and the door in it opens onto the flight. */
const shaftClearances = (p: ProjectDocument, floorId: string): Ring[] =>
  p.objects
    .filter(o => isVertical(o.kind) && o.servedFloorIds?.includes(floorId))
    .map(o => rectangle(o.position, o.width + 2, o.depth + 2, o.rotation));

function createCampus(): ProjectDocument {
  const p = newProject('Stockmann Helsinki');

  p.id = STOCKMANN_ID;
  p.referenceNote =
    'Office layouts are illustrative: façade-aligned workspaces and circulation, not surveyed Stockmann interiors.';
  p.buildings[0].exteriorPreset = 'darkBrick';
  // The real store is crowned by a steep mansard in dark sheet metal, set back above the cornice with
  // the top storey's arcade beneath it. Each façade edge becomes one roof plane leaning inward from
  // the eave to the flat deck, and a final section closes the deck itself.
  {
    const EAVE = 43.4, // top of floor-09 (39.2 + 4.2)
      PEAK = 48.6,
      SETBACK = 5.4;
    const c = centroid(STK);
    const span = Math.max(...STK.map(pt => Math.hypot(pt[0] - c[0], pt[1] - c[1])));
    const deck = STK.map(
      pt => [c[0] + (pt[0] - c[0]) * (1 - SETBACK / span), c[1] + (pt[1] - c[1]) * (1 - SETBACK / span)] as Point,
    );
    const sections = STK.map((a, i) => {
      const b = STK[(i + 1) % STK.length],
        da = deck[i],
        db = deck[(i + 1) % deck.length];
      return { footprint: closeRing([a, b, db, da]), ridge: [da, db] as [Point, Point], eave: EAVE, peak: PEAK };
    });
    // The deck: eave === peak, so every plane of this section lies flat at the top of the mansard.
    sections.push({ footprint: closeRing(deck), ridge: [deck[0], deck[1]] as [Point, Point], eave: PEAK, peak: PEAK });
    p.buildings[0].roof = { floorId: 'floor-09', color: '#3c4046', sections };
  }
  // Origin is the real footprint centroid as WGS84 lng/lat with the building's own bearing, so the
  // model lands precisely on Stockmann's parcel at Aleksanterinkatu, Helsinki.
  p.origin = geoOrigin([24.9421808, 60.1683719], 123.045);
  p.description = 'Stockmann department store · Helsinki';
  p.floors = STK_FLOORS.map(([id, name, elevation, height]) => ({
    id,
    buildingId: 'building-main',
    name,
    elevation,
    height,
  }));
  // Entresol: the department store's historic intermediate gallery ringing the atrium between the
  // ground hall and Womenswear — a mezzanine level shown in context of the floors around it.
  // It splits its host storey in two: 2.8 m of hall under the gallery slab and 2.8 m of gallery over
  // it, which is the least a level can be and still be one you walk through rather than crouch in.
  p.floors.splice(2, 0, {
    id: 'floor-entresol',
    buildingId: 'building-main',
    name: 'Accessories & café · 1A',
    elevation: 2.8,
    height: 2.8,
    mezzanine: true,
  });
  // The same split under Herkku: 2.4 m of food market below the pharmacy gallery, 2.4 m on it, and
  // its top flush with the electronics floor's slab.
  p.floors.push({
    id: 'floor-b1a',
    buildingId: 'building-main',
    name: 'Pharmacy & wellness · -1A',
    elevation: -6.6,
    height: 2.4,
    mezzanine: true,
  });
  // Level codes follow the store's real signage: three below-ground levels and 1A over the hall.
  const CODES: Record<string, string> = {
    'floor-basement': '-2A',
    'floor-b1a': '-1A',
    'floor-b1': '-1',
    'floor-ground': '1',
    'floor-entresol': '1A',
    'floor-01': '2',
    'floor-02': '3',
    'floor-03': '4',
    'floor-04': '5',
    'floor-05': '6',
    'floor-06': '7',
    'floor-07': '8',
    'floor-08': '9',
    'floor-09': '10',
  };
  for (const f of p.floors) f.code = CODES[f.id];
  const ENT: Point[] = [
    [-16, -16],
    [24, -16],
    [24, 24],
    [-16, 24],
  ];
  const gallery = poly(p, 'zone', 'Entresol gallery', ENT, 'floor-entresol', '#edf1f5');
  gallery.rings!.push(closeRing(ATRIUM.map(pt => [...pt] as Point)));
  poly(
    p,
    'room',
    'Café Entresol',
    [
      [-16, -16],
      [24, -16],
      [24, -9],
      [-16, -9],
    ],
    'floor-entresol',
    '#ead9c0',
  );
  poly(
    p,
    'room',
    'Accessories gallery',
    [
      [-16, -9],
      [-9, -9],
      [-9, 24],
      [-16, 24],
    ],
    'floor-entresol',
    '#e5eae7',
  );
  // The spiral stairs themselves are built once, with the rest of the vertical cores, on the lowest
  // level they serve. There used to be a second pair here — same name, same place, no stair model,
  // three levels — and the two disagreed about everything: the renderer drew the drum from the
  // basement while routing threaded the copy, so a route rode a stair nobody could see.
  // -1A: the pharmacy mezzanine ring with its real tunnel link toward the Academic Bookstore.
  const b1aGallery = poly(p, 'zone', 'Wellness gallery', ENT, 'floor-b1a', '#e0e6ec');
  b1aGallery.rings!.push(closeRing(ATRIUM.map(pt => [...pt] as Point)));
  poly(
    p,
    'room',
    'Pharmacy',
    [
      [-16, -16],
      [24, -16],
      [24, -9],
      [-16, -9],
    ],
    'floor-b1a',
    '#dbe4dc',
  );
  poly(
    p,
    'room',
    'Wellness devices',
    [
      [-16, -9],
      [-9, -9],
      [-9, 24],
      [-16, 24],
    ],
    'floor-b1a',
    '#dde1e6',
  );
  const tunnel = (s: Point, len: number, w: number): Point[] => {
    const d: Point = [-0.571, 0.821],
      q: Point = [0.821, 0.571];
    return [
      [s[0] + q[0] * w, s[1] + q[1] * w],
      [s[0] + d[0] * len + q[0] * w, s[1] + d[1] * len + q[1] * w],
      [s[0] + d[0] * len - q[0] * w, s[1] + d[1] * len - q[1] * w],
      [s[0] - q[0] * w, s[1] - q[1] * w],
    ];
  };
  poly(p, 'zone', 'Tunnel to Academic Bookstore', tunnel([8, 16], 48, 2.6), 'floor-b1a', '#56585e');
  // -1: underground service road entering under Keskuskatu, ending at the loading dock.
  poly(p, 'zone', 'Service tunnel · Keskuskatu', tunnel([-6, 26], 58, 4), 'floor-b1', '#54565c');
  poly(
    p,
    'room',
    'Loading dock',
    [
      [-16, 18],
      [2, 18],
      [2, 30],
      [-16, 30],
    ],
    'floor-b1',
    '#d5dae0',
  );
  const ramp = createObject(
    'poi',
    [-6 - 0.571 * 54, 26 + 0.821 * 54] as Point,
    'floor-b1',
    'Service ramp from Kaivokatu',
  );
  ramp.symbol = 'service';
  p.objects.push(ramp);
  // The site "paper" follows the real building footprint (a downtown block has no separate yard),
  // so the clipped architecture plan and dark-mode veil hug the building instead of a stray rectangle.
  // The parcel has to be bigger than the building standing on it. Drawn tight to the footprint it
  // left no ground outside the doors at all, so an entrance had nothing to open onto — by the plan's
  // own account the street did not exist. A real boundary takes in the pavement out to the kerb.
  poly(p, 'parcel', 'Property boundary', outset(STK, 7), null, '#f3f4f0');
  poly(p, 'building', 'Stockmann', STK, null, '#dadee4');
  const all = p.floors.map(f => f.id);
  for (const [f, dept, elevation, height, color, sub, office] of STK_FLOORS) {
    const level = f === 'floor-basement' ? -2 : f === 'floor-b1' ? -1 : f === 'floor-ground' ? 0 : Number(f.slice(-2));
    // Zone plate carries the atrium hole so the void shows through the selling floors in the stacked
    // view. Only the floors ABOVE the hall, though, because a void has a floor: the light well opens
    // down onto the ground hall the way Stockmann's own does, and the storeys under it are solid.
    // Punched through those too, the atrium was a shaft with nothing at the end of it — from a
    // gallery you looked past the food market, past the building, and onto the parcel polygon, and
    // that flat grey read as a hole in the model rather than as a hole in the building.
    const voids = elevation > 0 ? [ATRIUM] : [];
    plate(p, 'zone', f, dept, voids, color);
    const from = p.barriers.length;
    outlineWalls(p, f, STK);
    p.barriers.slice(from).forEach(b => {
      b.material = 'brick';
      b.color = '#9b705b';
      b.thickness = 0.6;
      // Up to the underside of the slab over it, so the facade is continuous however tall the storey
      // is — a fixed 4.02 left daylight showing through a band round the whole 5.6 m hall.
      b.height = height - 0.18;
    });
    // Enclosed service cores (walls + lift + stair + WC) on every floor.
    core(
      p,
      f,
      CORE_E,
      [
        ['Lift A', [23, 0]],
        ['Lift B', [23, 4]],
        ['Lift C', [28, 8]],
      ],
      ['Stair East', [24, 13]],
      [28, 2],
      all,
    );
    core(p, f, CORE_W, [['Lift D', [-33, -11]]], ['Stair West', [-30, -4]], [-34, -4], all);
    pillars(p, f, height);
    // Central escalator spine and spiral stairs beside the atrium.
    if (f === all[0]) {
      // An escalator climbs at 30°, so the run follows from the rise — and one bank is one machine,
      // built to the tallest climb it makes, which here is the ground hall. The old reading took the
      // difference between the first two entries of the floor LIST, which is an authoring order and
      // not a stack: it answered 4.6 m for a bank whose steepest storey is 5.6, and then the comb
      // plates came out of that run as well, so the spine climbed at 35° where it was sized for 30.
      const stack = p.floors.filter(x => !x.mezzanine).sort((a, b) => a.elevation - b.elevation);
      const storey = Math.max(...stack.slice(1).map((x, i) => x.elevation - stack[i].elevation));
      for (const [name, x, y, r, travel] of STK_ESCALATORS) {
        const s = createObject('stairs', [x, y], f, name);
        s.rotation = r;
        s.stairModel = 'escalator';
        s.travel = travel;
        // Bound to a feed, so the sample host can start and stop it the way it commands a lift.
        s.feedId = `feed-${s.id}`;
        s.depth = Math.max(s.depth, runFor(storey, PITCH.escalator) + 2 * COMB);
        s.servedFloorIds = all;
        p.objects.push(s);
      }
      for (const [i, pt] of STK_SPIRALS.entries()) {
        const s = createObject('stairs', pt, f, `Spiral stair ${i + 1}`);
        s.width = STK_SPIRAL_SIZE;
        s.depth = STK_SPIRAL_SIZE;
        s.stairModel = 'spiral';
        s.servedFloorIds = all;
        p.objects.push(s);
      }
    }
    if (office) stockmannOffices(p, f, STK, ATRIUM, [CORE_E, CORE_W], shaftClearances(p, f));
    else {
      plate(p, 'room', f, dept, [...voids, CORE_E, CORE_W], color);
      sub.forEach((name, i) => {
        const poi = createObject('poi', [-40, i * 7 - 7] as Point, f, name);
        poi.symbol = 'personnel';
        p.objects.push(poi);
      });
    }
    if (level === 0) {
      attached(p, 'door', 'Aleksanterinkatu entrance', [3, -49], f, 2.6);
      attached(p, 'door', 'Corner entrance', [12, -51], f, 2.4);
      attached(p, 'door', 'Keskuskatu entrance', [-33, -21], f, 2.2);
    }
    if (level >= 0) windowsAlong(p, f, STK, 'Stockmann glazing', { width: 1.25, height: 2.95, bay: 2.9 });
  }
  // Which levels each shaft actually reaches. The cores above were handed the whole floor list, which
  // is true of every plate level and false of the two mezzanines: those are galleries ringing the
  // atrium, not floors. Lift C, Lift D, Stair East and Stair West stand outside the ring and the
  // escalators' comb plates land past its edge, so a landing door there would open onto the hall
  // below. Trimmed once, here, where every plate exists to be asked.
  for (const o of p.objects) {
    if (!isVertical(o.kind) || !o.servedFloorIds) continue;
    const feet = landings(o);
    o.servedFloorIds = o.servedFloorIds.filter(id => feet.every(pt => standsOn(p, id, pt)));
  }
  for (const [name, position, symbol] of [
    ['Main entrance', [21.3, -63], 'personnel'],
    ['Goods delivery', [50, 48], 'service'],
    ['Metro concourse', [-40, -30], 'driveway'],
  ] as [string, Point, 'personnel' | 'service' | 'driveway'][]) {
    const poi = createObject('poi', position, null, name);
    poi.symbol = symbol;
    p.objects.push(poi);
  }
  // Three parking decks below the food market, their inter-deck ramps and the driveways that surface
  // at Mannerheimintie and Kaivokatu. Added last so it sees the finished above-ground floor list.
  // Open on the offices: the store's own floors are the point of the demo, and landing on the street
  // level buried a 17-storey building under its own ground floor.
  p.initialFloorId = 'floor-08';
  stockmannGarage(p);
  campusNav(p);
  return p;
}

// Nav graph: a gallery ring just outside the atrium on every level, spurs to the lift/stair/escalator
// cores, a vertical chain per distinct core name, the ground-floor entrances stepping out to the Main
// entrance POI through bound doors, and the retail sub-department POIs strung along a west spine.
function campusNav(p: ProjectDocument) {
  // The ring steps out to each escalator on its way past, because a shaft's route node stands at the
  // object's own position and the banks sit a half-run back from the void. Follow the atrium instead
  // and the nodes the vertical chain hangs off would be adrift on the plate, connected to nothing.
  const [south, north] = [STK_ESCALATORS[0][2], STK_ESCALATORS[2][2]];
  const RING: Point[] = [
    [-12, -12],
    [6, south],
    [11, south],
    [20, -12],
    [20, 0],
    [20, 13],
    [20, 20],
    [11, north],
    [6, north],
    [-12, 20],
    [-12, -11],
    [-12, -12],
  ];
  for (const f of p.floors) {
    navPath(p, f.id, RING);
    navPath(p, f.id, [
      [20, 0],
      [23, 0],
      [23, 4],
      [28, 8],
    ]); // CORE_E lifts A/B/C
    navPath(p, f.id, [
      [20, 13],
      [24, 13],
    ]);
    navPath(p, f.id, [
      [-12, -11],
      [-33, -11],
    ]);
    navPath(p, f.id, [
      [-12, -11],
      [-30, -4],
    ]); // Stair East, Lift D, Stair West
    // Out to the spiral stairs themselves: a spur that stopped three metres short left the drum's
    // route nodes standing alone, so nothing could ever be routed onto the stair.
    navPath(p, f.id, [[11, south], [13, -11], STK_SPIRALS[0]]);
    navPath(p, f.id, [[11, north], [13, 19], STK_SPIRALS[1]]);
    const pois = p.objects.filter(o => o.kind === 'poi' && o.symbol === 'personnel' && o.floorId === f.id);
    if (pois.length) {
      for (const poi of pois) addNavNode(p, f.id, poi.position, poi.id);
      navPath(p, f.id, [[-33, -11], ...pois.map(poi => poi.position)]);
    }
  }
  // One vertical chain per shaft, elected the way the renderer elects one: `primaryShafts` picks the
  // lowest twin of each, so the object routing rides is the object the model draws. Threading by name
  // instead picked whichever copy happened to be first in the list — which chained one of the two
  // escalator banks and, while a second pair of spiral stairs existed, a twin that served three
  // levels where the stair on the plan serves fourteen.
  const primary = primaryShafts(p);
  for (const o of p.objects) if (isVertical(o.kind) && primary.has(o.id)) chainVertical(p, o);
  const outs: Point[] = [];
  for (const [dname, outPt, approach] of [
    [
      'Aleksanterinkatu entrance',
      [3, -53],
      [
        [6, south],
        [3, -30],
      ],
    ],
    [
      'Corner entrance',
      [13, -55],
      [
        [11, south],
        [12, -30],
      ],
    ],
    ['Keskuskatu entrance', [-37, -24], [[-33, -11]]],
  ] as [string, Point, Point[]][]) {
    const door = p.objects.find(o => o.kind === 'door' && o.name === dname && o.floorId === 'floor-ground');
    if (!door) continue;
    const insidePt = objectPosition(p, door),
      inside = addNavNode(p, 'floor-ground', insidePt, door.id),
      outside = addNavNode(p, null, outPt);
    addNavEdge(p, 'door', inside, outside, door.id);
    navPath(p, 'floor-ground', [...approach, insidePt]);
    outs.push(outPt);
  }
  const main = p.objects.find(o => o.name === 'Main entrance');
  if (main) {
    addNavNode(p, null, main.position, main.id);
    navPath(p, null, [...outs, main.position]);
  }
  // The garage mouths surface a hundred metres out under the surrounding streets. They are part of
  // the site's network too — a route to a parked car begins at the kerb, not at a shop door — so
  // each one is walked back to the nearest entrance forecourt along the street it comes out on.
  for (const gate of p.objects)
    if (gate.floorId === null && gate.kind === 'gate' && gate.symbol === 'driveway' && outs.length) {
      const near = outs.reduce((best, pt) => (distance(pt, gate.position) < distance(best, gate.position) ? pt : best));
      const half: Point = [(near[0] + gate.position[0]) / 2, (near[1] + gate.position[1]) / 2];
      navPath(p, null, [near, half, gate.position]);
    }
}
