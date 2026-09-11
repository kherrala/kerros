import type { Floor, Point, ProjectDocument, SiteObject } from '@kerros/schema';
import {
  addBarrier,
  addNavEdge,
  addNavNode,
  centroid,
  chainVertical,
  closeRing,
  createObject,
  navPath,
  pointInRing,
} from '@kerros/schema';

// The below-grade half of the Stockmann demo: three parking decks that sprawl past the tower
// footprint, linked by drivable ramps, with entry/exit driveways surfacing at the surrounding streets.
// The site origin carries the block's bearing, so LOCAL axes are already street-aligned — these unit
// vectors name the real streets around the store.
const EAST: Point = [-0.571, 0.821]; // toward Keskuskatu
const WEST: Point = [0.571, -0.821]; // toward Mannerheimintie
const SOUTH: Point = [0.821, 0.571]; // toward Kaivokatu
const NORTH: Point = [-0.821, -0.571];

export const GARAGE_FLOORS: [id: string, name: string, elevation: number, code: string][] = [
  ['floor-p1', 'Parking P1', -12.6, 'P1'],
  ['floor-p2', 'Parking P2', -16.8, 'P2'],
  ['floor-p3', 'Parking P3', -21, 'P3'],
];
/** The store level the garage cores surface into (Herkku food market, -8.8 m). */
const LOBBY_FLOOR = 'floor-basement';
// Scale of each deck relative to the plan above: each is a little smaller than the one over it,
// because excavation costs money the deeper you go.
const DECK_INSET = [1, 0.9, 0.78];
// A generous plan that reaches well past the tower on every side, so the excavation reads as a vast
// garage under the block rather than a basement under the building.
const DECK: Point[] = [
  [-62, -36],
  [-14, -58],
  [44, -50],
  [64, 2],
  [42, 58],
  [-26, 54],
  [-62, 8],
];
// A double-loaded aisle module: 5 m of bays, a 6.5 m drive lane, 5 m of bays facing back.
const BAY_DEEP = 5,
  BAY_WIDE = 2.5,
  AISLE = 6.5,
  MODULE = BAY_DEEP * 2 + AISLE;
// Enough aisle modules to fill the deck north-to-south; bays that fall outside a deck are dropped, so
// the smaller lower decks simply end up with shorter rows.
const AISLES = [-2 * MODULE, -MODULE, 0, MODULE, 2 * MODULE];
const CONCRETE = '#626873',
  MARKING = '#666c77',
  LANE = '#585e69',
  RAMP_DECK = '#454a53';

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const scale = (v: Point, k: number): Point => [v[0] * k, v[1] * k];
const at = (origin: Point, east: number, south: number): Point =>
  add(add(origin, scale(EAST, east)), scale(SOUTH, south));
const inset = (ring: Point[], k: number): Point[] => {
  const c = centroid(ring);
  return ring.map(p => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k] as Point);
};
/** A rectangular strip `len` long and `2*w` wide running from `from` along `dir`. */
const strip = (from: Point, dir: Point, len: number, w: number): Point[] => {
  const q: Point = [-dir[1], dir[0]];
  const to = add(from, scale(dir, len));
  return [add(from, scale(q, w)), add(to, scale(q, w)), add(to, scale(q, -w)), add(from, scale(q, -w))];
};
/** An east/south aligned rectangle centred on `c`. */
const box = (c: Point, east: number, south: number): Point[] => [
  at(c, -east / 2, -south / 2),
  at(c, east / 2, -south / 2),
  at(c, east / 2, south / 2),
  at(c, -east / 2, south / 2),
];

function area(
  p: ProjectDocument,
  kind: 'zone' | 'room',
  name: string,
  points: Point[],
  floorId: string,
  color: string,
): SiteObject {
  const o = createObject(kind, centroid(points), floorId, name);
  const xs = points.map(pt => pt[0]),
    ys = points.map(pt => pt[1]);
  o.width = Math.max(...xs) - Math.min(...xs);
  o.depth = Math.max(...ys) - Math.min(...ys);
  o.rings = [closeRing(points.map(pt => [...pt] as Point))];
  o.color = color;
  p.objects.push(o);
  return o;
}
/** A drivable sloped deck running downhill from `highEnd` (at `high`) to `lowEnd` (at `low`). The
 *  footprint overhangs both ends by an apron, which stays level because slope elevation clamps. */
