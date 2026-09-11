import { describe, expect, it } from 'vitest';
import { findRoute, validateNavigation } from '@kerros/schema';
import { createDemo } from './demo';
import { createSilo } from './silo';

// End-to-end routing through the reference sample data — the rich topologies the compact library-unit
// fixtures deliberately don't replicate. Uses only the public @kerros/schema routing surface.
describe('routing through the demo projects', () => {
  it('routes end-to-end through the Stockmann demo graph', () => {
    const p = createDemo();
    expect(validateNavigation(p)).toBeNull();
    const main = p.objects.find(o => o.name === 'Main entrance')!;
    const office = p.objects.find(o => o.kind === 'room' && o.floorId === 'floor-08')!;
    const route = findRoute(p, main.id, office.id)!;
    expect(route).not.toBeNull();
    expect(route.steps.some(st => st.kind === 'elevator' && /level 9/.test(st.text))).toBe(true); // named lift ride up to the office floor
    expect(route.steps.at(-1)!.text).toBe(`Arrive at ${office.name}`);
  });
  it('descends the Silo to the L1 airlock in one merged staircase step', () => {
    const p = createSilo();
    expect(validateNavigation(p)).toBeNull();
    const airlock = p.objects.find(o => o.name === 'Airlock')!;
    const room = p.objects.find(o => o.kind === 'room' && o.name === 'Apartments 34')!;
    const route = findRoute(p, room.id, airlock.id)!;
    expect(route).not.toBeNull();
    const stairs = route.steps.filter(st => st.kind === 'stairs');
    expect(stairs).toHaveLength(1);
    expect(stairs[0].text).toMatch(/The Great Staircase/);
    expect(route.steps.at(-1)!.text).toBe('Arrive at Airlock');
  });
});
