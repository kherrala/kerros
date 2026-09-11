// Which layer carries what, worked out from the drawing rather than from its layer names.
//
// The deterministic importer needs six layers named: the two wall faces, the partition faces, doors,
// windows and room labels. VERTEX_LAYERS names them for the Finnish prefab CAD the importer was
// built against, and a drawing from any other office silently imports badly — its walls are on
// layers with other names, so nothing is found and the result is empty or wrong.
//
// Names are the weak signal. A door swing is an arc beside a pair of short parallel lines whatever
// the layer is called; a window is a tight bundle of parallel lines sitting ON the envelope; a room
// label is text standing inside a room. Geometry is what this reads, with names as a tie-breaker —
// which also means it catches the case no renaming can fix: one layer carrying both wall faces.
import type { PlanEntity, PlanLayerMap } from './types';
import { faceSegments, mergeRuns, type FaceSegment } from './runs';
import { closeCorners, pairWalls, traceRing, type Wall } from './walls';

export type LayerRole = keyof PlanLayerMap;
export const LAYER_ROLES: LayerRole[] = [
  'exteriorFace',
  'interiorFace',
  'partitionFaces',
  'doors',
  'windows',
  'labels',
];

export interface LayerReport {
  layer: string;
  entities: number;
  /** Entity counts by DXF type, for the census a person reads. */
  types: Record<string, number>;
  /** Extent in metres. */
  width: number;
  height: number;
  /** Total length of its axis-aligned segments — how much wall it could possibly describe. */
  length: number;
  /** Walls its own runs pair into, and their median thickness. A layer that pairs with itself is
   *  carrying both faces, which is the case no amount of renaming fixes. */
  selfPaired: number;
  thickness: number;
  /** 0..1 per role, best first in `ranked`. */
  scores: Partial<Record<LayerRole, number>>;
  ranked: LayerRole[];
  /** The role this layer was assigned, if any. */
  role?: LayerRole;
}
export interface LayerDetection {
  /** Ready to hand to importPlanEntities. Roles nothing matched are left at the Vertex default. */
  suggested: PlanLayerMap;
  layers: LayerReport[];
  /** Roles no layer could be found for — the ones worth asking a person about. */
  missing: LayerRole[];
}

