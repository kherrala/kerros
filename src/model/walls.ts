// Wall alignment. A wall in a real building almost never points wherever the pointer happened to be:
// it runs with the building, squares across it, or continues a wall that is already there. This
// module works out which of those a given spot calls for, so the drawing tools can hold to it.
//
// Everything here is in local metres, which `toLocal` has already rotated by the site origin's
// bearing — so 0° is the site's own grid rather than true north, and a building laid out along its
// street needs no reference angle at all beyond the default.
import polygonClipping from 'polygon-clipping';
import { boundaryEdges, type BoundaryEdge } from './boundaries';
import { drawBarrier } from './authoring';
import { transact } from './validate';
import {
  OPENING_MIN_SEGMENT,
  barrierEnds,
  barrierJoinPoint,
  barrierStrokeIssue,
  closeRing,
  distance,
  openRing,
  pointInRing,
  rectangle,
  segmentProjection,
  snapPoint,
} from './geometry';
import type { Point, ProjectDocument, Ring } from './types';

interface CornerNeighbour {
  point: Point;
  /** Other ends of unchanged edges meeting this neighbour. */
  references: Point[];
}

/** Hold the moving corner to parallels/perpendiculars of the unchanged neighbouring edges.
 * Two nearby constraints determine a corner exactly; projecting onto just one cannot restore a
 * rectangle. Prefer their intersection over a one-line projection, within the same screen reach. */
function snapCorner(raw: Point, tolerance: number, neighbours: CornerNeighbour[]): Point | undefined {
  const lines: { anchor: Point; direction: Point; neighbour: number }[] = [];
  let best = tolerance,
    projected: Point | undefined;
  for (const [neighbour, { point: anchor, references }] of neighbours.entries()) {
    for (const reference of references) {
      const length = distance(anchor, reference);
      if (length < 1e-6) continue;
      const dx = (reference[0] - anchor[0]) / length,
        dy = (reference[1] - anchor[1]) / length;
      for (const direction of [
        [dx, dy],
        [-dy, dx],
      ] as Point[]) {
        const along = (raw[0] - anchor[0]) * direction[0] + (raw[1] - anchor[1]) * direction[1];
        const point: Point = [anchor[0] + along * direction[0], anchor[1] + along * direction[1]];
        const error = distance(raw, point);
        if (error >= tolerance) continue;
        lines.push({ anchor, direction, neighbour });
        if (error < best) {
          best = error;
          projected = point;
        }
      }
    }
  }
  best = tolerance;
  let intersection: Point | undefined;
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (a.neighbour === b.neighbour) continue;
      const denominator = a.direction[0] * b.direction[1] - a.direction[1] * b.direction[0];
      if (Math.abs(denominator) < 1e-6) continue;
      const dx = b.anchor[0] - a.anchor[0],
        dy = b.anchor[1] - a.anchor[1];
      const along = (dx * b.direction[1] - dy * b.direction[0]) / denominator;
      const point: Point = [a.anchor[0] + along * a.direction[0], a.anchor[1] + along * a.direction[1]];
      const error = distance(raw, point);
      if (error < best) {
        best = error;
        intersection = point;
      }
    }
  }
  return intersection ?? projected;
}

// A gesture reads one immutable project snapshot. Index adjacency once so corner constraints only
// inspect local neighbours on pointer moves, without traversing the full plan for each neighbour.
const dragIndexes = new WeakMap<
  ProjectDocument,
  {
    positions: Map<string, Point>;
    incident: Map<string, BoundaryEdge[]>;
  }
>();
function dragIndex(project: ProjectDocument) {
  const cached = dragIndexes.get(project);
  if (cached) return cached;
  const positions = new Map(project.junctions.map(j => [j.id, j.position]));
  const incident = new Map<string, BoundaryEdge[]>();
  for (const edge of boundaryEdges(project)) {
    for (const id of [edge.startId, edge.endId]) {
      const edges = incident.get(id) ?? [];
      edges.push(edge);
      incident.set(id, edges);
    }
  }
  const index = { positions, incident };
  dragIndexes.set(project, index);
  return index;
}

