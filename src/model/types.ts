import type { ExteriorPreset } from './materials';

export type Point = [number, number];
/** Geographic anchor of the local tangent frame — [lng, lat] in WGS84 degrees; an optional third
 * element rotates the site clockwise from true north (degrees). */
export type Origin = [number, number] | [number, number, number];
export type Ring = Point[];
/** The built-in taxonomy of drawable things, spanning the toolkit's use-cases (spaces, openings,
 * devices, logistics, safety). It is intentionally broad rather than tied to one domain; model
 * host-specific subtypes (e.g. a turnstile variety, a sensor class) as `category`/`metadata` on the
 * object rather than by extending this union. Runtime tuple so the type and the document validator
 * share one source of truth. */
export const OBJECT_KINDS = [
  'zone',
  'room',
  'parcel',
  'building',
  'office',
  'container',
  'storage',
  'door',
  'window',
  'gate',
  'turnstile',
  'reader',
  'camera',
  'elevator',
  'stairs',
  'poi',
  'fixture',
  'landscape',
  'sensor',
  'alarm',
  'equipment',
  'evacuation',
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];
export type MaterialKind = 'brick' | 'stone' | 'plaster' | 'timber' | 'oak' | 'tile' | 'grass' | 'paving';
export type ModelKind =
  | 'bed'
  | 'sofa'
  | 'dining'
  | 'cabinet'
  | 'counter'
  | 'toilet'
  | 'basin'
  | 'shower'
  | 'sauna'
  | 'tree'
  | 'shrub'
  | 'lamp'
  | 'car'
  | 'chimney'
  | 'post';
export interface RoofSection {
  footprint: Ring;
  ridge: [Point, Point];
  eave: number;
  peak: number;
}
export interface BuildingRoof {
  floorId: string;
  color: string;
  sections: RoofSection[];
}
/** mezzanine marks an intermediate (entresol) level: the plan draws it in context of the levels around it. */
export interface Floor {
  id: string;
  buildingId: string;
  name: string;
  elevation: number;
  height: number;
  mezzanine?: boolean;
  code?: string;
}
export interface Building {
  id: string;
  name: string;
  roof?: BuildingRoof;
  /** Provenance id of the basemap footprint a building was adopted from — the value of the host's
   * configured footprints.idField (a string or number, depending on the tile source); absent for
   * hand-drawn buildings. */
  sourceId?: string | number;
  exteriorPreset?: ExteriorPreset;
}
export interface Junction {
  id: string;
  floorId: string | null;
  position: Point;
}
export interface Barrier {
  id: string;
  floorId: string | null;
  startId: string;
  endId: string;
  kind: 'wall' | 'fence';
  thickness: number;
  height: number;
  name: string;
  color?: string;
  material?: MaterialKind;
  category?: string;
  metadata?: Record<string, unknown>;
}
/** A sloped area: the footprint falls linearly from `high` at `axis[0]` to `low` at `axis[1]`, and
 * stays flat beyond either end — so a footprint longer than its axis keeps level aprons where it
 * meets the decks it joins. Elevations are absolute metres in the same frame as Floor.elevation, so a
 * ramp can span floors (a garage ramp, a loading incline, a sloped plaza). Any area object may carry
 * one; without it an area is flat. The axis always runs downhill: `high` >= `low`. */
