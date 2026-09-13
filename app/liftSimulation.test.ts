import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackrooms } from './demo/backrooms';
import { lifts, LiftSimulation } from './liftSimulation';
import { elevatorWalls, insideElevator } from '../src/map/elevators';
import { unstick } from '../src/map/walk';

afterEach(() => vi.useRealTimers());
describe('passenger elevator sequencing', () => {
  const project = createBackrooms(),
    banks = lifts(project),
    id = banks[0].object.feedId!;
  const bottom = banks[0].floors.at(-1)!.id,
    next = banks[0].floors.at(-2)!.id;
  it('closes before travel, reports arrival before opening, and refuses mid-flight commands', () => {
    vi.useFakeTimers();
    const sim = new LiftSimulation(banks, () => {});
    sim.call(id, next);
    expect(sim.state.get(id)).toMatchObject({ carFloorId: bottom, open: false, phase: 'closing' });
    vi.advanceTimersByTime(450);
    expect(sim.state.get(id)).toMatchObject({ carFloorId: bottom, targetFloorId: next, phase: 'moving' });
    sim.hold(id, true);
    sim.call(id, bottom);
    expect(sim.state.get(id)?.targetFloorId).toBe(next);
    expect(sim.state.get(id)?.open).toBe(false);
    vi.advanceTimersByTime(850);
    expect(sim.state.get(id)).toEqual({ carFloorId: next, open: true, phase: 'opening' });
    vi.advanceTimersByTime(650);
    expect(sim.state.get(id)).toEqual({ carFloorId: next, open: true, phase: 'standing' });
    sim.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('holds doors at the current floor and keeps other cars independent', () => {
    vi.useFakeTimers();
    const other = { ...banks[0], object: { ...banks[0].object, id: 'other', feedId: 'other' } };
    const sim = new LiftSimulation([...banks, other], () => {});
    sim.call(id, next);
    sim.call('other', bottom);
    vi.advanceTimersByTime(650);
    expect(sim.state.get('other')).toMatchObject({ carFloorId: bottom, open: true, phase: 'standing' });
    expect(sim.state.get(id)?.phase).toBe('moving');
    vi.advanceTimersByTime(1300);
    expect(sim.state.get(id)?.carFloorId).toBe(next);
    expect(sim.state.get('other')?.open).toBe(true);
    sim.call(id, 'nonexistent');
    expect(sim.state.get(id)?.phase).toBe('standing');
    sim.dispose();
  });
  it('makes every served floor boardable within two seconds, including the longest call', () => {
    vi.useFakeTimers();
    for (const floor of banks[0].floors) {
      const sim = new LiftSimulation(banks, () => {});
      sim.call(id, floor.id);
      vi.advanceTimersByTime(2000);
      expect(sim.state.get(id)).toMatchObject({ carFloorId: floor.id, open: true, phase: 'standing' });
      sim.dispose();
    }
  });
  it('blocks closed doors but leaves a shoulder-width entrance to a hollow cabin', () => {
    const car = banks[0].object;
    let at: [number, number] = [-3, 2.2];
    for (let i = 0; i < 60; i++) at = unstick([at[0], at[1] - 0.04], elevatorWalls(car, false));
    expect(insideElevator(car, at)).toBe(false);
    for (let i = 0; i < 50; i++) at = unstick([at[0], at[1] - 0.04], elevatorWalls(car, true));
    expect(insideElevator(car, at)).toBe(true);
  });
});