function ramp(
  p: ProjectDocument,
  name: string,
  highEnd: Point,
  lowEnd: Point,
  w: number,
  high: number,
  low: number,
  floorId: string,
): SiteObject {
  const len = Math.hypot(lowEnd[0] - highEnd[0], lowEnd[1] - highEnd[1]);
  const dir: Point = [(lowEnd[0] - highEnd[0]) / len, (lowEnd[1] - highEnd[1]) / len];
  const APRON = 3;
  const o = area(p, 'zone', name, strip(add(highEnd, scale(dir, -APRON)), dir, len + APRON * 2, w), floorId, RAMP_DECK);
  o.slope = { axis: [highEnd, lowEnd], high, low };
  o.symbol = 'driveway';
  return o;
}
function fixture(p: ProjectDocument, name: string, position: Point, floorId: string, model: 'car' | 'post', rot = 0) {
  const o = createObject('fixture', position, floorId, name);
  o.model = model;
  o.rotation = rot;
  if (model === 'car') {
    o.width = 4.5;
    o.depth = 1.85;
    o.height = 1.5;
  } else {
    o.width = o.depth = 0.75;
    o.height = 3.2;
  }
  p.objects.push(o);
  return o;
}
/** Bearing of a local direction, in the rotation convention SiteObject.rotation uses. */
const heading = (dir: Point) => (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;

export function stockmannGarage(p: ProjectDocument): void {
  for (const [id, name, elevation, code] of GARAGE_FLOORS)
    p.floors.push({ id, buildingId: 'building-main', name, elevation, height: 3.4, code } satisfies Floor);

  const decks = GARAGE_FLOORS.map(([id, , elevation, code], i) => ({
    id,
    code,
    elevation,
    ring: inset(DECK, DECK_INSET[i]),
  }));
  const coreOf = (ring: Point[]) => at(centroid(ring), -4, -MODULE / 2 - 9);

  for (const deck of decks) {
    const c = centroid(deck.ring);
    // The deck plate — the outline the excavation is unioned from.
    const plate = area(p, 'zone', `Parking deck ${deck.code}`, deck.ring, deck.id, CONCRETE);
    plate.material = 'paving';
    // A low curb around the plate: enough to read as structure without walling off the view down.
    const curbFrom = p.barriers.length;
    const closed = closeRing(deck.ring);
    for (let k = 1; k < closed.length; k++) addBarrier(p, closed[k - 1], closed[k], deck.id, 'wall');
    for (const b of p.barriers.slice(curbFrom)) {
      b.name = 'Deck edge';
      b.thickness = 0.4;
      b.height = 1;
      b.color = '#6a7079';
    }
    // Bays fill the plan wherever they fit, so each deck's layout follows its own (smaller) outline.
    const fits = (bay: Point[]) => bay.every(pt => pointInRing(pt, plate.rings![0]));
    let bayNumber = 0;
    for (const [a, aisle] of AISLES.entries()) {
      // Size the drive lane to the bays that actually fit this deck, so lanes never overhang the plate
      // and the smaller lower decks simply get shorter rows.
      const spans: number[] = [];
      for (const side of [-1, 1])
        for (let e = -56; e <= 56; e += BAY_WIDE)
          if (fits(box(at(c, e, aisle + side * (AISLE / 2 + BAY_DEEP / 2)), BAY_WIDE, BAY_DEEP))) spans.push(e);
      if (!spans.length) continue;
      const lo = Math.min(...spans) - BAY_WIDE,
        hi = Math.max(...spans) + BAY_WIDE;
      const lane = area(
        p,
        'zone',
        `Aisle ${a + 1} · ${deck.code}`,
        box(at(c, (lo + hi) / 2, aisle), hi - lo, AISLE),
        deck.id,
        LANE,
      );
      lane.symbol = 'driveway';
      for (const side of [-1, 1] as const) {
        const bandSouth = aisle + side * (AISLE / 2 + BAY_DEEP / 2);
        const band: SiteObject[] = [];
        for (let e = -56; e <= 56; e += BAY_WIDE) {
          const bay = box(at(c, e, bandSouth), BAY_WIDE, BAY_DEEP);
          if (!fits(bay)) continue;
          bayNumber++;
          const label = `${deck.code}·${String(bayNumber).padStart(3, '0')}`;
          // A handful of bays near the core are accessible or EV, and are marked as such.
          const special = bayNumber % 23 === 0 ? 'ev' : bayNumber % 37 === 0 ? 'accessible' : undefined;
          const stall = area(
            p,
            'zone',
            special === 'ev'
              ? `EV bay ${label}`
              : special === 'accessible'
                ? `Accessible bay ${label}`
                : `Bay ${label}`,
            bay,
            deck.id,
            special === 'ev' ? '#4f7f6a' : special === 'accessible' ? '#4a6a90' : MARKING,
          );
          stall.symbol = 'parking';
          if (special) stall.category = special;
          band.push(stall);
          // Roughly half the bays are taken; cars nose in toward the aisle.
          if ((bayNumber * 7) % 13 < 6)
            fixture(
              p,
              'Parked car',
              at(c, e, bandSouth - side * 0.35),
              deck.id,
              'car',
              heading(side > 0 ? NORTH : SOUTH),
            );
        }
        // One occupancy sensor per band, so the inspector can roll up free spaces per deck.
        if (band.length) {
          const counter = band[Math.floor(band.length / 2)];
          counter.feedId = `bay-band-${deck.id}-${a}-${side > 0 ? 'n' : 's'}`;
        }
      }
    }
    // Structural columns down the middle of each bay band, on a 7.5 m grid.
    for (const aisle of AISLES)
      for (const side of [-1, 1])
        for (let e = -52.5; e <= 52.5; e += 7.5) {
          const post = at(c, e, aisle + side * (AISLE / 2 + BAY_DEEP / 2));
          if (pointInRing(post, plate.rings![0])) fixture(p, 'Column', post, deck.id, 'post');
        }
    // Lift and stair core, with a door onto the deck.
    const core = coreOf(deck.ring);
    const lobby = area(p, 'room', `Garage lobby ${deck.code}`, box(core, 13, 8), deck.id, '#d3d7de');
    lobby.height = 3;
    lobby.feedId = `garage-lobby-${deck.id}`;
    const lift = createObject('elevator', at(core, -3.5, 0), deck.id, 'Garage lift');
    lift.servedFloorIds = [LOBBY_FLOOR, ...GARAGE_FLOORS.map(([id]) => id)];
    lift.feedId = `garage-lift-${deck.id}`;
    p.objects.push(lift);
    const stair = createObject('stairs', at(core, 3.5, 0), deck.id, 'Garage stair');
    stair.rotation = heading(EAST);
    stair.servedFloorIds = [LOBBY_FLOOR, ...GARAGE_FLOORS.map(([id]) => id)];
    p.objects.push(stair);
  }

  // Ramps between decks: alternating runs so a car works its way down rather than dropping through
  // the same slot twice.
  for (let i = 0; i < decks.length - 1; i++) {
    const from = decks[i],
      to = decks[i + 1];
    const dir = i % 2 === 0 ? SOUTH : NORTH;
    const highEnd = at(centroid(from.ring), 40, i % 2 === 0 ? -18 : 18);
    ramp(
      p,
      `Ramp ${from.code} → ${to.code}`,
      highEnd,
      add(highEnd, scale(dir, 36)),
      3.4,
      from.elevation,
      to.elevation,
      from.id,
    );
  }

  // Street connections: cut-and-cover driveways that climb from the top deck all the way out to grade
  // at the surrounding roads. They are long because they have to be — a 12.6 m rise at a drivable
  // gradient needs about a hundred metres of run, which carries them well past the tower footprint and
  // out under the streets. That reach is exactly the case the excavation union exists to cover.
  const top = decks[0];
  const tc = centroid(top.ring);
  for (const [name, dir, out] of [
    ['Entry ramp · Mannerheimintie', WEST, 132],
    ['Exit ramp · Kaivokatu', SOUTH, 128],
  ] as [string, Point, number][])
    ramp(p, name, add(tc, scale(dir, out)), add(tc, scale(dir, 26)), 4, 0, top.elevation, top.id);
  // A flat service link east to the existing Keskuskatu loading dock.
  const link = area(p, 'zone', 'Service link · Keskuskatu', strip(at(tc, 24, 0), EAST, 40, 3.2), top.id, LANE);
  link.symbol = 'service';

  garageNav(p, decks);
}
/** Walking routes through the garage: aisle spines, a cross link to each core, and the vertical
 *  chain up into the store, so the router can take you from a shop floor to your car. */
function garageNav(p: ProjectDocument, decks: { id: string; code: string; ring: Point[] }[]) {
  for (const deck of decks) {
    const c = centroid(deck.ring);
    const plate = p.objects.find(o => o.floorId === deck.id && o.name.startsWith('Parking deck'))!;
    const inside = (pt: Point) => pointInRing(pt, plate.rings![0]);
    const spines: Point[][] = [];
    for (const aisle of AISLES) {
      const line = [at(c, -50, aisle), at(c, -25, aisle), at(c, 0, aisle), at(c, 25, aisle), at(c, 50, aisle)].filter(
        inside,
      );
      if (line.length > 1) spines.push(navPath(p, deck.id, line).map(n => n.position));
    }
    // A cross corridor tying the aisles together and running into the core.
    const cross = AISLES.map(a => at(c, 0, a)).filter(inside);
    if (cross.length > 1) navPath(p, deck.id, cross);
    const core = at(centroid(deck.ring), -4, -MODULE / 2 - 9);
    const lift = p.objects.find(o => o.floorId === deck.id && o.name === 'Garage lift')!;
    const stair = p.objects.find(o => o.floorId === deck.id && o.name === 'Garage stair')!;
    navPath(p, deck.id, [at(c, 0, AISLES[0]), core]);
    addNavEdge(p, 'walk', addNavNode(p, deck.id, core), addNavNode(p, deck.id, lift.position, lift.id), undefined);
    addNavEdge(p, 'walk', addNavNode(p, deck.id, core), addNavNode(p, deck.id, stair.position, stair.id), undefined);
    void spines;
  }
  // The cores also stand on the store's lowest level, so the chain reaches the shop floors.
  const lobbyRing = decks[0].ring;
  const core = at(centroid(lobbyRing), -4, -MODULE / 2 - 9);
  const lobbyLift = createObject('elevator', add(core, scale(EAST, -3.5)), LOBBY_FLOOR, 'Garage lift');
  lobbyLift.servedFloorIds = [LOBBY_FLOOR, ...GARAGE_FLOORS.map(([id]) => id)];
  lobbyLift.feedId = `garage-lift-${LOBBY_FLOOR}`;
  p.objects.push(lobbyLift);
  const lobbyStair = createObject('stairs', add(core, scale(EAST, 3.5)), LOBBY_FLOOR, 'Garage stair');
  lobbyStair.rotation = heading(EAST);
  lobbyStair.servedFloorIds = [LOBBY_FLOOR, ...GARAGE_FLOORS.map(([id]) => id)];
  p.objects.push(lobbyStair);
  // Tie the store-side core into the food market's own walk network.
  navPath(p, LOBBY_FLOOR, [[-12, -11], core]);
  addNavEdge(p, 'walk', addNavNode(p, LOBBY_FLOOR, core), addNavNode(p, LOBBY_FLOOR, lobbyLift.position, lobbyLift.id));
  addNavEdge(
    p,
    'walk',
    addNavNode(p, LOBBY_FLOOR, core),
    addNavNode(p, LOBBY_FLOOR, lobbyStair.position, lobbyStair.id),
  );
  chainVertical(p, lobbyLift);
  chainVertical(p, lobbyStair);
}
