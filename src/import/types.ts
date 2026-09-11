// The plan-import contract: what a normalized drawing entity looks like, which layers mean what,
// and what an import reports back. Everything here is data; the geometry lives in runs.ts/walls.ts
// and the orchestration in planImport.ts.
import type { Point } from '../schema';

/** One normalized drawing entity, coordinates in metres. The shape scripts/plan-import/extract.mjs
 *  emits with `--expand --units m`; hosts producing entities elsewhere target this. */
export interface PlanEntity {
  type: 'LINE' | 'POLYLINE' | 'ARC' | 'CIRCLE' | 'TEXT' | 'INSERT' | 'DIMENSION' | 'POINT';
  layer: string;
  a?: Point;
  b?: Point;
  points?: Point[];
  closed?: boolean;
  center?: Point;
  r?: number;
  start?: number;
  end?: number;
  at?: Point;
  text?: string;
  h?: number;
  block?: string;
  rotation?: number;
}

/** Which layers carry what. Defaults are the Vertex-style numbered taxonomy; override per source. */
export interface PlanLayerMap {
  /** Outside face of the building envelope. */
  exteriorFace: RegExp;
  /** Inside face of the envelope — also the outline the interior plate is traced from. */
  interiorFace: RegExp;
  /** Interior wall face layers; each wall is a pair of parallel runs within these. */
  partitionFaces: RegExp;
  /** Door symbol geometry (leaves, swings). Decides whether a wall gap is a doorway. */
  doors: RegExp;
  /** Window symbol geometry. Decides whether a wall gap is a window. */
  windows: RegExp;
  /** Room label texts. Area figures (pure numbers) are ignored automatically. */
  labels: RegExp;
}
export const VERTEX_LAYERS: PlanLayerMap = {
  exteriorFace: /^12_/,
  interiorFace: /^13_/,
  partitionFaces: /^(186_|196_)/,
  doors: /^27_/,
  windows: /^26_/,
  labels: /^55_/,
};

export interface PlanImportOptions {
  floorId: string | null;
  layers?: PlanLayerMap;
}
export interface PlanImportReport {
  walls: number;
  rooms: number;
  doors: number;
  windows: number;
  /** Doorless openings — stretches where the wall was split rather than sealed. */
  passages: number;
  named: number;
  /** Things the drawing suggested but the import declined, each with the reason. */
  skipped: string[];
}