/** A drag snaps in the geometry's frame. Rounding x/y independently moves an imported wall's
 * junction off its centreline, even when the pointer follows that centreline exactly. */
export function snapDragPoint(
  project: ProjectDocument,
  floorId: string | null,
  kind: 'junction' | 'barrier' | 'ring',
  id: string,
  raw: Point,
  snapping: boolean,
  tolerance: number,
  ringIndex = 0,
  vertexIndex = 0,
): Point {
  if (kind === 'barrier') {
    const wall = boundaryEdges(project).find(b => b.id === id);
    if (!wall) return raw;
    const [a, b] = barrierEnds(project, wall),
      length = distance(a, b);
    const nx = -(b[1] - a[1]) / length,
      ny = (b[0] - a[0]) / length;
    let slide = (raw[0] - (a[0] + b[0]) / 2) * nx + (raw[1] - (a[1] + b[1]) / 2) * ny;
    if (snapping) {
      const desired = slide;
      let best = tolerance,
        held: number | undefined;
      const axis = mainAxis(project, floorId);
      const angles = [axisOf(a, b), ...Array.from({ length: 12 }, (_, i) => axis + i * 15)];
      // Solve the wall's normal displacement for each neighbouring segment's alignment.
      // The neighbours' remote ends stay fixed; their shared ends move with this wall.
      for (const other of boundaryEdges(project)) {
        if (other.id === wall.id) continue;
        const moving = [other.startId, other.endId].find(j => j === wall.startId || j === wall.endId);
        const fixedId = [other.startId, other.endId].find(j => j !== wall.startId && j !== wall.endId);
        if (!moving || !fixedId) continue;
        const at = moving === wall.startId ? a : b;
        const fixed = project.junctions.find(j => j.id === fixedId)!.position;
        for (const angle of angles) {
          const ux = Math.cos((angle * Math.PI) / 180),
            uy = Math.sin((angle * Math.PI) / 180);
          const denominator = nx * uy - ny * ux;
          if (Math.abs(denominator) < 1e-6) continue;
          const offset = ((fixed[0] - at[0]) * uy - (fixed[1] - at[1]) * ux) / denominator;
          const error = Math.abs(offset - desired);
          if (error < best) {
            best = error;
            held = offset;
          }
        }
      }
      slide = held ?? Math.round(slide * 2) / 2;
    }
    return [(a[0] + b[0]) / 2 + nx * slide, (a[1] + b[1]) / 2 + ny * slide];
  }
  if (!snapping) return raw;
  if (kind === 'ring') {
    const ring = openRing(project.objects.find(o => o.id === id)?.rings?.[ringIndex] ?? []);
    const neighbours: CornerNeighbour[] = [];
    if (ring.length >= 3 && vertexIndex >= 0 && vertexIndex < ring.length) {
      for (const step of [-1, 1]) {
        neighbours.push({
          point: ring[(vertexIndex + step + ring.length) % ring.length],
          references: [ring[(vertexIndex + 2 * step + ring.length) % ring.length]],
        });
      }
    }
    return snapCorner(raw, tolerance, neighbours) ?? [Math.round(raw[0] * 2) / 2, Math.round(raw[1] * 2) / 2];
  }
  const index = dragIndex(project);
  const incident = index.incident.get(id) ?? [];
  const incoming = new Set(incident.map(b => b.id));
  const others = {
    ...project,
    junctions: project.junctions.filter(j => j.id !== id),
    barriers: project.barriers.filter(b => !incoming.has(b.id)),
    virtualBoundaries: project.virtualBoundaries?.filter(b => !incoming.has(b.id)),
  };
  // Receiving junctions and walls take priority over the grid. Do not snap onto the point being
  // dragged or weld it back onto one of its own changing segments.
  const nearby = snapPoint(others, floorId, raw, tolerance, undefined, false);
  if (nearby.label) return nearby.point;
  const neighbours = [...new Set(incident.map(edge => (edge.startId === id ? edge.endId : edge.startId)))];
  const corner = snapCorner(
    raw,
    tolerance,
    neighbours.map(neighbour => ({
      point: index.positions.get(neighbour)!,
      references: (index.incident.get(neighbour) ?? [])
        .filter(edge => !incoming.has(edge.id))
        .map(edge => index.positions.get(edge.startId === neighbour ? edge.endId : edge.startId)!),
    })),
  );
  if (corner) return corner;
  let best = tolerance,
    aligned: Point | undefined;
  for (const wall of incident) {
    const [a, b] = barrierEnds(project, wall),
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = ((raw[0] - a[0]) * dx + (raw[1] - a[1]) * dy) / (dx * dx + dy * dy);
    const at: Point = [a[0] + t * dx, a[1] + t * dy];
    const d = distance(raw, at);
    if (d < best) {
      best = d;
      aligned = at;
    }
  }
  if (aligned) return aligned;
  const neighbour = incident
    .map(b => project.junctions.find(j => j.id === (b.startId === id ? b.endId : b.startId))!)
    .sort((a, b) => distance(raw, a.position) - distance(raw, b.position))[0];
  return snapPoint(others, floorId, raw, tolerance, neighbour?.position, true, mainAxis(project, floorId)).point;
}

