import type { StatusReading, StatusTone } from '../model/live';
// Pure interpretation helpers for a StatusReading — part of the viewer contract. The only judgement
// the library makes is timestamp-based staleness (a silent feed can't report its own staleness);
// everything else is the host-authored tone/label passed straight through.
const STALE_MS = 30_000;
export const unknownStatus = (feedId: string): StatusReading => ({
  feedId,
  tone: 'unknown',
  label: 'Unknown',
  timestamp: 0,
});
export function statusTone(status?: StatusReading, now = Date.now()): StatusTone {
  if (!status) return 'unknown';
  if (status.tone === 'critical') return 'critical';
  if (status.timestamp && now - status.timestamp > STALE_MS) return 'warning';
  return status.tone;
}
export function statusLabel(status?: StatusReading, now = Date.now()): string {
  if (!status) return 'Not connected';
  if (status.tone === 'critical') return status.label;
  if (status.timestamp && now - status.timestamp > STALE_MS) return 'Stale data';
  return status.label;
}
