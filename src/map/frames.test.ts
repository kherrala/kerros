import { describe, expect, it } from 'vitest';
import { LIFT, rampJoins, rampVoids, sceneElevation, sceneGround, SLAB, shellPlate, walkSoffit } from './SceneLayer';
import { EYE } from './walk';
import { createDemo } from '../../app/demo/demo';
import { ringArea } from '../model/geometry';
import { DEPTH_CAP, undergroundView } from './underground';
import { addFloor, newProject } from '../model/testFixtures';
import { createObject } from '../model/factory';
import { flights } from '../model/vertical';

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

/** A mine rather than a building: four levels reaching 400 m down, which is the only shape that makes
 *  the depth mapping do anything. Stockmann's deepest deck is 21 m and is drawn where it was authored. */
function deepShaft() {
  const p = newProject();
  const ids = [p.floors[0].id, addFloor(p, 'l-120', -120), addFloor(p, 'l-260', -260), addFloor(p, 'l-400', -400)];
  const lift = createObject('elevator', [0, 0], ids[3], 'Cage winder');
  lift.servedFloorIds = ids;
  p.objects.push(lift);
  return { p, ids, lift };
}

describe('one depth mapping, however deep the shaft', () => {
  it('draws the plate, the lift that climbs to it and the cage around it on the same scale', () => {
    const { p, lift } = deepShaft();
    const view = undergroundView(p, 'l-400', false);
    expect(view.buried && view.compressed).toBe(true);
    // Where the plate is drawn is where the camera is aimed: MapCanvas reads focusElevation, the cage
    // stands its columns on it, and the model goes through sceneElevation to reach the same number.
    expect(sceneElevation(view, false, -400)).toBeCloseTo(view.focusElevation);
    // A 400 m shaft is shown as a 96 m one — that is what the mapping is for — and every landing on
    // the way stays underground and in order. Rebasing the view to the compressed depth and then
    // adding the authored 140 m between -400 and -260 put that landing 44 m into the sky.
    expect(view.focusElevation + (-260 - -400)).toBeGreaterThan(0);
    const landings = flights(p, lift).map(f => sceneElevation(view, false, f.to.elevation));
    expect(landings).toEqual([...landings].sort((a, b) => a - b));
    for (const z of landings) expect(z).toBeLessThanOrEqual(0);
    expect(sceneElevation(view, false, -400)).toBeGreaterThan(-DEPTH_CAP - 0.01);
    // And it is a compression, not a translation: the 140 authored metres between two landings come
    // out as a fraction of themselves. The cage's rings and the excavation's strata are drawn at the
    // same fraction because they are put through this same function.
    const gap = sceneElevation(view, false, -260) - sceneElevation(view, false, -400);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(140);
  });

  it('leaves a shallow basement at the depth the document gave it', () => {
    const view = undergroundView(demo, 'floor-p3', false);
    expect(view.compressed).toBe(false);
    expect(sceneElevation(view, false, -21)).toBe(-21);
  });

  it('measures a walked storey from the walker instead, where there is no depth to compress', () => {
    const { p } = deepShaft();
    const view = undergroundView(p, 'l-400', false);
    expect(sceneElevation(view, true, -400)).toBe(0);
    // The storey above is its own 140 m up, not a compressed 34: inside one building you walk in
    // authored metres.
    expect(sceneElevation(view, true, -260)).toBe(140);
  });
});

describe('a ramp belongs to both decks it joins', () => {
  const ramps = demo.objects.filter(o => o.slope);
  const named = (name: string) => ramps.find(o => o.name === name)!;

  it('is claimed by the deck it lands on as well as the one it leaves', () => {
    const inter = named('Ramp P1 \u2192 P2');
    expect(inter.floorId).toBe('floor-p1'); // filed on the deck it leaves, and only that one
    expect(rampJoins(inter, floor('floor-p1').elevation)).toBe(true);
    expect(rampJoins(inter, floor('floor-p2').elevation)).toBe(true);
    // The storey between is not a deck this ramp reaches, and P3 is a deck it never touches.
    expect(rampJoins(inter, floor('floor-p3').elevation)).toBe(false);
  });

  it('leaves the storeys its incline merely passes alone', () => {
    // The driveway out to Mannerheimintie falls 12.6 m under the street, crossing -4.2, -6.6 and -9
    // a hundred metres from the building. Drawn on those it would lay tarmac through the food hall.
    const street = named('Entry ramp \u00b7 Mannerheimintie');
    for (const id of ['floor-b1', 'floor-b1a', 'floor-basement'])
      expect(rampJoins(street, floor(id).elevation), id).toBe(false);
  });
});

describe('the hole a driveway needs in its deck', () => {
  it('opens the plate the ramp dives under, which is the deck it sets off from', () => {
    expect(rampVoids(demo, 'floor-p1').length).toBe(1); // the P1 -> P2 ramp, and not the street ones
    expect(rampVoids(demo, 'floor-p2').length).toBe(1);
  });

  it('leaves the deck a ramp arrives at whole, because the ramp lands on top of it', () => {
    // A hole here would be a forty-metre trench in P3 with nothing under it.
    expect(rampVoids(demo, 'floor-p3')).toEqual([]);
  });

  it('never slots the shop for a driveway that surfaces at grade', () => {
    // Both street ramps reach 0, which is the ground floor's elevation; neither is on its plate.
    expect(rampVoids(demo, 'floor-ground')).toEqual([]);
  });
});
