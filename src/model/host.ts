// Host-integration interfaces that depend on MapLibre types. Kept out of model/types.ts so the
// schema package's type graph stays framework-free (types.ts must not reach maplibre-gl); the
// viewer/editor packages, which have maplibre as a peer, re-export these from their facades.
import type { ReactNode } from 'react';
import type { StyleSpecification, RequestTransformFunction } from 'maplibre-gl';
import type { ProjectDocument, ProjectRepository, AssetRepository, SiteObject, Point } from './types';
import type { StatusFeed, StatusReading } from './live';

/** A named coordinate system a host offers for footprint import — converts the file's coordinates to
 *  lng/lat (WGS84). The core carries no projections; a host supplies these (e.g. via proj4). */
export interface ImportProjection {
  label: string;
  toLngLat(p: Point): Point;
}

/** Describes a basemap's vector-tile schema so the built-in adoption, 3D-city, cadastre and
 *  below-grade context features can read it. The library ships no schema of its own — a host names its
 *  tiles' layers/fields here (see the reference `mmlBasemap` for Finland's MML). Each part is optional;
 *  a feature is enabled only when its part is present. */
export interface BasemapVectorSchema {
  /** Building footprints — powers the adopt tool and the 3D-city massing. */
  footprints?: {
    sourceLayer: string;
    idField: string;
    /** Estimated storey count from a footprint's properties (adopt seeds this many floors). */
    storeys?: (props: Record<string, unknown>) => number;
    /** Human name for an adopted footprint from its properties. */
    name?: (props: Record<string, unknown>) => string | undefined;
    /** A MapLibre expression for the 3D extrusion height (paint can't call a JS fn); omit → flat. */
    heightExpression?: unknown;
  };
  /** Below-grade context layers (soil ghosts) drawn when viewing a basement floor. */
  context?: { waterLayer?: string; roadLayer?: string; buildingLayer?: string };
  /** Cadastral parcel overlay from a separate vector tilejson. */
  cadastre?: {
    tilejson: string;
    attribution: string;
    parcelLayer: string;
    boundaryLayer: string;
    markLayer: string;
    labelLayer: string;
    labelField: string;
    font: string;
  };
}
export interface BasemapConfig {
  style: string | StyleSpecification;
  /** Last chance to adjust the style before it is handed to the map: recolour layers, drop clutter,
   *  swap in a dusk palette. Runs for a fetched style and an inline one alike, after relative URLs
   *  have been resolved, so a host can tune a published basemap without forking and maintaining it.
   *  Mutating the argument and returning it is fine — the style is not shared. */
  styleTransform?: (style: StyleSpecification) => StyleSpecification;
  transformRequest?: RequestTransformFunction;
  /** Name shown for this basemap in the editor's map-settings picker (host-branded); defaults to "Map background". */
  label?: string;
  /** Vector-tile schema for the built-in adoption/3D-city/cadastre features (host-supplied). */
  vectorSchema?: BasemapVectorSchema;
}
export interface PlannerAdapters {
  projects: ProjectRepository;
  assets: AssetRepository;
  /** Live status readings. Optional: a host that only models premises omits it, and the editor then
   *  drops its monitoring surface entirely rather than showing an empty one. */
  status?: StatusFeed;
  basemap?: BasemapConfig;
  /** Extra coordinate systems offered in the footprint-import dialog (beyond lng/lat, always available). */
  importProjections?: ImportProjection[];
  /** Optional server-backed AI import. Credentials and tool execution belong to the host backend. */
  aiImport?: AiImportAdapter;
  /** Host-side PDF page conversion. The editor never loads a PDF parser or worker. */
  pdfDrawing?: PdfDrawingAdapter;
}
export interface PdfDrawingAdapter {
  render(file: File, page: number): Promise<Blob>;
}
export interface AiImportAdapter {
  /** Queue human instructions for the next provider turn of an already running job. */
  sendInstruction?(jobId: string, instruction: import('../import/instructions').ImportInstruction): Promise<void>;
  run(
    file: File,
    options: {
      origin: ProjectDocument['origin'];
      instructions: string;
      brief?: import('../import/brief').ImportBrief;
      base?: ProjectDocument;
      checkpoint?: import('../import/checkpoint').ImportCheckpoint;
      budget?: import('../import/checkpoint').ImportBudget;
      onCheckpoint?: (checkpoint: import('../import/checkpoint').ImportCheckpoint) => void | Promise<void>;
      onPause?: (pause: import('../import/checkpoint').ImportPause) => void | Promise<void>;
      onAnalysis?: (preview: import('../import/analysisPreview').ImportAnalysisPreview) => void | Promise<void>;
      onSession?: (jobId: string) => void | Promise<void>;
      signal: AbortSignal;
      onProgress: (event: { type: 'text' | 'tool' | 'status'; detail: string }) => void | Promise<void>;
      /** Await acceptance/persistence before consuming the next event. */
      onDocument: (document: ProjectDocument) => void | Promise<void>;
      /** Cumulative usage for this run; a continuation starts a new run. */
      onUsage?: (usage: import('../import/usage').AiTokenUsage) => void | Promise<void>;
    },
  ): Promise<ProjectDocument>;
}
/** Map camera pose. Part of ViewState; hosts persist and restore it (e.g. encoded in a deep link). */
export interface CameraState {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}
/** Camera + floor + mode snapshot — supplied via `initialView` and emitted through `onViewChange`; hosts persist it (e.g. as a deep link). */
export interface ViewState {
  floor?: string | null;
  threeD?: boolean;
  stack?: boolean;
  /** First-person walk-through. Implies threeD; stack is ignored while it is on. */
  walk?: boolean;
  camera?: CameraState;
  /** Which map background to open on: the host's basemap, or the plain drawing ground. A project
   *  that is nowhere in particular — a sample, a fiction, a plan not yet placed — has nothing to
   *  gain from the city under it and pays to draw it. Absent means the host's basemap if it has one. */
  basemap?: 'plan' | 'host';
  /** Which surface to open on. Absent means the plan viewer — right for a link someone was sent,
   *  wrong for a project the host just created or imported, where the point is to start drawing. */
  mode?: PlannerMode;
}
/** The editor's three surfaces: pure plan viewer, authoring editor, live monitoring. */
export type PlannerMode = 'view' | 'edit' | 'live';
/** Context for a host-rendered status panel in the inspector (controls, a simulator, a work-order link, …). */
export interface StatusPanelContext {
  object: SiteObject;
  status?: StatusReading;
  editing: boolean;
  live: boolean;
}
/** Optional host commands for passenger lifts. Readings stay transient; the host owns sequencing. */
export interface ElevatorControls {
  statuses: StatusReading[];
  call(feedId: string, floorId: string): void;
  hold(feedId: string, open: boolean): void;
}
export interface SitePlannerProps {
  /** The document to edit. The editor owns edits through its own history, so this is the *initial*
   *  document; pass a new one with a different `id` to load a different project (same-id updates are
   *  ignored). Observe edits via `onChange`. */
  project: ProjectDocument;
  adapters: PlannerAdapters;
  onChange?: (project: ProjectDocument) => void;
  onSelectionChange?: (id: string | null) => void;
  onBack?: () => void;
  initialView?: ViewState;
  onViewChange?: (view: ViewState) => void;
  /** Notified when the editor switches surface — a host can, e.g., start/stop its live feed's traffic. */
  onModeChange?: (mode: PlannerMode) => void;
  /** Render host-specific controls for a selected bound object (return null to show none). Keeps command/simulation vocabulary out of the library. */
  renderStatusPanel?: (ctx: StatusPanelContext) => ReactNode;
  elevators?: ElevatorControls;
}
