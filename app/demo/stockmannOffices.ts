import polygonClipping from 'polygon-clipping';
import type { Point, ProjectDocument, Ring, SiteObject } from '@kerros/schema';
import {
  MIN_SEGMENT,
  barrierEnds,
  centroid,
  closeRing,
  distance,
  openRing,
  pointInRing,
  rectangle,
  ringArea,
  rotate,
  segmentProjection,
  spaceAt,
  uid,
} from '@kerros/schema';

type MultiPolygon = Point[][][];
// polygon-clipping occasionally dies on near-degenerate slivers ("Unable to complete output
// ring"); snapping the operands to a coarser grid and retrying resolves the ambiguity.
const snap = (shape: MultiPolygon, digits: number): MultiPolygon =>
  shape.map(poly =>
    poly.map(ring => ring.map(p => [Number(p[0].toFixed(digits)), Number(p[1].toFixed(digits))] as Point)),
  );
function clip(op: 'intersection' | 'difference', a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  for (const digits of [9, 6, 4]) {
    try {
      return polygonClipping[op](snap(a, digits), snap(b, digits)) as MultiPolygon;
    } catch {
      /* retry on a coarser grid */
    }
  }
  return op === 'difference' ? a : [];
}
// Differences along the wing strips leave zero-width darts that retrace an edge; the validator
// rejects those rings as self-crossing. Drop spike tips (angle ≈ 0°) and collinear pass-throughs.
function despike(ring: Point[]): Point[] {
  const pts = [...ring];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 60) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i + pts.length - 1) % pts.length],
        b = pts[i],
        c = pts[(i + 1) % pts.length];
      const abx = a[0] - b[0],
        aby = a[1] - b[1],
        cbx = c[0] - b[0],
        cby = c[1] - b[1];
      const la = Math.hypot(abx, aby),
        lc = Math.hypot(cbx, cby);
      if (la < 0.002 || lc < 0.002 || Math.abs(abx * cby - aby * cbx) < 0.02 * Math.min(la, lc)) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts;
}
type RoomUse = 'office' | 'meeting' | 'studio' | 'lounge' | 'support';
interface Suite {
  name: string;
  span: number;
  use: RoomUse;
}
interface Wing {
  a: Point;
  b: Point;
  depth: number;
  suites: Suite[];
}