/** A segment's direction as an *axis* in [0, 180). A wall and the same wall drawn backwards describe
 *  one line, so 10° and 190° have to compare equal or half of every alignment test misses. */
export const axisOf = (a: Point, b: Point): number => {
  const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return ((deg % 180) + 180) % 180;
};
/** The smallest rotation carrying axis `from` onto axis `to`, in (-90, 90]. */
export const axisDelta = (from: number, to: number): number => {
  const d = (((to - from) % 180) + 180) % 180;
  return d > 90 ? d - 180 : d;
};
/** Two directions count as the same when they are within this many degrees. Wide enough to absorb a
 *  footprint traced by hand or imported from a cadastral outline, narrow enough that a wall set at a
 *  deliberate angle still reads as its own direction. */
export const ALIGNED = 4;

const ringEdges = (ring: Ring): [Point, Point][] =>
  ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as [Point, Point]);

const outlines = new WeakMap<ProjectDocument, Map<string | null, Ring[]>>();

/** The rings describing a floor's outline: its own top-level zones when it has them, else the union
 *  of the rooms drawn on it, else the site's building footprints. Shared with `exteriorWalls` so
 *  "the outline" means one thing across the app.
 *
 *  The room union is what a floor without a zone over it actually has. An imported plan is exactly
 *  that — rooms traced off a drawing, no covering zone and no site footprint — and skipping straight
 *  to the building objects returned nothing for it, so not one of its walls counted as exterior:
 *  no exterior material, no facade preset, and nothing for a stacked view to draw a storey's edge
 *  from. Cached per document, which is immutable between edits, because the union is not free. */
