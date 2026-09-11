import { describe, expect, it } from 'vitest';
import { validateProject } from './persistence';
import { newProject } from '../model/testFixtures';
import { createObject } from '../model/factory';

describe('project validation', () => {
  it('rejects unsupported schema versions and malformed documents', () => {
    expect(() => validateProject({})).toThrow(/schema version/);
    expect(() => validateProject({ ...newProject(), schemaVersion: 99 })).toThrow(/schema version/);
    expect(() => validateProject({ ...newProject(), floors: [{ id: 'x' }] })).toThrow(/Invalid project/);
  });
  it('rejects duplicate IDs and dangling references', () => {
    const twin = newProject();
    twin.junctions.push({ id: twin.floors[0].id, floorId: null, position: [0, 0] });
    expect(() => validateProject(JSON.parse(JSON.stringify(twin)))).toThrow(/duplicate/);
    const dangling = newProject();
    dangling.objects.push({ ...createObject('room', [0, 0], 'floor-ground'), id: 'o-1', floorId: 'missing-floor' });
    expect(() => validateProject(JSON.parse(JSON.stringify(dangling)))).toThrow(/unknown floor/);
  });
});