// Illustrative office accommodation, aligned to the two street-facing wings rather than the
// footprint's diagonal principal axis. Each department has its own programme and room sizes.
export function stockmannOffices(
  project: ProjectDocument,
  floorId: string,
  footprint: Ring,
  atrium: Ring,
  cores: Ring[],
) {
  const level = Number(floorId.slice(-2));
  const suite = (name: string, span: number, use: RoomUse): Suite => ({ name, span, use });
  const west: Suite[] =
    level === 7
      ? [
          suite('Buying team · fashion', 24, 'studio'),
          suite('Sample review', 11, 'meeting'),
          suite('Buying team · home', 22, 'studio'),
          suite('Supplier meeting', 7, 'meeting'),
          suite('Category lead', 5, 'office'),
          suite('Merchandising', 18, 'studio'),
          suite('Team kitchen', 13, 'lounge'),
        ]
      : level === 8
        ? [
            suite('Creative studio', 28, 'studio'),
            suite('Campaign workshop', 14, 'meeting'),
            suite('Brand & communications', 22, 'studio'),
            suite('Interview room', 5, 'meeting'),
            suite('People partner', 5, 'office'),
            suite('HR team', 15, 'studio'),
            suite('Staff lounge', 12, 'lounge'),
          ]
        : [
            suite('F8 lounge', 27, 'lounge'),
            suite('Boardroom', 15, 'meeting'),
            suite('Leadership office', 7, 'office'),
            suite('Leadership office', 6, 'office'),
            suite('Executive support', 17, 'studio'),
            suite('Strategy room', 10, 'meeting'),
            suite('Guest lounge', 17, 'lounge'),
          ];
  const east: Suite[] =
    level === 7
      ? [
          suite('Finance & planning', 23, 'studio'),
          suite('Budget meeting', 9, 'meeting'),
          suite('Focus office', 4.5, 'office'),
          suite('Focus office', 5, 'office'),
          suite('Operations', 22, 'studio'),
          suite('Quiet room', 5.5, 'office'),
          suite('Administration', 19, 'studio'),
          suite('Records', 12, 'support'),
        ]
      : level === 8
        ? [
            suite('Digital marketing', 25, 'studio'),
            suite('Content review', 10, 'meeting'),
            suite('Interview room', 5, 'meeting'),
            suite('HR consulting', 5.5, 'office'),
            suite('Learning & development', 19, 'studio'),
            suite('Training room', 18, 'meeting'),
            suite('Wellbeing room', 6, 'lounge'),
            suite('Print & storage', 12, 'support'),
          ]
        : [
            suite('Management team', 20, 'studio'),
            suite('Conference room', 13, 'meeting'),
            suite('Director office', 7, 'office'),
            suite('Director office', 6, 'office'),
            suite('Private dining', 16, 'lounge'),
            suite('Project team', 20, 'studio'),
            suite('Meeting room', 9, 'meeting'),
            suite('Archive', 10, 'support'),
          ];
  const wings: Wing[] = [
    { a: [-51.6, 2.5], b: [34.6, 64.6], depth: level === 9 ? 8.4 : 7.2, suites: west },
    { a: [57.2, 40.2], b: [21.3, -56.7], depth: level === 8 ? 8.2 : 7.4, suites: east },
  ];
  const basis = (wing: Wing) => {
    const length = distance(wing.a, wing.b),
      dx = (wing.b[0] - wing.a[0]) / length,
      dy = (wing.b[1] - wing.a[1]) / length;
    const at = (along: number, inward: number): Point => [
      wing.a[0] + dx * along + dy * inward,
      wing.a[1] + dy * along - dx * inward,
    ];
    const strip = (a: number, b: number, near: number, far: number): Ring =>
      closeRing([at(a, near), at(b, near), at(b, far), at(a, far)]);
    return { length, at, strip, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
  };
  const floor: MultiPolygon = polygonClipping.difference(
    [closeRing(footprint)],
    [closeRing(atrium)],
    ...cores.map(r => [closeRing(r)]),
  ) as MultiPolygon;
  const paths: MultiPolygon = [
    [rectangle([3.5, 4], 33, 34)], // continuous gallery around the atrium
    [rectangle([-23.5, -7.5], 27, 3)], // west lift/stair lobby
    [rectangle([32, 8], 28, 3)], // east lift lobby to east wing
    [rectangle([2.5, 32], 3, 30)], // north gallery connection
    [rectangle([1, -28], 3, 34)], // south gallery connection
    ...wings.map(w => {
      const b = basis(w);
      return [b.strip(-3, b.length + 3, w.depth, w.depth + 2.6)];
    }),
  ];
  const circulation = polygonClipping.intersection(
    floor,
    polygonClipping.union(paths[0], ...paths.slice(1)),
  ) as MultiPolygon;
  let available = polygonClipping.difference(floor, circulation) as MultiPolygon;
  const finishes: Record<RoomUse, string> = {
    // Light, clearly separated pastels: the 3D pass multiplies these by the floor finish and the
    // scene exposure, so anything authored at concrete-grey lightness comes back as concrete.
    office: '#dbe5ec',
    meeting: '#d2e6d6',
    studio: '#dde2f1',
    lounge: '#efe4cd',
    support: '#e3e6ea',
  };
  const rooms: { object: SiteObject; use: RoomUse; angle: number; enclosed: boolean; monitored?: boolean }[] = [];
  const inside = (point: Point, rings: Ring[]) =>
    pointInRing(point, rings[0]) && !rings.slice(1).some(r => pointInRing(point, r));
  function emit(rings: Ring[], name: string, color: string): SiteObject | undefined {
    // Boolean operations preserve courtyards and cores; discard numerical slivers only.
    const clean = rings.map(r => closeRing(despike(openRing(r))));
    if (
      clean.some(r => openRing(r).length < 3) ||
      ringArea(clean[0]) - clean.slice(1).reduce((n, r) => n + ringArea(r), 0) < 4
    )
      return;
    const xs = clean[0].map(p => p[0]),
      ys = clean[0].map(p => p[1]);
    let position = centroid(clean[0]);
    // Polygon centroids can fall in the atrium or outside an L-shaped studio. Find an interior
    // label point with clearance rather than putting its name over a neighbouring room.
    if (!inside(position, clean)) {
      let best = -1;
      for (let x = Math.min(...xs) + 1; x < Math.max(...xs); x += 1.5)
        for (let y = Math.min(...ys) + 1; y < Math.max(...ys); y += 1.5) {
          const p: Point = [x, y];
          if (!inside(p, clean)) continue;
          const clearance = Math.min(
            ...clean.flatMap(r =>
              openRing(r).map((a, i, points) => segmentProjection(p, a, points[(i + 1) % points.length]).distance),
            ),
          );
          if (clearance > best) {
            position = p;
            best = clearance;
          }
        }
    }
    const object: SiteObject = {
      id: uid(),
      kind: 'room',
      floorId,
      name,
      position,
      rotation: 0,
      rings: clean,
      width: Math.max(...xs) - Math.min(...xs),
      depth: Math.max(...ys) - Math.min(...ys),
      height: 3,
      color,
    };
    project.objects.push(object);
    return object;
  }
  for (const polygon of circulation) emit(polygon, 'Gallery & lift lobbies', '#dfe3e8');
  for (const wing of wings) {
    const b = basis(wing);
    let cursor = 0;
    for (const [i, spec] of wing.suites.entries()) {
      const end = i === wing.suites.length - 1 ? b.length : Math.min(b.length, cursor + spec.span);
      const cell = clip('intersection', available, [[b.strip(cursor, end, 0, wing.depth)]]);
      for (const polygon of cell) {
        const object = emit(polygon, spec.name, finishes[spec.use]);
        if (object)
          rooms.push({
            object,
            use: spec.use,
            angle: b.angle,
            enclosed: spec.use !== 'studio' && spec.use !== 'lounge',
            monitored: true,
          });
      }
      available = clip('difference', available, cell);
      cursor = end;
    }
  }
  // The lift lobbies must open onto the gallery: every core wall that borders circulation gets a
  // proper doorway. core() cuts one door into its longest wall, which can face an office instead.
  for (const [ci, ring] of cores.entries()) {
    const pts = openRing(closeRing(ring));
    for (const [i, a] of pts.entries()) {
      const b = pts[(i + 1) % pts.length];
      const barrier = project.barriers.find(bar => {
        if (bar.floorId !== floorId) return false;
        const [x, y] = barrierEnds(project, bar);
        return (distance(x, a) < 0.1 && distance(y, b) < 0.1) || (distance(x, b) < 0.1 && distance(y, a) < 0.1);
      });
      if (!barrier || project.objects.some(o => o.barrierId === barrier.id)) continue;
      const length = distance(a, b);
      if (length < 2) continue;
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const nx = (b[1] - a[1]) / length,
        ny = -(b[0] - a[0]) / length;
      if (![-0.45, 0.45].some(off => circulation.some(poly => inside([mid[0] + nx * off, mid[1] + ny * off], poly))))
        continue;
      const [start] = barrierEnds(project, barrier);
      const doorId = uid();
      project.objects.push({
        id: doorId,
        kind: 'door',
        floorId,
        name: `Lift lobby door ${ci ? 'west' : 'east'}`,
        position: mid,
        rotation: 0,
        width: 1.6,
        depth: 0.15,
        height: 2.1,
        barrierId: barrier.id,
        offset: distance(start, mid),
        color: '#bba98e',
        feedId: `feed-${doorId.slice(-8)}`,
      });
    }
  }

  // Fill the neighbourhoods the wings left over — a real fit-out leaves no unplanned prairie.
  // The cut is systematic: work in the frame of the nearest wing (the layout follows the building,
  // never the world axes), slice into room-deep bands, cross-cut each band on a varied rhythm, and
  // let each leftover's own boundary trim the cells. Cells sized like rooms and reachable from a
  // corridor become enclosed offices, meeting rooms and project rooms; everything else stays an
  // open desk block — walls there would seal space no corridor serves.
  const shared =
    level === 7
      ? ['Shared project hub', 'Buying collaboration', 'Operations hub']
      : level === 8
        ? ['Campaign commons', 'HR collaboration', 'Learning hub']
        : ['Executive reception', 'F8 breakout', 'Strategy hub'];
  const ROWS = [5.4, 6.6, 4.8, 7.2];
  const RHYTHM = [6.4, 4.6, 7.8, 5.2, 8.6, 5.0];
  const nearestWingAngle = (at: Point) => {
    let best = wings[0],
      score = Number.POSITIVE_INFINITY;
    for (const w of wings) {
      const d = segmentProjection(at, w.a, w.b).distance;
      if (d < score) {
        score = d;
        best = w;
      }
    }
    return basis(best).angle;
  };
  /** Longest boundary edge lying against the circulation network — 0 when the cell is landlocked. */
  const corridorFrontage = (rings: Ring[]) => {
    let frontage = 0;
    const ring = openRing(rings[0]);
    for (const [i, a] of ring.entries()) {
      const b = ring[(i + 1) % ring.length];
      const length = distance(a, b);
      if (length < 1) continue;
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const nx = (b[1] - a[1]) / length,
        ny = -(b[0] - a[0]) / length;
      if ([-0.45, 0.45].some(off => circulation.some(poly => inside([mid[0] + nx * off, mid[1] + ny * off], poly))))
        frontage = Math.max(frontage, length);
    }
    return frontage;
  };
  const counters = { office: 0, meeting: 0, project: 0 };
  const tag = (n: number) => `${level}.${String(n).padStart(2, '0')}`;
  let openIndex = 0;
  const openName = () => {
    const base = shared[openIndex % shared.length];
    const round = Math.floor(openIndex / shared.length);
    openIndex++;
    return round ? `${base} ${round + 1}` : base;
  };
  available.forEach((polygon, pi) => {
    const angle = nearestWingAngle(centroid(polygon[0]));
    const local = polygon[0].map(p => rotate(p, -angle));
    const xs = local.map(p => p[0]),
      ys = local.map(p => p[1]);
    let rowIndex = pi;
    const [xMin, xMax, yMin, yMax] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (let y = yMin; y < yMax; rowIndex++) {
      const depth = ROWS[rowIndex % ROWS.length];
      let colIndex = rowIndex; // start each row at a different point in the rhythm: no dumb grid
      for (let x = xMin; x < xMax; colIndex++) {
        const width = RHYTHM[colIndex % RHYTHM.length];
        const cell: Ring = closeRing(
          (
            [
              [x, y],
              [x + width, y],
              [x + width, y + depth],
              [x, y + depth],
            ] as Point[]
          ).map(p => rotate(p, angle)),
        );
        for (const piece of clip('intersection', [polygon], [[cell]])) {
          const area = ringArea(piece[0]) - piece.slice(1).reduce((n, r) => n + ringArea(r), 0);
          if (area < 4.5) continue;
          // 4·area/perimeter is the harmonic mean of a rectangle's sides — it tracks the narrow
          // dimension whatever the shape's angle. A strip too slim to stand in is not a room:
          // leave it as open floor rather than a sealed sliver nobody could ever enter.
          const ringPts = openRing(piece[0]);
          const perimeter = ringPts.reduce((n, pt, i) => n + distance(pt, ringPts[(i + 1) % ringPts.length]), 0);
          const slim = (4 * area) / perimeter;
          if (slim < 1.4) continue;
          const doorway = corridorFrontage(piece) >= 1.8 && slim >= 2.2;
          const use: RoomUse | 'project' = !doorway
            ? 'studio'
            : area < 11
              ? 'office'
              : area < 24
                ? 'meeting'
                : area < 36
                  ? 'project'
                  : 'studio';
          const enclosed = use === 'office' || use === 'meeting' || use === 'project';
          const name =
            use === 'office'
              ? `Office ${tag(++counters.office)}`
              : use === 'meeting'
                ? `Meeting ${tag(++counters.meeting)}`
                : use === 'project'
                  ? `Project room ${tag(++counters.project)}`
                  : openName();
          const roomUse: RoomUse = use === 'project' ? 'studio' : use;
          const object = emit(piece, name, finishes[roomUse]);
          if (object) rooms.push({ object, use: roomUse, angle, enclosed });
        }
        x += width;
      }
      y += depth;
    }
  });

  // Draw real partitions around enclosed suites. Open studios retain broad, unobstructed entries.
  const existing = project.barriers.filter(b => b.floorId === floorId).map(b => barrierEnds(project, b));
  const segments = new Map<string, string>(),
    junctions = new Map<string, string>();
  const pointKey = (p: Point) => p.map(n => n.toFixed(4)).join(',');
  function junction(point: Point) {
    const key = pointKey(point);
    let id = junctions.get(key);
    if (!id) {
      id = uid();
      junctions.set(key, id);
      project.junctions.push({ id, floorId, position: point });
    }
    return id;
  }
  for (const room of rooms) {
    const { object, use, angle, enclosed, monitored } = room;
    if (enclosed) {
      let doorPlaced = false;
      const ring = openRing(object.rings![0]);
      for (const [i, a] of ring.entries()) {
        const b = ring[(i + 1) % ring.length],
          length = distance(a, b);
        if (length < MIN_SEGMENT) continue; // a stub this short would be un-editable debris, not a wall
        if (
          existing.some(
            ([x, y]) => segmentProjection(a, x, y).distance < 0.1 && segmentProjection(b, x, y).distance < 0.1,
          )
        )
          continue;
        const key = [pointKey(a), pointKey(b)].sort().join('|');
        let id = segments.get(key);
        if (!id) {
          id = uid();
          segments.set(key, id);
          project.barriers.push({
            id,
            floorId,
            startId: junction(a),
            endId: junction(b),
            kind: 'wall',
            name: `${object.name} partition`,
            thickness: 0.13,
            height: 2.8,
            color: '#c0c4c0',
            material: 'plaster',
          });
        }
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        // A doorway belongs on a wall with the corridor on ONE side and this room's own interior
        // on the OTHER. Checking only the corridor side put doors through concave stretches of the
        // ring that the room's interior never touches — a door from the gallery into nothing.
        const nearPath = [-1, 1].some(sign => {
          const out: Point = [
            mid[0] + ((sign * (b[1] - a[1])) / length) * 0.25,
            mid[1] - ((sign * (b[0] - a[0])) / length) * 0.25,
          ];
          // The room probe reaches as far as portal inference will: a wedge of interior thinner
          // than the probe would take the door but never resolve a portal through it.
          const back: Point = [
            mid[0] - ((sign * (b[1] - a[1])) / length) * 0.55,
            mid[1] + ((sign * (b[0] - a[0])) / length) * 0.55,
          ];
          return circulation.some(poly => inside(out, poly)) && inside(back, object.rings!);
        });
        if (!doorPlaced && length > 1.6 && nearPath && !project.objects.some(o => o.barrierId === id)) {
          const doorId = uid();
          project.objects.push({
            id: doorId,
            kind: 'door',
            floorId,
            name: `${object.name} door`,
            position: mid,
            rotation: 0,
            width: 0.95,
            depth: 0.13,
            height: 2.1,
            barrierId: id,
            offset: length / 2,
            color: '#bba98e',
            // Only the named department suites feed the live-status demo: one dot per fill-room
            // door buried the plan under a hundred markers.
            feedId: monitored ? `feed-${doorId.slice(-8)}` : undefined,
          });
          doorPlaced = true;
        }
      }
    }
    // Furniture has generous clearance from room boundaries, and its long axis follows its wing.
    const addFurniture = (
      position: Point,
      model: 'dining' | 'sofa' | 'cabinet',
      width: number,
      depth: number,
      rotation: number,
    ) => {
      const clearance = rectangle(position, width + 1.2, depth + 1.2, rotation);
      if (!openRing(clearance).every(p => inside(p, object.rings!))) return;
      project.objects.push({
        id: uid(),
        kind: 'fixture',
        floorId,
        name:
          model === 'dining'
            ? use === 'meeting'
              ? 'Meeting table'
              : 'Work table'
            : model === 'sofa'
              ? 'Lounge seating'
              : 'Storage',
        position,
        rotation,
        width,
        depth,
        height: model === 'cabinet' ? 1.2 : 0.74,
        model,
        color: '#c8b9a2',
      });
    };
    if (use === 'studio') {
      const box = object.rings![0].map(p => rotate(p, -angle)),
        xs = box.map(p => p[0]),
        ys = box.map(p => p[1]);
      let count = 0;
      for (let x = Math.min(...xs) + 3; x < Math.max(...xs) - 2 && count < 12; x += 5)
        for (let y = Math.min(...ys) + 3; y < Math.max(...ys) - 2 && count < 12; y += 4.5) {
          const before = project.objects.length;
          addFurniture(rotate([x, y], angle), 'dining', 2.8, 1.4, angle);
          if (project.objects.length > before) count++;
        }
    } else
      addFurniture(
        object.position,
        use === 'lounge' ? 'sofa' : use === 'support' ? 'cabinet' : 'dining',
        use === 'meeting' ? 3.4 : 2,
        use === 'meeting' ? 1.2 : 0.85,
        angle,
      );
  }

  // No sealed rooms. A cell can end up boxed in by its neighbours' walls — an enclosed room whose
  // door found no corridor to face, or an open block ringed entirely by enclosed suites. A space no
  // route can reach is a modelling error (the ontology walk visits every one), so break each
  // shut-in open with a door through its longest partition — never the facade, and the core walls
  // only as a last resort.
  const floorBarriers = project.barriers.filter(b => b.floorId === floorId && b.name !== 'Facade wall');
  const wallEnds = new Map(floorBarriers.map(b => [b.id, barrierEnds(project, b) as [Point, Point]]));
  for (const { object } of rooms) {
    const ring = openRing(object.rings![0]);
    let open = false;
    const walls: { id: string; length: number; partition: boolean; mid: Point }[] = [];
    for (const [i, a] of ring.entries()) {
      const b = ring[(i + 1) % ring.length];
      const length = distance(a, b);
      if (length < 0.35) continue;
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const cover = floorBarriers.find(bar => segmentProjection(mid, ...wallEnds.get(bar.id)!).distance < 0.09);
      if (!cover) {
        // An uncovered stretch this long reads back as an open boundary; the room is reachable.
        if (length >= 1.3) open = true;
        continue;
      }
      const hasDoor = project.objects.some(
        o => o.kind === 'door' && o.barrierId === cover.id && segmentProjection(o.position, a, b).distance < 0.2,
      );
      if (hasDoor) open = true;
      walls.push({ id: cover.id, length, partition: cover.name.endsWith('partition'), mid });
    }
    if (open) continue;
    // A door frees the room only if the room itself stands on one side of it and a DIFFERENT
    // space on the other — a doorway onto a clipped-out sliver, or through a wall stretch the
    // room's own interior never touches, frees nobody.
    const leadsSomewhere = (w: (typeof walls)[number]) => {
      const [wa, wb] = wallEnds.get(w.id)!;
      const len = distance(wa, wb);
      const nx = (wb[1] - wa[1]) / len,
        ny = -(wb[0] - wa[0]) / len;
      const sides = [-0.6, 0.6].map(off =>
        spaceAt(project, floorId, [w.mid[0] + nx * off, w.mid[1] + ny * off] as Point),
      );
      return sides.some(s => s?.id === object.id) && sides.some(s => s && s.id !== object.id);
    };
    const pick = walls
      .filter(w => w.length >= 1.6 && !project.objects.some(o => o.barrierId === w.id) && leadsSomewhere(w))
      .sort((x, y) => Number(y.partition) - Number(x.partition) || y.length - x.length)[0];
    if (!pick) continue;
    // The covering wall can run past this room's own stretch of it, so the door stands at the
    // EDGE's midpoint — projected onto the wall for its offset — not at the wall's.
    const [wa, wb] = wallEnds.get(pick.id)!;
    const hit = segmentProjection(pick.mid, wa, wb);
    const doorId = uid();
    project.objects.push({
      id: doorId,
      kind: 'door',
      floorId,
      name: `${object.name} door`,
      position: hit.point,
      rotation: 0,
      width: 0.95,
      depth: 0.13,
      height: 2.1,
      barrierId: pick.id,
      offset: hit.t * distance(wa, wb),
      color: '#bba98e',
    });
  }
}
