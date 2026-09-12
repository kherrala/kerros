import { describe, expect, it } from 'vitest';
import { LIFT, sceneGround, SLAB, shellPlate, walkSoffit } from './SceneLayer';
import { EYE } from './walk';
import { createDemo } from '../../app/demo/demo';
import { ringArea } from '../model/geometry';

const demo = createDemo();
const floor = (id: string) => demo.floors.find(f => f.id === id)!;

describe('one frame for everything', () => {
  it('carries an authored elevation onto the floor being walked', () => {
    const p1 = floor('floor-p1'); // a garage deck at -12.6
    expect(p1.elevation).toBe(-12.6);
    // Walk mode puts the deck on the map's own ground plane and everything authored has to follow.
    const ground = sceneGround(false, 0, p1.elevation);
    expect(ground).toBeCloseTo(12.6);
    // The ramp off the deck is authored at the deck's own elevation, and its driving surface has to
    // land on the deck's plate rather than 12.6 m under the walker's feet.
    const ramp = demo.objects.find(o => o.floorId === 'floor-p1' && o.slope)!;
    expect(Math.max(ramp.slope!.high, ramp.slope!.low) + ground + LIFT + SLAB).toBeCloseTo(LIFT + SLAB);
    // Grade — the pavement parcel, the fences, the shadow plane — is a storey-and-a-half of garage
    // above you, not level with the shop you are standing in.
    expect(ground).toBeGreaterThan(0);
    // And the deck below stays below: one frame, not two.
    expect(sceneGround(false, 0, p1.elevation) + floor('floor-p2').elevation).toBeCloseTo(-4.2);
  });

  it('leaves the stacked and cutaway views where the document put them', () => {
    expect(sceneGround(true, 0, -12.6)).toBe(0); // the stack draws at authored elevations
    expect(sceneGround(false, 4.2, 4.2)).toBe(0); // an uncompressed cutaway rebases to its own floor
  });
});

describe('the walked ceiling', () => {
  it('sits at the storey underside, so fixtures authored to the storey clear it', () => {
    const garage = floor('floor-p1'); // 3.4 m, with 3.1 m luminaires and 4.2 m pillars under it
    expect(walkSoffit(0, garage.height)).toBeCloseTo(garage.height + LIFT);
    expect(walkSoffit(0, garage.height)).toBeGreaterThan(3.1);
  });

  it('never hangs below the walker eye, however low the storey was drawn', () => {
    const entresol = floor('floor-entresol');
    const eye = LIFT + SLAB + EYE;
    expect(walkSoffit(0, 1.6)).toBeGreaterThanOrEqual(eye + 0.3);
    expect(walkSoffit(0, entresol.height)).toBeGreaterThanOrEqual(eye + 0.3);
  });
});

describe('shell plates', () => {
  it('gives a garage deck one plate instead of failing on four hundred bays', () => {
    const plates = shellPlate(demo, 'floor-p1');
    expect(plates.length).toBeGreaterThan(0);
    // The deck itself, not a bay: the biggest polygon is thousands of square metres.
    expect(Math.max(...plates.map(pg => Math.abs(ringArea(pg[0]))))).toBeGreaterThan(2000);
  });

  it('reaches down the ramps, which is what runs out past the building', () => {
    const ramp = demo.objects.find(o => o.floorId === 'floor-p1' && o.slope)!;
    const plates = shellPlate(demo, 'floor-p1');
    const far = Math.max(...ramp.rings![0].map(pt => pt[0]));
    expect(Math.max(...plates.flatMap(pg => pg[0].map(pt => pt[0])))).toBeGreaterThanOrEqual(far - 0.01);
  });

  it('keeps a fit-out storey to one plate', () => {
    const plates = shellPlate(demo, 'floor-ground');
    expect(plates.length).toBeGreaterThan(0);
    expect(plates.length).toBeLessThan(8);
  });
});