/** A regex matching exactly this layer. Layer names carry underscores, dots and accented letters. */
export const layerPattern = (...names: string[]) =>
  new RegExp(`^(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

const NAME_HINTS: Record<LayerRole, RegExp> = {
  exteriorFace: /ULKO|EXT|OUTER|A-WALL-EXTR/i,
  interiorFace: /SIS[ÄA]PINTA|INNER|INTERIOR/i,
  partitionFaces: /V[ÄA]LISEIN|PARTITION|SEIN[ÄA]|WALL/i,
  doors: /\bOVI|OVET|DOOR|A-DOOR/i,
  windows: /IKKUNA|WINDOW|A-GLAZ/i,
  labels: /HUONE|ROOM|TUNNUS|NAME|A-AREA-IDEN/i,
};

const hint = (r: { layer: string }, role: LayerRole) => (NAME_HINTS[role].test(r.layer) ? 0.25 : 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/** Read every layer's shape, then score each against the six roles. */
export function detectLayers(entities: PlanEntity[]): LayerDetection {
  const byLayer = new Map<string, PlanEntity[]>();
  for (const e of entities) {
    const list = byLayer.get(e.layer) ?? [];
    list.push(e);
    byLayer.set(e.layer, list);
  }

  const reports: LayerReport[] = [];
  for (const [layer, group] of byLayer) {
    const types: Record<string, number> = {};
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const e of group) {
      types[e.type] = (types[e.type] ?? 0) + 1;
      for (const p of [e.a, e.b, e.at, e.center, ...(e.points ?? [])])
        if (p) {
          x0 = Math.min(x0, p[0]);
          y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]);
          y1 = Math.max(y1, p[1]);
        }
    }
    const segs = faceSegments(group, /.*/);
    const runs = mergeRuns(segs, 4.6, [0.6, 4.6]);
    const paired = pairWalls(runs, runs, 0.04, 0.7, 0.5, 'either');
    reports.push({
      layer,
      entities: group.length,
      types,
      width: Number.isFinite(x0) ? x1 - x0 : 0,
      height: Number.isFinite(y0) ? y1 - y0 : 0,
      length: segs.reduce((s, x) => s + (x.hi - x.lo), 0),
      selfPaired: paired.length,
      thickness: median(paired.map(w => w.thickness)),
      scores: {},
      ranked: [],
    });
  }

  // Wall faces are not found by length — furniture and title blocks have plenty. They are found by
  // PAIRING: a wall is drawn as two parallel faces a plausible thickness apart, and the outer walls
  // of a storey close into a loop. Trying every pair of layers and keeping the pairings that trace a
  // ring is what tells a wall layer from a row of kitchen cabinets, which pair happily and close
  // into nothing.
  const segs = new Map<string, FaceSegment[]>(reports.map(r => [r.layer, faceSegments(byLayer.get(r.layer)!, /.*/)]));
  const ringArea = (ring: [number, number][]) =>
    Math.abs(
      ring.reduce((sum, p, i) => {
        const q = ring[(i + 1) % ring.length];
        return sum + p[0] * q[1] - q[0] * p[1];
      }, 0) / 2,
    );
  const envelopeOf = (a: string, b: string) => {
    const pool = a === b ? segs.get(a)! : [...segs.get(a)!, ...segs.get(b)!];
    if (pool.length < 4) return null;
    const runs = mergeRuns(pool, 4.6, [0.6, 4.6]).filter(r => r.hi - r.lo > 0.8);
    // The same window reconstructWalls uses for the envelope. Opening it wider lets a face pair with
    // the line drawn a few millimetres beside it — a sheathing line, a hatch edge — instead of with
    // the face across the wall, and the thin walls that come out do not close into anything.
    const walls: Wall[] = pairWalls(runs, runs, 0.15, 0.7, 0.8, 'either');
    if (walls.length < 4) return null;
    const copy = walls.map(w => ({ ...w, gaps: w.gaps.map(g => [...g] as [number, number]) }));
    closeCorners(copy);
    const ring = traceRing(copy);
    if (!ring) return null;
    return {
      walls: copy,
      ring,
      area: ringArea(ring as [number, number][]),
      thickness: median(copy.map(w => w.thickness)),
    };
  };

  const faceish = reports.filter(r => r.length > 2 && (r.types.LINE || r.types.POLYLINE));
  const rings: { a: string; b: string; area: number; thickness: number; ring: [number, number][] }[] = [];
  for (let i = 0; i < faceish.length; i++)
    for (let j = i; j < faceish.length; j++) {
      const found = envelopeOf(faceish[i].layer, faceish[j].layer);
      if (found)
        rings.push({
          a: faceish[i].layer,
          b: faceish[j].layer,
          area: found.area,
          thickness: found.thickness,
          ring: found.ring as [number, number][],
        });
    }
  // Every pairing that closes traces very nearly the same outline — they differ by which line of the
  // wall each took, a few centimetres apart, so area alone cannot choose between them. What separates
  // the true faces from a hatch edge or a stud line is thickness: the outer wall is the thickest
  // thing on the plan. Take the biggest outlines, then the thickest wall among them.
  const widest = Math.max(0, ...rings.map(r => r.area));
  const envelope = rings.filter(r => r.area >= widest * 0.9).sort((x, y) => y.thickness - x.thickness)[0] ?? null;

  const chosen = new Map<LayerRole, string>();
  if (envelope) {
    chosen.set('exteriorFace', envelope.a);
    chosen.set('interiorFace', envelope.b); // equal to `a` when one layer carries both faces
  }
  const ring = envelope?.ring;
  const within = (r: LayerReport) => {
    if (!ring) return true;
    const xs = ring.map(p => p[0]),
      ys = ring.map(p => p[1]);
    const pad = 2;
    return r.width <= Math.max(...xs) - Math.min(...xs) + pad && r.height <= Math.max(...ys) - Math.min(...ys) + pad;
  };
  const planLength = envelope ? Math.max(...faceish.map(r => r.length)) : 1;

  for (const r of reports) {
    const total = Math.max(1, r.entities);
    const text = (r.types.TEXT ?? 0) / total;
    const arcs = (r.types.ARC ?? 0) / total;
    const s = r.scores;
    // Labels: text standing inside the plan, not the sheet's own annotation blocks.
    if (r.types.TEXT && text > 0.6 && within(r)) s.labels = 0.5 * text + 0.2 + hint(r, 'labels');
    // Doors: a swing arc beside a pair of short lines is unmistakable whatever the layer is called.
    if ((arcs > 0.02 || NAME_HINTS.doors.test(r.layer)) && within(r))
      s.doors = 0.4 * Math.min(1, arcs * 6) + 0.2 + hint(r, 'doors');
    // Windows: parallel bundles with no arcs, spread along the envelope but adding up to far less
    // wall than a face layer does.
    if (!r.types.ARC && r.length > 0.5 && r.length < planLength * 0.6 && within(r) && r.selfPaired > 0)
      s.windows = 0.25 + 0.15 * Math.min(1, r.selfPaired / 8) + hint(r, 'windows');
    // Partitions: layers that pair into walls of their own, inside the envelope, but do not close a
    // loop the size of the building.
    if (r.selfPaired >= 2 && r.thickness > 0.03 && r.thickness < 0.4 && within(r))
      s.partitionFaces = 0.3 + 0.2 * Math.min(1, r.selfPaired / 10) + hint(r, 'partitionFaces');
    r.ranked = (Object.keys(s) as LayerRole[]).sort((a, b) => (s[b] ?? 0) - (s[a] ?? 0));
  }
  for (const layer of chosen.values()) {
    const r = reports.find(x => x.layer === layer);
    if (r) r.role = r.role ?? (layer === chosen.get('exteriorFace') ? 'exteriorFace' : 'interiorFace');
  }

  // Assign the rest, strongest claim first, so a layer that is clearly a door layer is not spent on
  // being a mediocre partition layer.
  const claims = LAYER_ROLES.filter(role => !chosen.has(role))
    .flatMap(role => reports.map(r => ({ role, r, score: r.scores[role] ?? 0 })).filter(c => c.score > 0.2))
    .sort((a, b) => b.score - a.score);
  const taken = new Set<string>(chosen.values());
  for (const c of claims) {
    if (chosen.has(c.role) || taken.has(c.r.layer)) continue;
    chosen.set(c.role, c.r.layer);
    taken.add(c.r.layer);
    c.r.role = c.role;
  }

  const suggested: PlanLayerMap = { ...DEFAULTS };
  for (const [role, layer] of chosen) suggested[role] = layerPattern(layer);
  return {
    suggested,
    layers: reports.sort((a, b) => b.entities - a.entities),
    missing: LAYER_ROLES.filter(role => !chosen.has(role)),
  };
}

// Falling back to the Vertex names for a role nothing matched is better than falling back to
// nothing: on a Vertex drawing with one odd layer, the other five still work.
const DEFAULTS: PlanLayerMap = {
  exteriorFace: /^12_/,
  interiorFace: /^13_/,
  partitionFaces: /^(186_|196_)/,
  doors: /^27_/,
  windows: /^26_/,
  labels: /^55_/,
};
