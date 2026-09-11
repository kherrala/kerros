// Live state for anything on the plan — transient overlay data, NOT part of the persisted document.
// Belongs to the visualization contract (viewer package), keyed to a SiteObject via feedId. What
// publishes a reading is deliberately unspecified: a door sensor, a booking system, a headcount, a
// work order. Domain-neutral:
// a host maps its own state (occupancy, environment, door state, reservations, sensors, …) onto a
// tone the viewer colours by and a human-readable label the viewer shows. Anything richer travels in
// the opaque `details` passthrough, which the library carries but never interprets.
import type { ProjectDocument } from './types';

export interface StatusMetrics {
  occupancy?: number;
  capacity?: number;
  presence?: boolean;
  co2?: number;
  lux?: number;
  temperature?: number;
}
/** Severity the viewer colours by, most-to-least urgent. Domain-neutral: `critical` is whatever the
 *  host deems an urgent condition (a security alarm, an offline sensor, an over-capacity space, …). */
export type StatusTone = 'critical' | 'warning' | 'normal' | 'unknown';
export interface StatusReading {
  feedId: string;
  /** How the viewer colours the bound object. */
  tone: StatusTone;
  /** Human-readable status text the viewer shows (host-authored). */
  label: string;
  /** Epoch-ms of the reading. Enables the viewer's staleness warning; omit to opt out. */
  timestamp?: number;
  /** Generic space/environment telemetry the viewer renders (occupancy rollups, etc.). */
  metrics?: StatusMetrics;
  /** For a door, gate or turnstile: whether the leaf is standing open right now. The plan draws it —
   *  an open leaf swings, a closed one sits in the frame. Distinct from `tone`, which says whether
   *  anyone should be worried: a door can be open and perfectly normal, or closed and in alarm.
   *  Omitted means unknown, and an unknown door is drawn with the architectural swing symbol. */
  open?: boolean;
  /** For a lift: the floor its car is standing at right now, as a floor id. The plan draws the car
   *  there and slides it when the value changes, which is the difference between a shaft and a lift
   *  you can watch. Omitted means unknown, and an unknown car rests at the lowest level it serves —
   *  where an idle lift really does wait. Sits beside `open`, which says whether its doors are
   *  standing open, for the same reason: both are what the thing is doing, not whether to worry. */
  carFloorId?: string;
  /** Opaque host state, passed through untouched — the library never reads it. */
  details?: Record<string, unknown>;
}
/** The live-status contract: a source of StatusReading snapshots keyed to SiteObjects by feedId.
 *  Deliberately minimal — just subscribe. Interactive concerns (commanding something, simulating
 *  traffic) are host-specific and belong to the host's own feed and UI, not this contract. */
export interface StatusFeed {
  subscribe(project: ProjectDocument, listener: (statuses: StatusReading[]) => void): () => void;
}