export interface Slope {
  axis: [Point, Point];
  high: number;
  low: number;
}
export interface SiteObject {
  id: string;
  kind: ObjectKind;
  floorId: string | null;
  name: string;
  position: Point;
  rotation: number;
  rings?: Ring[];
  /** Makes this area a sloped plane rather than a flat plate; see Slope. */
  slope?: Slope;
  width: number;
  depth: number;
  height: number;
  parentId?: string;
  barrierId?: string;
  offset?: number;
  feedId?: string;
  symbol?:
    | 'personnel'
    | 'service'
    | 'driveway'
    | 'parking'
    | 'assembly'
    | 'info'
    | 'aed'
    | 'extinguisher'
    | 'firstaid'
    | 'exit'
    | 'firealarm';
  servedFloorIds?: string[];
  coverageAngle?: number;
  coverageRange?: number;
  color?: string;
  /** Camera: ids of the doors, rooms and elevators this camera observes (event footage lookup). */
  watchedIds?: string[];
  material?: MaterialKind;
  model?: ModelKind;
  /** Host-defined subtype/category (e.g. 'meeting-room', 'speedgate', 'cold-store') for styling, filtering and event handlers. */
  category?: string;
  /** Arbitrary host metadata; ignored by the core, available to style hooks and event handlers. */
  metadata?: Record<string, unknown>;
}
export interface Drawing {
  id: string;
  floorId: string | null;
  assetId: string;
  name: string;
  width: number;
  height: number;
  origin: Point;
  scale: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
}
/** A named set of spaces — the area objects listed in `spaceIds`.
 *
 *  A zone is a *membership*, not a shape: it has no geometry of its own, which is exactly what lets it
 *  span floors, skip buildings, and overlap other zones freely. (Contrast `SiteObject.parentId`, which
 *  is the strict single-parent, same-floor, geometrically-contained tree.) A lift shaft is a zone of
 *  its per-floor lift spaces; a security area is a zone of the rooms inside it. */
export interface Zone {
  id: string;
  name: string;
  spaceIds: string[];
  /** Zones may contain zones: a DAG, not a tree. Cycles are rejected; several parents are fine.
   *  Membership does NOT imply access inheritance — that is policy, and policy is the host's. */
  childZoneIds?: string[];
  /** How the spaces within this zone reach each other, when they are not joined by portals.
   *  'all'      — every space mutually reachable: a lift serving all of its landings.
   *  'adjacent' — reachable in elevation order, both ways: a stair, passing each level in turn.
   *  'up'/'down'— adjacent but one-way: an escalator, which carries you in a single direction.
   *  omitted    — no implied connectivity; the zone is a grouping only. */
  connects?: 'all' | 'adjacent' | 'up' | 'down';
  /** Host vocabulary ('security', 'evacuation', 'hvac', …). The core never interprets it. */
  purpose?: string;
  metadata?: Record<string, unknown>;
}
/** A traversable connection between exactly two spaces.
 *
 *  Direction is deliberately not baked in: a door's entry and exit sides are relative to whichever
 *  area you are asking about, so the two sides are stored symmetrically and direction is derived
 *  (see `entryInto`). Applications that attach a rule per direction of travel split a two-way door into
 *  two objects; that is the right shape for an application layer and the wrong shape for a topology one. */
export interface Portal {
  id: string;
  /** The opening object (door/gate/turnstile) crossed here; absent for a virtual portal — an open
   *  boundary between two spaces with no physical separator, which malls and open-plan floors need.
   *  Kept as a reference rather than folded in, so two portals can be known to share one door leaf. */
  openingId?: string;
  /** The two sides. Order is storage, not meaning — ask `entryInto` rather than reading it. */
  a: string;
  b: string;
  /** Which way passage is possible at all. Default 'both'. */
  passage?: 'both' | 'a-to-b' | 'b-to-a' | 'none';
  /** How far a crossing here can be trusted to have actually happened.
   *  'confirmed' — a sensor saw it (a door monitor opening and closing).
   *  'assumed'   — inferred from a grant; nobody watched. The default for a plain door.
   *  'none'      — the crossing is a *request*, not an event: a lift floor button, where the
   *                passenger may go anywhere. Anything counting crossings must ignore these. */
  attests?: 'confirmed' | 'assumed' | 'none';
  name?: string;
  metadata?: Record<string, unknown>;
}
/** An explicit set of portals, for sets that are not a zone boundary — "all loading-bay shutters",
 *  "every door with a reader". Where a set *is* a zone boundary, derive it instead: see `perimeter`. */
