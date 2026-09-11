import { describe, expect, it } from 'vitest';
import {
  applyMutation,
  createObject,
  effectivePortals,
  findRoute,
  transact,
  validateProject,
  type Zone,
} from '@kerros/schema';
import type { StatusReading } from '@kerros/viewer/host';
import { connectedPlan } from '../docs/applications/connectedPlan';
import { directionalCrossings } from '../docs/applications/directionalCrossings';
import { createSnapshotFeed } from '../docs/applications/snapshotFeed';
import { addVisitArea } from '../docs/applications/visitorZone';

describe('application guide examples (public package APIs)', () => {
  it('builds connected spaces and routes through a derived open boundary', () => {
    const { project, lobby, cafe, route } = connectedPlan();
    expect(() => validateProject(project)).not.toThrow();
    expect(Object.isFrozen(project)).toBe(true);
    expect(lobby.geometry?.mode).toBe('boundaries');
    expect(cafe.geometry?.mode).toBe('boundaries');
    expect(effectivePortals(project)).toHaveLength(1);
    expect(route).not.toBeNull();
    const zone: Zone = { id: 'cafe-zone', name: 'Cafe', spaceIds: [cafe.id] };
    const crossings = directionalCrossings(project, zone);
    expect(crossings).toHaveLength(2);
    expect(crossings.every(c => c.openingId === undefined && c.attests === 'none')).toBe(true);

    const sealed = applyMutation(project, {
      kind: 'drawBarrier',
      floorId: lobby.floorId,
      a: [0, -3],
      b: [0, 3],
    });
    if (!sealed.ok) throw new Error(sealed.error);
    expect(findRoute(sealed.project, lobby.id, cafe.id)).toBeNull();
    expect(directionalCrossings(sealed.project, zone)).toEqual([]);
    expect(findRoute(project, lobby.id, cafe.id)).not.toBeNull();
  });

  it.each(['both', 'a-to-b', 'b-to-a', 'none'] as const)('projects %s consistently from adjacent zones', passage => {
    const { project, lobby, cafe } = connectedPlan();
    const changed = transact(project, draft => {
      const door = createObject('door', [0, 0], lobby.floorId, 'Door');
      draft.objects.push(door);
      draft.portals = [{ id: 'shared-door', a: lobby.id, b: cafe.id, openingId: door.id, passage, attests: 'assumed' }];
    });
    if (!changed.ok) throw new Error(changed.error);
    const a: Zone = { id: 'lobby-zone', name: 'Lobby', spaceIds: [lobby.id] };
    const b: Zone = { id: 'cafe-zone', name: 'Cafe', spaceIds: [cafe.id] };
    const fromA = directionalCrossings(changed.project, a);
    const fromB = directionalCrossings(changed.project, b);
    expect(fromA.length).toBe(passage === 'both' ? 2 : passage === 'none' ? 0 : 1);
    expect(fromB.map(c => c.key)).toEqual(fromA.map(c => c.key));
    for (const [i, crossing] of fromA.entries()) {
      expect(crossing.entering).toBe(!fromB[i].entering);
      expect(JSON.parse(crossing.key)).toEqual(['shared-door', crossing.fromSpaceId, crossing.toSpaceId]);
      expect(crossing.openingId).toBe(changed.project.portals![0].openingId);
      if (passage === 'a-to-b') expect(crossing.toSpaceId).toBe(cafe.id);
      if (passage === 'b-to-a') expect(crossing.toSpaceId).toBe(lobby.id);
    }
    // No perimeter crossing for the union, including when membership is nested.
    const union: Zone = { id: 'all', name: 'All', spaceIds: [lobby.id], childZoneIds: [b.id] };
    const nested = transact(changed.project, draft => {
      draft.zones = [b, union];
    });
    if (!nested.ok) throw new Error(nested.error);
    expect(directionalCrossings(nested.project, union)).toEqual([]);
  });

  it('creates visit membership atomically and refuses missing destinations', () => {
    const { project, lobby, cafe } = connectedPlan();
    const before = JSON.stringify(project);
    const result = addVisitArea(project, [lobby.id, cafe.id, cafe.id]);
    if (!result.ok) throw new Error(result.error);
    expect(result.project.zones![0].spaceIds).toEqual([lobby.id, cafe.id]);
    expect(addVisitArea(project, [lobby.id, 'deleted-room']).ok).toBe(false);
    expect(addVisitArea(project, []).ok).toBe(false);
    expect(JSON.stringify(project)).toBe(before);
  });

  it('publishes complete, project-filtered snapshots and unsubscribes', () => {
    const { project, lobby } = connectedPlan();
    const bound = transact(project, draft => {
      draft.objects.find(o => o.id === lobby.id)!.feedId = 'lobby-live';
    });
    if (!bound.ok) throw new Error(bound.error);
    const snapshots: StatusReading[][] = [];
    const { feed, publish } = createSnapshotFeed();
    const first: StatusReading = {
      feedId: 'lobby-live',
      label: 'One person',
      tone: 'normal',
      metrics: { occupancy: 1 },
    };
    publish([first]);
    first.label = 'Caller mutation';
    const unsubscribe = feed.subscribe(bound.project, snapshot => snapshots.push(snapshot));
    expect(snapshots[0][0].label).toBe('One person');
    publish([
      { feedId: 'unbound', label: 'Elsewhere', tone: 'normal' },
      { feedId: 'lobby-live', label: 'Earlier', tone: 'normal' },
      { feedId: 'lobby-live', label: 'Latest', tone: 'warning' },
    ]);
    expect(snapshots[1]).toEqual([{ feedId: 'lobby-live', label: 'Latest', tone: 'warning' }]);
    publish([]);
    expect(snapshots[2]).toEqual([]);
    unsubscribe();
    publish([first]);
    expect(snapshots).toHaveLength(3);
  });
});
