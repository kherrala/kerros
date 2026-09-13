// Public data-schema facade: data schema + pure document functions; no React, no MapLibre, no browser storage.
export type {
  ProjectDocument,
  ProjectSummary,
  Building,
  BuildingRoof,
  RoofSection,
  Floor,
  InteriorLight,
  LightFixture,
  Junction,
  VirtualBoundary,
  BoundaryUse,
  SpaceGeometry,
  Barrier,
  SiteObject,
  Drawing,
  Origin,
  Point,
  Ring,
  ObjectKind,
  Slope,
  MaterialKind,
  ModelKind,
  AssetRepository,
  NavNode,
  NavEdge,
  NavEdgeKind,
  Zone,
  Portal,
  PortalGroup,
} from '../model/types';
// The spatial ontology layered over the geometry, one module per concern: spaces are the area
// objects themselves (spaces), zones and portals describe what groups and connects (ontology),
// inference reads portals and divisions off the plan (inference), and the routing graph is derived
// from all of it (topology).
export { spaces, spaceAt, spacePoint, inSpace } from '../model/spaces';
export {
  entryInto,
  perimeter,
  captive,
  zoneSpaces,
  addZone,
  removeZone,
  setZoneMembers,
  nestZone,
  addPortalGroup,
  removePortalGroup,
  setPortalGroupMembers,
  pruneOntology,
} from '../model/ontology';
export {
  inferPortals,
  inferOpenBoundaries,
  refreshPortals,
  divideSpaces,
  spacesDividedBy,
  spacesRejoinedBy,
  mergeSpaces,
} from '../model/inference';
export { derivedGraph } from '../model/topology';
export { isArea, isDevice, isOpening, isSpace, uid, OBJECT_KINDS } from '../model/types';
export { createObject, emptyProject } from '../model/factory';
export { enclosedRegion, enclosedRegions, refitEnclosedRooms } from '../model/spaces';
export {
  boundaryEdges,
  boundaryRegions,
  boundaryRegionAt,
  boundaryRings,
  derivedSpaceRings,
  bindSpaceToRegion,
  followsBoundaries,
  connectSpace,
  disconnectSpace,
  addVirtualBoundary,
  drawVirtualBoundary,
  addBoundaryHole,
  normalizeBoundaries,
  refreshBoundarySpaces,
} from '../model/boundaries';
export type { BoundaryEdge, BoundaryRegion } from '../model/boundaries';
export { coverageOf, DEFAULT_RANGE, DEFAULT_FOV } from '../model/coverage';
export { copyProject, openingFloorId } from '../model/project';
export {
  MIN_SEGMENT,
  OPENING_MIN_SEGMENT,
  geoOrigin,
  moveOrigin,
  segmentsCross,
  toLngLat,
  toLocal,
  addBarrier,
  duplicateFloor,
  removeFloor,
  rectangle,
  rotate,
  centroid,
  distance,
  footprint,
  closeRing,
  openRing,
  ringArea,
  objectArea,
  pointInRing,
  objectPosition,
  objectRotation,
  barrierEnds,
  segmentProjection,
  slopeElevation,
} from '../model/geometry';
export { exportProject, importProject, parseExport, blobDataUrl } from '../model/document';
// The validity layer: every rule in one module, and the transaction gate that enforces them on
// every change. Documents in circulation are always valid — edit through transact, never in place.
export {
  validateProject,
  validateRelationships,
  validateRings,
  validateNavigation,
  transact,
  freezeProject,
  COORD_LIMIT,
} from '../model/validate';
export type { TransactResult } from '../model/validate';
// Change as data: every authoring operation as a serializable Mutation, executed through the same
// atomic gate. Log them, replay them, table-test them; a sequence applies whole or not at all.
export { applyMutation, applyMutations } from '../model/mutations';
export type { Mutation, MutationOutcome, MutationResult } from '../model/mutations';
export {
  findRoute,
  routeSteps,
  routeAnchors,
  floorPhrase,
  addNavNode,
  addNavEdge,
  navPath,
  chainVertical,
  edgeCost,
  edgeLength,
  ELEVATOR_BASE,
  ELEVATOR_PER_METRE,
  STAIR_CLIMB_FACTOR,
  DOOR_COST,
  NAV_WELD,
} from '../model/navigation';
export type { Route, RouteStep, RouteLeg, RouteOptions } from '../model/navigation';

export { EXTERIOR_PRESETS, type ExteriorPreset } from '../model/materials';

export {
  flights,
  flightsAt,
  isVertical,
  passesThrough,
  PITCH,
  pitchOf,
  primaryShafts,
  reaches,
  runFor,
  servedFloors,
  shaftKey,
  shaftVoids,
  span,
  type Flight,
} from '../model/vertical';

export { buildRoomNavigation } from '../model/roomNavigation';
export type { RoomAccess, RoomNavigationGraph } from '../model/roomNavigation';