export interface PortalGroup {
  id: string;
  name: string;
  portalIds: string[];
  metadata?: Record<string, unknown>;
}
/** Authored route-graph node for indoor navigation. objectId binds it to a SiteObject (door, elevator, stairs, room, poi) so routing can anchor at that object and instructions can name it. */
export interface NavNode {
  id: string;
  floorId: string | null;
  position: Point;
  objectId?: string;
}
export type NavEdgeKind = 'walk' | 'door' | 'stairs' | 'elevator';
/** Undirected route-graph edge. walk stays on one floor; door stays on one floor or steps outside (one end floorId null); stairs/elevator join different floors and bind the serving object via objectId. weight overrides the derived metres-equivalent cost. */
export interface NavEdge {
  id: string;
  kind: NavEdgeKind;
  aId: string;
  bId: string;
  /** Passable from `aId` to `bId` only. Escalators and one-way doors; absent means both ways. */
  directed?: boolean;
  objectId?: string;
  weight?: number;
}
export interface ProjectDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  origin: Origin;
  datum: string;
  buildings: Building[];
  floors: Floor[];
  junctions: Junction[];
  barriers: Barrier[];
  objects: SiteObject[];
  drawings: Drawing[];
  referenceNote?: string;
  /** The floor a viewer should open on — the document's own front door, so a project that is really
   *  about its offices does not always land on the street. `null` means the outdoor site; omit it
   *  entirely to let the viewer pick (ground floor, else the lowest). Hosts can still override per
   *  session via ViewState.floor / FloorViewer's `floorId`. */
  initialFloorId?: string | null;
  /** The spatial ontology layered over the geometry: which spaces group together, and what connects
   *  to what. Spaces themselves are the ringed area objects in `objects` — nothing is duplicated. */
  zones?: Zone[];
  portals?: Portal[];
  portalGroups?: PortalGroup[];
  /** Optional authored navigation graph. When absent, the graph is derived from spaces and portals
   *  (see model/topology.ts) — the plan is then the single source of truth and cannot drift out of
   *  step with a hand-kept copy of itself. */
  navNodes?: NavNode[];
  navEdges?: NavEdge[];
}
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}
export interface ProjectRepository {
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<ProjectDocument | null>;
  save(project: ProjectDocument): Promise<void>;
  delete(id: string): Promise<void>;
}
export interface AssetRepository {
  get(id: string): Promise<Blob | undefined>;
  put(id: string, asset: Blob): Promise<void>;
  delete(id: string): Promise<void>;
}
export type Tool =
  | 'select'
  | 'pan'
  | 'wall'
  | 'partition'
  | 'fence'
  | 'zone'
  | 'room'
  | 'rectangle'
  | 'enclose'
  | 'hole'
  | 'door'
  | 'window'
  | 'gate'
  | 'turnstile'
  | 'reader'
  | 'camera'
  | 'elevator'
  | 'stairs'
  | 'office'
  | 'container'
  | 'storage'
  | 'poi'
  | 'measure'
  | 'adopt'
  | 'split'
  | 'route'
  | 'sensor'
  | 'alarm'
  | 'equipment'
  | 'evacuation';
/** A fresh entity id. A bare UUIDv4 (no type prefix) so ids drop straight into a database `uuid`
 * column and validate there; the entity's type is already given by which collection it lives in. */
export const uid = () => crypto.randomUUID();
export const isArea = (kind: ObjectKind) =>
  ['zone', 'room', 'parcel', 'building', 'office', 'container', 'storage', 'evacuation'].includes(kind);
export const isDevice = (kind: ObjectKind) =>
  ['door', 'gate', 'turnstile', 'reader', 'camera', 'elevator', 'sensor', 'alarm', 'equipment'].includes(kind);
export const isOpening = (kind: ObjectKind) => kind === 'door' || kind === 'window' || kind === 'gate';
/** A *space* is somewhere you can stand — the unit the ontology groups and connects. Areas qualify,
 *  and so do lifts and stairs: the inside of a car is as much a place as the lobby it opens onto, and
 *  the through-car case depends on being able to say so. */
export const isSpace = (kind: ObjectKind) => isArea(kind) || kind === 'elevator' || kind === 'stairs';
