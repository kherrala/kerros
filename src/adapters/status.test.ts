import { describe, expect, it } from 'vitest';
import { statusLabel, statusTone, unknownStatus } from './status';
import type { StatusReading } from '../model/live';

const at = (tone: StatusReading['tone'], label: string, now: number): StatusReading => ({
  feedId: 'd',
  tone,
  label,
  timestamp: now,
});

describe('status interpretation', () => {
  const now = 1_788_700_000_000;
  it('keeps unknown distinguishable from a normal reading', () => {
    expect(statusTone(undefined, now)).toBe('unknown');
    expect(statusTone(unknownStatus('d'), now)).toBe('unknown');
    expect(statusTone(at('normal', 'Online', now), now)).toBe('normal');
  });
  it('passes through the host tone and label', () => {
    expect(statusTone(at('critical', 'Forced open', now), now)).toBe('critical');
    expect(statusLabel(at('critical', 'Burglar alarm', now), now)).toBe('Burglar alarm');
    expect(statusLabel(at('normal', 'Secured', now), now)).toBe('Secured');
    expect(statusLabel(undefined, now)).toBe('Not connected');
  });
  it('derives staleness from the timestamp (the one thing a silent feed cannot report)', () => {
    // A normal reading older than 30 s reads as a warning with a Stale label — even without new data.
    expect(statusTone(at('normal', 'Online', now - 60_000), now)).toBe('warning');
    expect(statusLabel(at('normal', 'Online', now - 60_000), now)).toBe('Stale data');
    // A critical reading stays critical even when stale (it outranks staleness).
    expect(statusTone(at('critical', 'Forced open', now - 60_000), now)).toBe('critical');
    expect(statusLabel(at('critical', 'Forced open', now - 60_000), now)).toBe('Forced open');
  });
});
