import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createObject } from '../model/factory';
import { emptyProject } from '../model/factory';
import { validateProject } from '../model/validate';
import { MaterialLibrary } from './materials';
import { FixtureLights, fixtureOutput, MAX_FIXTURE_LIGHTS } from './FixtureLights';

describe('light fixtures', () => {
  it('keeps hundreds of fittings within a fixed shadow and draw budget', () => {
    const scene = new THREE.Scene(), materials = new MaterialLibrary();
    const fixtures = Array.from({ length: 500 }, (_, i) => createObject('light', [(i % 25) * 6, Math.floor(i / 25) * 6], 'floor-ground'));
    const lights = new FixtureLights(scene, fixtures, p => p, 0.33, materials);
    expect(scene.children.filter(o => o instanceof THREE.PointLight)).toHaveLength(MAX_FIXTURE_LIGHTS);
    expect(scene.children.filter(o => o instanceof THREE.InstancedMesh)).toHaveLength(2);
    const first = lights.update(new THREE.Vector3(3, 3, 2), 0);
    expect(first.shadowsChanged).toBe(true);
    expect(lights.update(new THREE.Vector3(3, 3, 2), 1).shadowsChanged).toBe(false);
    lights.update(new THREE.Vector3(-100, -100, 2), 2);
    expect(scene.children.filter(o => o instanceof THREE.PointLight).every(o => o.intensity === 0)).toBe(true);
    materials.dispose();
  });
  it('flickers reproducibly, stays bounded, and leaves steady fixtures steady', () => {
    expect(fixtureOutput('steady', 12, 0)).toBe(1);
    const values = Array.from({ length: 2000 }, (_, i) => fixtureOutput('ballast', i / 100, 0.8));
    expect(Math.min(...values)).toBeLessThan(0.3);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(fixtureOutput('ballast', 2, 0.8)).toBe(fixtureOutput('ballast', 2, 0.8));
    expect(values.filter(v => v < 0.5).length / values.length).toBeLessThan(0.05);
  });
  it('validates exported fixture settings and rejects invalid ones', () => {
    const p = emptyProject([0, 0]);
    const lamp = createObject('light', [0, 0], p.floors[0].id);
    p.objects.push(lamp);
    expect(() => validateProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
    for (const patch of [{ range: 0 }, { intensity: -1 }, { kelvin: 900 }, { flicker: 2 }]) {
      const invalid = structuredClone(p);
      invalid.objects[0].light = { ...lamp.light!, ...patch };
      expect(() => validateProject(invalid)).toThrow(/light/);
    }
  });
});
