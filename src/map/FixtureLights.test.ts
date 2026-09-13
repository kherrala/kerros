import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createObject } from '../model/factory';
import { emptyProject } from '../model/factory';
import { validateProject } from '../model/validate';
import { MaterialLibrary } from './materials';
import { FixtureLights, fixtureOutput, MAX_FIXTURE_LIGHTS, SHADOWED_FIXTURE_LIGHTS } from './FixtureLights';

describe('light fixtures', () => {
  it.each([0, 180])('mounts underwater fixtures facing into the basin at %d degrees', rotation => {
    const scene = new THREE.Scene(),
      materials = new MaterialLibrary();
    const lamp = createObject('light', [0, 0], 'floor-pool');
    lamp.rotation = rotation;
    lamp.light = { kelvin: 5600, intensity: 95, range: 12, mountHeight: -0.7 };
    const fixtures = new FixtureLights(scene, [lamp], p => p, 0.33, materials);
    fixtures.update(new THREE.Vector3(0, 1, 2.03), 0);
    const light = scene.children.find(o => o instanceof THREE.PointLight) as THREE.PointLight;
    expect(light.position.z).toBeCloseTo(0.33 - 0.7 - 0.12);
    expect(light.intensity).toBe(95);
    expect(light.distance).toBe(12);
    const panels = scene.children.filter(o => o instanceof THREE.InstancedMesh);
    const emitter = new THREE.Matrix4();
    panels[1].getMatrixAt(0, emitter);
    const at = new THREE.Vector3().setFromMatrixPosition(emitter);
    expect(at.z).toBeCloseTo(0.33 - 0.7);
    expect(at.y).toBeCloseTo(-0.052 * Math.cos((rotation * Math.PI) / 180));
    expect(Math.abs(at.y)).toBeGreaterThan(0.045); // the luminous face clears its housing
    materials.dispose();
  });
  it('keeps hundreds of fittings within a fixed shadow and draw budget', () => {
    const scene = new THREE.Scene(),
      materials = new MaterialLibrary();
    const fixtures = Array.from({ length: 500 }, (_, i) =>
      createObject('light', [(i % 25) * 6, Math.floor(i / 25) * 6], 'floor-ground'),
    );
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
    for (const patch of [
      { range: 0 },
      { intensity: -1 },
      { kelvin: 900 },
      { flicker: 2 },
      { mountHeight: NaN },
      { mountHeight: -30 },
    ]) {
      const invalid = structuredClone(p);
      invalid.objects[0].light = { ...lamp.light!, ...patch };
      expect(() => validateProject(invalid)).toThrow(/light/);
    }
  });
});

describe('which lamps carry the shadows', () => {
  const grid = () => {
    const scene = new THREE.Scene();
    const fixtures = Array.from({ length: 25 }, (_, i) => {
      const o = createObject('light', [(i % 5) * 6, Math.floor(i / 5) * 6], 'floor-ground');
      o.light = { kelvin: 4000, intensity: 55, range: 13 };
      return o;
    });
    const lights = new FixtureLights(scene, fixtures, p => p, 0.33, new MaterialLibrary());
    return { lights, points: scene.children.filter(o => o instanceof THREE.PointLight) as THREE.PointLight[] };
  };

  it('always has exactly the budgeted number of shadow casters, empty slots included', () => {
    const { lights, points } = grid();
    lights.update(new THREE.Vector3(12, 12, 1.7), 0);
    expect(points.filter(l => l.castShadow)).toHaveLength(SHADOWED_FIXTURE_LIGHTS);
    // Far from every lamp: nothing lit, the count still holds, so the shaders stay compiled.
    lights.update(new THREE.Vector3(500, 500, 1.7), 1);
    expect(points.filter(l => l.intensity > 0)).toHaveLength(0);
    expect(points.filter(l => l.castShadow)).toHaveLength(SHADOWED_FIXTURE_LIGHTS);
  });

  it('does not reshuffle the lamps for a step that changes nothing', () => {
    // Every swap is a shadow map redrawn — six passes over the floor. Standing between lamps and
    // shifting a foot must not trade them.
    const { lights, points } = grid();
    lights.update(new THREE.Vector3(12, 12, 1.7), 0);
    const before = points.map(l => `${l.position.x},${l.position.y}:${l.castShadow}`);
    const { shadowsChanged } = lights.update(new THREE.Vector3(12.3, 12.1, 1.7), 0.02);
    expect(shadowsChanged).toBe(false);
    expect(points.map(l => `${l.position.x},${l.position.y}:${l.castShadow}`)).toEqual(before);
  });

  it('moves the shadows on to the lamps you walk to', () => {
    const { lights, points } = grid();
    lights.update(new THREE.Vector3(0, 0, 1.7), 0);
    for (let s = 1; s <= 20; s++) lights.update(new THREE.Vector3(s * 0.9, s * 0.9, 1.7), s * 0.05);
    const casters = points.filter(l => l.castShadow && l.intensity > 0);
    expect(casters).toHaveLength(SHADOWED_FIXTURE_LIGHTS);
    for (const l of casters) expect(Math.hypot(l.position.x - 18, l.position.y - 18)).toBeLessThan(9);
  });
});
