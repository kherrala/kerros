import { describe, expect, it } from 'vitest';
import { applyMutation, applyMutations, type Mutation } from './mutations';
import { validateProject } from './validate';
import { rectangle } from './geometry';
import { addPortal as portal, addSpace as space, newProject } from './testFixtures';
import type { Zone } from './types';

const office = () => {
  const p = newProject();
  space(p, 'lobby', 'floor-ground', [0, 0]);
  space(p, 'suite', 'floor-ground', [8, 0]);
  portal(p, 'lobby', 'suite');
  return p;
};

describe('mutations are data, executed atomically', () => {
  it('applies a mutation and returns what it created, leaving the original untouched', () => {
    const p = office();
    const before = structuredClone(p);
    const result = applyMutation(p, { kind: 'addZone', name: 'Tenancy', spaceIds: ['suite'], purpose: 'security' });
    if (!result.ok) throw new Error(result.error);
    const made = result.outcomes![0] as Zone;
    expect(made.name).toBe('Tenancy');
    expect(result.project.zones!.some(z => z.id === made.id)).toBe(true);
    expect(p, 'the input document did not move').toEqual(before);
  });
  it('applies a sequence as one transaction, or not at all', () => {
    const p = office();
    const before = structuredClone(p);
    const result = applyMutations(p, [
      { kind: 'addZone', name: 'Tenancy', spaceIds: ['suite'] },
      // Step two is invalid: a negative width can survive no transaction, so step one must not either.
      { kind: 'patchObject', objectId: 'lobby', set: { width: -1 } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Invalid project/);
    expect(result.outcomes, 'no partial outcomes on failure').toBeUndefined();
    expect(p).toEqual(before);
  });
  it('survives a JSON round-trip, because a mutation is only data', () => {
    const script: Mutation[] = [
      { kind: 'addZone', name: 'Suite zone', spaceIds: ['suite'] },
      { kind: 'patchObject', objectId: 'suite', set: { name: 'Suite 100', category: 'meeting' } },
    ];
    const replayed = JSON.parse(JSON.stringify(script)) as Mutation[];
    const result = applyMutations(office(), replayed);
    if (!result.ok) throw new Error(result.error);
    expect(result.project.objects.find(o => o.id === 'suite')!.name).toBe('Suite 100');
    expect(result.project.zones).toHaveLength(1);
  });
  it('turns a refused nesting into an error a data-shaped caller can see', () => {
    const p = office();
    const one = applyMutations(p, [
      { kind: 'addZone', name: 'One', spaceIds: ['lobby'] },
      { kind: 'addZone', name: 'Two', spaceIds: ['suite'] },
    ]);
    if (!one.ok) throw new Error(one.error);
    const [a, b] = one.outcomes as [Zone, Zone];
    const nested = applyMutation(one.project, { kind: 'nestZone', parentId: a.id, childId: b.id });
    if (!nested.ok) throw new Error(nested.error);
    const cycle = applyMutation(nested.project, { kind: 'nestZone', parentId: b.id, childId: a.id });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error).toMatch(/contain itself/);
  });
  it('seals a portal by patch, and the seal is the only change', () => {
    const p = office();
    const id = p.portals![0].id;
    const result = applyMutation(p, { kind: 'patchPortal', portalId: id, set: { passage: 'none' } });
    if (!result.ok) throw new Error(result.error);
    expect(result.project.portals![0].passage).toBe('none');
    expect(result.project.objects).toEqual(p.objects);
  });
  it('runs geometry operations through the same gate', () => {
    const p = newProject();
    space(p, 'hall', 'floor-ground', [0, 0]);
    p.objects.find(o => o.id === 'hall')!.rings = [rectangle([0, 0], 20, 10)];
    const result = applyMutation(p, { kind: 'splitRoom', roomId: 'hall', a: [0, -8], b: [0, 8] });
    if (!result.ok) throw new Error(result.error);
    expect(result.project.objects.filter(o => o.rings)).toHaveLength(2);
    expect(() => validateProject(structuredClone(result.project))).not.toThrow();
  });
  it('reports a merge of untouching spaces as the error it is', () => {
    const p = office();
    space(p, 'far', 'floor-ground', [40, 40]);
    const result = applyMutation(p, { kind: 'mergeSpaces', keepId: 'lobby', absorbedId: 'far' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nothing to merge/);
  });
  it('creates and removes objects, cascading references out with them', () => {
    const p = office();
    const made = applyMutations(p, [
      {
        kind: 'addObject',
        objectKind: 'room',
        name: 'Annex',
        position: [20, 0],
        floorId: 'floor-ground',
        set: { rings: [rectangle([20, 0], 4, 4)] },
      },
      { kind: 'addZone', name: 'Wing', spaceIds: ['suite'] },
    ]);
    if (!made.ok) throw new Error(made.error);
    const annexId = made.outcomes![0] as string;
    expect(made.project.objects.some(o => o.id === annexId)).toBe(true);
    const removed = applyMutations(made.project, [{ kind: 'removeObjects', ids: [annexId, 'suite'] }]);
    if (!removed.ok) throw new Error(removed.error);
    expect(removed.outcomes![0]).toBe(2);
    expect(removed.project.portals, 'portals to the removed space went with it').toEqual([]);
    expect(removed.project.zones![0].spaceIds).toEqual([]);
  });
});
