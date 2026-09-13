import { describe, expect, it } from 'vitest';
import { ambienceAt, AMBIENCES } from './ambience';
import { AMBIENCE_PRESETS, type ProjectDocument } from '../model/types';
import { createDemo } from '../../app/demo/demo';
import { validateProject } from '../model/validate';

describe('what a point on a floor sounds like', () => {
  const project = createDemo() as ProjectDocument;
  const floor = project.floors[0];
  const room = project.objects.find(o => o.kind === 'room' && o.floorId === floor.id && o.rings?.length)!;
  const inside = room.rings![0].reduce<[number, number]>(
    (c, p, _, ring) => [c[0] + p[0] / ring.length, c[1] + p[1] / ring.length],
    [0, 0],
  );

  it('is silence unless somebody says otherwise', () => {
    expect(ambienceAt(project, floor.id, inside)).toBeNull();
  });

  it('takes the floor as the default and the room as the last word', () => {
    const humming = {
      ...project,
      floors: project.floors.map(f => (f.id === floor.id ? { ...f, ambience: { preset: 'office' as const } } : f)),
    };
    expect(ambienceAt(humming, floor.id, inside)?.preset).toBe('office');
    const quietRoom = {
      ...humming,
      objects: humming.objects.map(o => (o.id === room.id ? { ...o, ambience: { preset: 'silent' as const } } : o)),
    };
    // A silent room on a humming floor is silent, not "no opinion".
    expect(ambienceAt(quietRoom, floor.id, inside)).toBeNull();
    const loudRoom = {
      ...humming,
      objects: humming.objects.map(o =>
        o.id === room.id ? { ...o, ambience: { preset: 'plant' as const, level: 0.5 } } : o,
      ),
    };
    expect(ambienceAt(loudRoom, floor.id, inside)).toEqual({ preset: 'plant', level: 0.5 });
  });

  it('offers every preset the document allows, and nothing else', () => {
    expect(AMBIENCES.map(a => a.id).sort()).toEqual([...AMBIENCE_PRESETS].sort());
  });

  it('preserves bath music and its level through a document round trip', () => {
    const musical = {
      ...project,
      floors: project.floors.map(f =>
        f.id === floor.id ? { ...f, ambience: { preset: 'baths' as const, level: 0.55 } } : f,
      ),
    };
    const restored = validateProject(JSON.parse(JSON.stringify(musical)));
    expect(ambienceAt(restored, floor.id, inside)).toEqual({ preset: 'baths', level: 0.55 });
  });

  it('is validated with the rest of the document', () => {
    const bad = { ...project, floors: project.floors.map(f => ({ ...f, ambience: { preset: 'disco' as never } })) };
    expect(() => validateProject(bad)).toThrow(/ambience/);
    const loud = {
      ...project,
      floors: project.floors.map(f => ({ ...f, ambience: { preset: 'office' as const, level: 2 } })),
    };
    expect(() => validateProject(loud)).toThrow(/ambience/);
  });
});
