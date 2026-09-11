import { describe, expect, it } from 'vitest';
import { detectLayers } from './detect';
import { importPlanEntities, type PlanEntity } from './planImport';
import { newProject } from '../model/testFixtures';
import type { Point } from '../schema';

// A small house in the shape a prefab drawing takes: two wall faces 0.3 m apart closing a loop, a
// partition pair inside it, a door swing, a window bundle and two room labels.
const line = (layer: string, a: Point, b: Point): PlanEntity => ({ type: 'LINE', layer, a, b });
const house = (names: Record<string, string>): PlanEntity[] => [
  // Envelope: outer face at 0/10/0/6, inner face 0.3 in.
  line(names.ext, [0, 0], [10, 0]),
  line(names.ext, [10, 0], [10, 6]),
  line(names.ext, [10, 6], [0, 6]),
  line(names.ext, [0, 6], [0, 0]),
  line(names.int, [0.3, 0.3], [9.7, 0.3]),
  line(names.int, [9.7, 0.3], [9.7, 5.7]),
  line(names.int, [9.7, 5.7], [0.3, 5.7]),
  line(names.int, [0.3, 5.7], [0.3, 0.3]),
  // A partition splitting it, drawn as its own pair 0.1 m apart.
  line(names.part, [5, 0.3], [5, 2.2]),
  line(names.part, [5.1, 0.3], [5.1, 2.2]),
  line(names.part, [5, 3.2], [5, 5.7]),
  line(names.part, [5.1, 3.2], [5.1, 5.7]),
  // A door in that gap, with its swing.
  { type: 'ARC', layer: names.door, center: [5, 2.2], r: 0.9, start: 0, end: 90 },
  line(names.door, [5, 2.2], [5.1, 2.2]),
  // A window bundle on the south face.
  line(names.win, [2, 0], [3.2, 0]),
  line(names.win, [2, 0.1], [3.2, 0.1]),
  line(names.win, [2, 0.3], [3.2, 0.3]),
  { type: 'TEXT', layer: names.label, at: [2.5, 3], text: 'OLOHUONE' },
  { type: 'TEXT', layer: names.label, at: [7.5, 3], text: 'MH' },
];
const VERTEX = {
  ext: '12_ULKOPINTA',
  int: '13_SISAPINTA',
  part: '196_SIS_SEINA',
  door: '27_OVET',
  win: '26_IKKUNAT',
  label: '55_HUONETUNNUKSET',
};
// The same drawing from an office with its own naming — nothing here carries a Finnish CAD hint.
const FOREIGN = { ext: 'A-101', int: 'A-102', part: 'A-140', door: 'A-260', win: 'A-270', label: 'A-990' };

describe('detectLayers', () => {
  it('recovers the roles from a drawing in the idiom it was built for', () => {
    const d = detectLayers(house(VERTEX));
    const role = (layer: string) => d.layers.find(r => r.layer === layer)?.role;
    expect([role(VERTEX.ext), role(VERTEX.int)].sort()).toEqual(['exteriorFace', 'interiorFace']);
    expect(role(VERTEX.door)).toBe('doors');
    expect(role(VERTEX.label)).toBe('labels');
  });
  it('recovers them from geometry alone when no layer name is a clue', () => {
    const d = detectLayers(house(FOREIGN));
    const role = (layer: string) => d.layers.find(r => r.layer === layer)?.role;
    expect([role(FOREIGN.ext), role(FOREIGN.int)].sort()).toEqual(['exteriorFace', 'interiorFace']);
    expect(role(FOREIGN.door)).toBe('doors');
    expect(role(FOREIGN.label)).toBe('labels');
  });
  it('its suggestion actually imports the drawing it came from', () => {
    const d = detectLayers(house(FOREIGN));
    const p = newProject();
    const report = importPlanEntities(p, house(FOREIGN), { floorId: 'floor-ground', layers: d.suggested });
    expect(report.walls).toBeGreaterThanOrEqual(4);
    expect(report.rooms).toBeGreaterThanOrEqual(1);
  });
  it('says which roles it could not find rather than guessing', () => {
    // Nothing but text: no faces, no openings.
    const d = detectLayers([{ type: 'TEXT', layer: 'NOTES', at: [0, 0], text: 'hello' }]);
    expect(d.missing).toContain('exteriorFace');
    expect(d.missing).toContain('doors');
  });
});
