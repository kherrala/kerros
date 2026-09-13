import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalkJourney, type WalkJourneyHost } from './walkJourney';
import { newProject } from '../model/testFixtures';
import { createObject } from '../model/factory';
import { addNavEdge, addNavNode, findRoute } from '../model/navigation';
import type { StatusReading } from '../model/live';
import type { Point } from '../model/types';
import { elevatorLanding } from './elevators';

afterEach(() => vi.useRealTimers());
function setup() {
  const project = newProject();
  project.floors.push({ ...project.floors[0], id: 'upper', elevation: 4 });
  const lift = createObject('elevator', [0, 0], 'floor-ground', 'Lift A');
  Object.assign(lift, { id: 'lift', feedId: 'car', width: 2.4, depth: 2.8, servedFloorIds: ['floor-ground', 'upper'] });
  project.objects.push(lift);
  const nodes = ['floor-ground', 'upper'].map(floor => addNavNode(project, floor, elevatorLanding(lift), lift.id));
  addNavEdge(project, 'elevator', nodes[0], nodes[1], lift.id);
  const route = findRoute(
    project,
    { floorId: 'floor-ground', position: elevatorLanding(lift) },
    { floorId: 'upper', position: elevatorLanding(lift) },
  )!;
  let at: Point = elevatorLanding(lift),
    floor: string | null = 'floor-ground';
  let reading: StatusReading = {
    feedId: 'car',
    tone: 'normal',
    label: 'Standing',
    carFloorId: 'upper',
    open: false,
    moving: false,
  };
  const events: string[] = [];
  const controls = {
    statuses: [reading],
    call: (_id: string, target: string) => {
      events.push(`call:${target}`);
      reading = { ...reading, open: false, moving: true, targetFloorId: target };
      setTimeout(() => {
        reading = { ...reading, carFloorId: target, open: true, moving: false, targetFloorId: undefined };
      }, 200);
    },
    hold: () => {},
  };
  const host: WalkJourneyHost = {
    project,
    floor: () => floor,
    position: () => at,
    controls: () => controls,
    status: () => reading,
    changeFloor: async id => {
      events.push(`floor:${id}`);
      floor = id;
    },
    walk: async points => {
      const target = points.at(-1)!;
      if (target === lift.position) {
        expect(reading).toMatchObject({ carFloorId: floor, open: true, moving: false });
        events.push('board');
      } else if (at === lift.position) {
        expect(reading).toMatchObject({ carFloorId: floor, open: true, moving: false });
        events.push('exit');
      }
      at = target;
    },
    ride: id => events.push(`rider:${id}`),
    message: () => {},
    step: () => {},
  };
  return { host, route, events };
}

describe('passenger route playback', () => {
  it('calls, waits, boards, requests the destination and waits before exiting', async () => {
    vi.useFakeTimers();
    const { host, route, events } = setup();
    const done = new WalkJourney(host).play(route);
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toEqual(['call:floor-ground']);
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual(['call:floor-ground', 'board', 'rider:lift', 'call:upper']);
    expect(host.floor()).toBe('floor-ground');
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(events).toEqual([
      'call:floor-ground',
      'board',
      'rider:lift',
      'call:upper',
      'floor:upper',
      'exit',
      'rider:null',
    ]);
  });
  it('cancels a pending call without boarding or requesting another trip', async () => {
    vi.useFakeTimers();
    const { host, route, events } = setup(),
      journey = new WalkJourney(host);
    const done = journey.play(route).catch(error => error.message);
    await vi.advanceTimersByTimeAsync(100);
    journey.stop();
    expect(await done).toMatch(/stopped/);
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual(['call:floor-ground']);
  });
  it('does not teleport through an elevator without host controls', async () => {
    const { host, route } = setup();
    host.controls = () => undefined;
    await expect(new WalkJourney(host).play(route)).rejects.toThrow(/Connect elevator controls/);
    expect(host.floor()).toBe('floor-ground');
  });
});
