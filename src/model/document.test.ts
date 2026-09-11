import { beforeAll, describe, expect, it } from 'vitest';
import { exportProject, importProject, parseExport, blobDataUrl } from './document';
import { validateProject } from './validate';
import { newProject } from './testFixtures';
import { createObject } from './factory';
import { OBJECT_KINDS, type AssetRepository, type ProjectDocument } from './types';

// The node test env has no FileReader (blobDataUrl uses it); shim it from a Buffer.
beforeAll(() => {
  if (!('FileReader' in globalThis))
    (globalThis as unknown as { FileReader: unknown }).FileReader = class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        blob
          .arrayBuffer()
          .then(buf => {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${btoa(String.fromCharCode(...new Uint8Array(buf)))}`;
            this.onload?.();
          })
          .catch(() => this.onerror?.());
      }
    };
});

class MemAssets implements AssetRepository {
  store = new Map<string, Blob>();
  async get(id: string) {
    return this.store.get(id);
  }
  async put(id: string, a: Blob) {
    this.store.set(id, a);
  }
  async delete(id: string) {
    this.store.delete(id);
  }
}
const png = () => new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
function withDrawing(): ProjectDocument {
  const p = newProject();
  p.drawings.push({
    id: 'd1',
    floorId: p.floors[0].id,
    assetId: 'a1',
    name: 'plan',
    width: 100,
    height: 80,
    origin: [0, 0],
    scale: 1,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
  });
  return p;
}

describe('portable export/import contract', () => {
  it('round-trips a drawing project: embeds the asset, then re-imports with fresh id/updatedAt and a new assetId', async () => {
    const assets = new MemAssets();
    await assets.put('a1', png());
    const p = withDrawing();
    const json = JSON.parse(await exportProject(p, assets));
    expect(Object.keys(json.embeddedAssets)).toEqual(['a1']);
    expect(json.embeddedAssets.a1).toMatch(/^data:image\/png;base64,/);
    const target = new MemAssets();
    const imported = await importProject(JSON.stringify(json), target);
    expect(imported.id).not.toBe(p.id);
    expect(imported.updatedAt).not.toBe(p.updatedAt);
    const newAssetId = imported.drawings[0].assetId;
    expect(newAssetId).not.toBe('a1');
    expect(await target.get(newAssetId)).toBeInstanceOf(Blob);
  });
  it('exportProject throws when a referenced drawing asset is missing', async () => {
    await expect(exportProject(withDrawing(), new MemAssets())).rejects.toThrow(/missing/i);
  });
  it('importProject throws on a missing or non-image embedded asset', async () => {
    const base = JSON.stringify({ ...withDrawing(), embeddedAssets: {} });
    await expect(importProject(base, new MemAssets())).rejects.toThrow(/supported reference image/i);
    const bad = JSON.stringify({ ...withDrawing(), embeddedAssets: { a1: 'data:text/plain;base64,aGk=' } });
    await expect(importProject(bad, new MemAssets())).rejects.toThrow(/supported reference image/i);
  });
  it('parseExport keeps ids/updatedAt, writes nothing, and lazily resolves a bad asset to undefined', async () => {
    const assets = new MemAssets();
    await assets.put('a1', png());
    const p = withDrawing();
    const good = parseExport(await exportProject(p, assets));
    expect(good.project.id).toBe(p.id);
    expect(good.project.updatedAt).toBe(p.updatedAt);
    expect(await good.assets.get('a1')).toBeInstanceOf(Blob);
    // A malformed embedded entry resolves to undefined at get() time rather than throwing on parse.
    const bad = parseExport(JSON.stringify({ ...p, embeddedAssets: { a1: 'not-a-data-url' } }));
    expect(await bad.assets.get('a1')).toBeUndefined();
  });
  it('blobDataUrl encodes a blob as a base64 data URL', async () => {
    expect(await blobDataUrl(png())).toMatch(/^data:image\/png;base64,/);
  });
  it('a project with no drawings exports empty embeddedAssets and re-imports clean', async () => {
    const json = await exportProject(newProject(), new MemAssets());
    expect(JSON.parse(json).embeddedAssets).toEqual({});
    const imported = await importProject(json, new MemAssets());
    expect(imported.floors.length).toBe(1);
  });
});

describe('object-kind validation', () => {
  // Guards against the validator's kind whitelist drifting from the ObjectKind union (a real gap:
  // sensor/alarm/equipment/evacuation existed in the type and tools but were rejected on save).
  it('accepts every kind in OBJECT_KINDS', () => {
    const p = newProject();
    const floorId = p.floors[0].id;
    for (const kind of OBJECT_KINDS) p.objects.push(createObject(kind, [0, 0], floorId, `test ${kind}`));
    expect(() => validateProject({ ...p, schemaVersion: 1 })).not.toThrow();
  });
  it('accepts a well-formed slope and rejects a degenerate one', () => {
    const p = newProject();
    const ramp = createObject('zone', [0, 0], p.floors[0].id, 'Ramp');
    ramp.rings = [
      [
        [0, 0],
        [10, 0],
        [10, 4],
        [0, 4],
        [0, 0],
      ],
    ];
    ramp.slope = {
      axis: [
        [0, 2],
        [10, 2],
      ],
      high: 0,
      low: -4,
    };
    p.objects.push(ramp);
    expect(() => validateProject({ ...p, schemaVersion: 1 })).not.toThrow();
    // A zero-length axis has no direction to fall along.
    ramp.slope = {
      axis: [
        [0, 2],
        [0, 2],
      ],
      high: 0,
      low: -4,
    };
    expect(() => validateProject({ ...p, schemaVersion: 1 })).toThrow(/slope/i);
    // A slope needs a footprint to drape over.
    ramp.slope = {
      axis: [
        [0, 2],
        [10, 2],
      ],
      high: 0,
      low: -4,
    };
    ramp.rings = undefined;
    expect(() => validateProject({ ...p, schemaVersion: 1 })).toThrow(/footprint/i);
  });
  it('rejects an initialFloorId that names no floor', () => {
    const p = newProject();
    expect(() => validateProject({ ...p, schemaVersion: 1, initialFloorId: p.floors[0].id })).not.toThrow();
    expect(() => validateProject({ ...p, schemaVersion: 1, initialFloorId: null })).not.toThrow();
    expect(() => validateProject({ ...p, schemaVersion: 1, initialFloorId: 'nope' })).toThrow(/initialFloorId/);
  });
  it('rejects an unknown kind', () => {
    const p = newProject();
    p.objects.push({ ...createObject('room', [0, 0], p.floors[0].id, 'x'), kind: 'nonsense' as never });
    expect(() => validateProject({ ...p, schemaVersion: 1 })).toThrow(/invalid object/i);
  });
});