export function floorOutline(project: ProjectDocument, floorId: string | null): Ring[] {
  let cache = outlines.get(project);
  if (!cache) outlines.set(project, (cache = new Map()));
  const hit = cache.get(floorId);
  if (hit) return hit;
  const zones = project.objects.filter(o => o.floorId === floorId && o.kind === 'zone' && !o.parentId && o.rings);
  let rings: Ring[] = zones.flatMap(o => o.rings!.map(openRing));
  if (!rings.length) {
    const rooms = project.objects.filter(o => o.floorId === floorId && o.kind === 'room' && o.rings?.length);
    if (rooms.length) {
      try {
        // The rooms AND the walls between them. Rooms alone do not touch — there is a wall in every
        // gap — so their union is one polygon per room rather than one building, and an outline per
        // room makes every interior partition look like it sits on the outside of something. The
        // floor's real footprint is what you could stand on plus what encloses it, and unioning the
        // wall bodies in is what closes those gaps into a single plate.
        const roomRings = rooms.map(o => closeRing(o.rings![0]));
        const solids: Ring[][] = roomRings.map(r => [r]);
        for (const b of project.barriers) {
          // Walls only. A fence is drawn on a floor but is not part of its plate, and unioning one
          // in makes the site boundary the building's longest edge — which is then what every new
          // wall squares itself to.
          if (b.floorId !== floorId || b.kind !== 'wall') continue;
          const [a, c] = barrierEnds(project, b);
          const len = distance(a, c);
          if (len < 1e-6) continue;
          const angle = (Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI;
          // Run on by half a thickness at each end, as spaces.ts sweeps them, or every outer corner
          // keeps a square notch where the two walls only overlap across their inner quarter.
          solids.push([
            closeRing(rectangle([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2], len + b.thickness, b.thickness, angle)),
          ]);
        }
        // Snapped to a tenth of a millimetre first. Two walls meeting at a corner arrive here with
        // coordinates that differ in the fifteenth decimal, and the clipper answers that by failing
        // to close a ring at all — which silently cost this floor its whole outline.
        const snap = (pg: Ring[]): Ring[] =>
          pg.map(r => r.map(q => [Math.round(q[0] * 1e4) / 1e4, Math.round(q[1] * 1e4) / 1e4] as Point));
        const clean = solids.map(snap);
        const merged = polygonClipping.union(...(clean as [Ring[], ...Ring[][]])) as unknown as Ring[][];
        // Outer rings only: a courtyard is a hole in the plate, not a second outline, and a stairwell
        // void certainly is not a façade.
        //
        // And only the polygons that a room is actually part of. Wall bodies are here to close the
        // gaps BETWEEN rooms; one standing away from the building — a garden wall, a retaining wall —
        // touches no room and would otherwise come back as a little footprint of its own, which then
        // reads as a façade with its own exterior finish.
        rings = merged
          .filter(pg => roomRings.some(r => r.some(q => pointInRing(q, openRing(pg[0])))))
          .map(pg => openRing(pg[0]));
      } catch {
        // Still degenerate. The rooms alone are a worse outline — they leave a gap at every wall —
        // but they are an outline, and no outline at all means no façade and no floor plate.
        try {
          const merged = polygonClipping.union(
            ...(rooms.map(o => [closeRing(o.rings![0])]) as [Ring[], ...Ring[][]]),
          ) as unknown as Ring[][];
          rings = merged.map(pg => openRing(pg[0]));
        } catch {
          rings = [];
        }
      }
    }
  }
  if (!rings.length)
    rings = project.objects.filter(o => o.kind === 'building' && o.rings).flatMap(o => o.rings!.map(openRing));
  cache.set(floorId, rings);
  return rings;
}

/** The axis a set of edges most runs along, weighted by length — edges within ALIGNED° of each other
 *  count as one direction and are averaged, so a ragged outline still resolves to the single
 *  direction a person would point at. Null when there is nothing long enough to be a direction. */
function dominantAxis(edges: [Point, Point][]): number | null {
  const buckets: { seed: number; weight: number; drift: number }[] = [];
  for (const [a, b] of edges) {
    const length = distance(a, b);
    if (length < 0.5) continue; // vertex noise, not a direction
    const axis = axisOf(a, b);
    const bucket = buckets.find(x => Math.abs(axisDelta(x.seed, axis)) <= ALIGNED);
    if (!bucket) buckets.push({ seed: axis, weight: length, drift: 0 });
    else {
      // Drift accumulates *relative to the seed* so a bucket straddling the 0/180 wrap still averages.
      bucket.drift += length * axisDelta(bucket.seed, axis);
      bucket.weight += length;
    }
  }
  const best = buckets.sort((a, b) => b.weight - a.weight)[0];
  return best ? (((best.seed + best.drift / best.weight) % 180) + 180) % 180 : null;
}

/** The building's main axis on this floor: the direction its outline predominantly runs, in [0, 180).
 *  Falls back to the walls already drawn, and finally to 0 — the site grid, which for a project whose
 *  origin carries a bearing is already the building's street alignment. */
export function mainAxis(project: ProjectDocument, floorId: string | null): number {
  // Every pointer move asks for this, so memoise per document — edits replace the document object,
  // which retires the entry with it. Same bargain exteriorWalls strikes.
  let byFloor = axisCache.get(project);
  if (!byFloor) axisCache.set(project, (byFloor = new Map()));
  const key = floorId ?? '';
  const cached = byFloor.get(key);
  if (cached !== undefined) return cached;
  const axis =
    dominantAxis(floorOutline(project, floorId).flatMap(ringEdges)) ??
    dominantAxis(project.barriers.filter(b => b.floorId === floorId).map(b => barrierEnds(project, b))) ??
    0;
  byFloor.set(key, axis);
  return axis;
}
const axisCache = new WeakMap<ProjectDocument, Map<string, number>>();

export interface AxisReference {
  /** Degrees in [0, 180). New walls are held to this and its 15° multiples. */
  angle: number;
  source: 'wall' | 'exterior' | 'building';
}
/** What a wall drawn near `point` should line up with: whichever wall — interior or the building's own
 *  exterior — it is being drawn beside, and failing that the building's main axis.
 *
 *  Preferring the near edge over the building-wide average is what makes irregular plans workable. A
 *  wing set askew, or a space with a raked end, has no one true direction; next to the raked end the
 *  raked end *is* the direction, and squaring to the far-off main axis would look wrong there. Drawn
 *  walls win ties against the exterior at equal distance, since an interior wall is the more
 *  deliberate signal. */
export function referenceAxis(
  project: ProjectDocument,
  floorId: string | null,
  point: Point,
  reach: number,
): AxisReference {
  let best = reach,
    found: AxisReference | null = null;
  const consider = (a: Point, b: Point, source: 'wall' | 'exterior') => {
    const d = segmentProjection(point, a, b).distance;
    if (d > best) return; // ties fall to the later candidate, and walls are considered last
    best = d;
    found = { angle: axisOf(a, b), source };
  };
  for (const ring of floorOutline(project, floorId)) for (const [a, b] of ringEdges(ring)) consider(a, b, 'exterior');
  for (const barrier of project.barriers)
    if (barrier.floorId === floorId) consider(...barrierEnds(project, barrier), 'wall');
  return found ?? { angle: mainAxis(project, floorId), source: 'building' };
}

const cross = (px: number, py: number, qx: number, qy: number) => px * qy - py * qx;
/** How far a ray from `from` along unit `dir` travels before crossing segment a→b; null if never. */
function rayHit(from: Point, dir: Point, a: Point, b: Point): number | null {
  const ex = b[0] - a[0],
    ey = b[1] - a[1],
    denom = cross(dir[0], dir[1], ex, ey);
  if (Math.abs(denom) < 1e-9) return null; // parallel: a wall running the same way is never hit
  const rx = a[0] - from[0],
    ry = a[1] - from[1],
    t = cross(rx, ry, ex, ey) / denom,
    u = cross(rx, ry, dir[0], dir[1]) / denom;
  return t > 1e-6 && u >= 0 && u <= 1 ? t : null;
}

export interface WallProposal {
  segment: [Point, Point];
  axis: number;
  reference: AxisReference;
}
/** The wall a space looks like it is missing. Hover anywhere inside one: this squares off against the
 *  wall you are nearest (or the building, in a space that has none yet), runs a line both ways until
 *  it meets something, and offers the whole span as one click.
 *
 *  Null when there is nothing worth offering — no bound on one of the two sides, a span too short to
 *  be a wall, or a wall already running this way within `clear` metres, which means the space is
 *  divided here already. */
export function proposeWall(
  project: ProjectDocument,
  floorId: string | null,
  point: Point,
  clear = 1.5,
): WallProposal | null {
  const reference = referenceAxis(project, floorId, point, Number.POSITIVE_INFINITY);
  const axis = (reference.angle + 90) % 180,
    rad = (axis * Math.PI) / 180,
    dir: Point = [Math.cos(rad), Math.sin(rad)];
  const walls = project.barriers.filter(b => b.floorId === floorId).map(b => barrierEnds(project, b));
  for (const [a, b] of walls)
    if (Math.abs(axisDelta(axisOf(a, b), axis)) <= ALIGNED && segmentProjection(point, a, b).distance < clear)
      return null;
  const graph = boundaryEdges(project)
    .filter(b => b.floorId === floorId)
    .map(b => barrierEnds(project, b));
  // A space's centreline boundaries outrank its derived inner-face outline. Stopping at a
  // cached wall face leaves a small disconnected stub when the wall there is now virtual.
  const edges = graph;
  const fallback = floorOutline(project, floorId).flatMap(ringEdges);
  const end = (sign: number): Point | null => {
    const d: Point = [dir[0] * sign, dir[1] * sign];
    let best = Number.POSITIVE_INFINITY;
    for (const [a, b] of edges) {
      const t = rayHit(point, d, a, b);
      if (t !== null && t < best) best = t;
    }
    if (!Number.isFinite(best))
      for (const [a, b] of fallback) {
        const t = rayHit(point, d, a, b);
        if (t !== null && t < best) best = t;
      }
    return Number.isFinite(best) ? [point[0] + d[0] * best, point[1] + d[1] * best] : null;
  };
  const start = end(1),
    finish = end(-1);
  if (!start || !finish) return null;
  const a = barrierJoinPoint(project, start, floorId),
    b = barrierJoinPoint(project, finish, floorId);
  if (barrierStrokeIssue(project, a, b, floorId)) return null;
  if (
    project.objects.some(o => o.floorId === floorId && o.geometry?.mode === 'boundaries') &&
    !transact(
      project,
      draft => {
        drawBarrier(draft, floorId, a, b);
      },
      { freeze: false },
    ).ok
  )
    return null;
  return distance(a, b) >= 1 ? { segment: [a, b], axis, reference } : null;
}

/** Where an opening would land if you placed it here. */
export interface OpeningFit {
  barrierId: string;
  offset: number;
  position: Point;
  /** The stretch of wall the leaf would occupy — what to draw so the placement is visible first. */
  span: [Point, Point];
}
/** Fit an opening to the nearest wall (or fence, for a gate).
 *
 *  One rule, asked twice: the hover preview and the click that commits must agree, or the preview is
 *  a lie. Returns null when nothing is close enough, which is what lets the tool say so before the
 *  click rather than by throwing after it.
 *
 *  The offset is clamped so the leaf stays on the wall — a door centred 10 cm from the end of its
 *  wall would otherwise hang in the air. */
export function fitOpening(
  project: ProjectDocument,
  floorId: string | null,
  kind: 'door' | 'window' | 'gate' | 'turnstile',
  at: Point,
  width: number,
  reach: number,
  ignoreId?: string,
): OpeningFit | null {
  const wanted = kind === 'gate' ? 'fence' : 'wall';
  let best: OpeningFit | null = null,
    bestDistance = reach;
  for (const barrier of project.barriers) {
    if (barrier.floorId !== floorId || barrier.kind !== wanted) continue;
    const [a, b] = barrierEnds(project, barrier);
    const hit = segmentProjection(at, a, b);
    // Match validation: the segment must be nondegenerate and hold the actual leaf width.
    if (hit.distance >= bestDistance || hit.length < Math.max(width, OPENING_MIN_SEGMENT)) continue;
    // Search the free stretches, not just the whole segment: a preview over an existing door
    // used to promise a placement which validation would then refuse. Sliding a leaf excludes
    // that leaf's old position from the occupied stretches.
    const occupied = project.objects
      .filter(o => o.barrierId === barrier.id && o.id !== ignoreId)
      .map(o => [Math.max(0, (o.offset ?? 0) - o.width / 2), Math.min(hit.length, (o.offset ?? 0) + o.width / 2)])
      .sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    const offsets: number[] = [];
    for (const [start, end] of [...occupied, [hit.length, hit.length]]) {
      if (start - cursor >= width - 1e-9)
        offsets.push(Math.max(cursor + width / 2, Math.min(start - width / 2, hit.t * hit.length)));
      cursor = Math.max(cursor, end);
    }
    if (!offsets.length) continue;
    const offset = offsets.sort((a, b) => Math.abs(a - hit.t * hit.length) - Math.abs(b - hit.t * hit.length))[0];
    const ux = (b[0] - a[0]) / hit.length,
      uy = (b[1] - a[1]) / hit.length;
    const centre: Point = [a[0] + ux * offset, a[1] + uy * offset];
    const fitDistance = distance(at, centre);
    if (fitDistance >= bestDistance) continue;
    bestDistance = fitDistance;
    best = {
      barrierId: barrier.id,
      offset,
      position: centre,
      span: [
        [centre[0] - (ux * width) / 2, centre[1] - (uy * width) / 2],
        [centre[0] + (ux * width) / 2, centre[1] + (uy * width) / 2],
      ],
    };
  }
  return best;
}
