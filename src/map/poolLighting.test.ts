import { describe, expect, it } from 'vitest';
import { createBackrooms } from '../../app/demo/backrooms';
import { poolBounces } from './poolLighting';
import { floorArrival } from './walkSurfaces';
import { inSpace } from '../model/spaces';

describe('pool lighting and floor arrival', () => {
  const project = createBackrooms();
  const floor = 'backrooms-pool-0';
  it('lights the arrival and connecting chambers from submerged fittings only', () => {
    const bounces = poolBounces(project, floor);
    const rooms = project.objects.filter(o => o.floorId === floor && o.kind === 'room');
    expect(bounces).toHaveLength(rooms.length);
    expect(bounces.some(b => !b.pool && b.strength > 0)).toBe(true);
    const arrival = floorArrival(project, floor, [70, 70]);
    const source = bounces.find(b => inSpace(b.room, arrival));
    expect(source?.pool?.name).toBe('Arrival reflecting pool');
    expect(project.objects.some(o => o.floorId === floor && o.water && inSpace(o, arrival))).toBe(false);
    const dark = structuredClone(project);
    for (const o of dark.objects) if (o.light) o.light.intensity = 0;
    expect(poolBounces(dark, floor)).toEqual([]);
  });
  it('does not transmit reflected pool light through sealed walls', () => {
    const sealed = structuredClone(project);
    sealed.portals = [];
    expect(poolBounces(sealed, floor).every(b => b.pool)).toBe(true);
    sealed.portals = project.portals?.map(p => ({ ...p, passage: 'none' }));
    expect(poolBounces(sealed, floor).every(b => b.pool)).toBe(true);
  });
  it('preserves supported positions when changing floor, including a fall landing', () => {
    const at: [number, number] = [2, 0];
    expect(floorArrival(project, floor, at)).toBe(at);
  });
});
