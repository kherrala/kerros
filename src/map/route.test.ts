import { describe, expect, it } from 'vitest';
import { createDemo } from '../../app/demo/demo';
import { findRoute } from '../model/navigation';
import { routeFeatures, routeFlowGradient } from './route';

const demo = createDemo();
const from = demo.objects.find(o => o.name === 'Main entrance')!;
const to = demo.objects.find(o => o.kind === 'room' && o.floorId === 'floor-08')!;
const route = findRoute(demo, from.id, to.id)!;
/** The first floor the route actually walks along, so the fixture does not depend on which storey
 *  the demo happens to file the entrance under. */
const walkedFloor = route.legs.find(l => l.edge.kind !== 'stairs' && l.edge.kind !== 'elevator')!.from.floorId;

const props = (floorId: string | null) =>
  routeFeatures(demo, route, floorId, null).features.map(f => f.properties as Record<string, unknown>);

describe('the track the route is drawn as', () => {
  it('traces the walk once per instruction and once unbroken', () => {
    // Two tracings of the same path: the per-step features carry which instruction you are on, and
    // the flow features carry the path as one thing. Both have to exist or half the layers go blank.
    const all = props(walkedFloor);
    expect(all.some(p => p.flow === true)).toBe(true);
    expect(all.some(p => p.flow !== true && p.vertical === false)).toBe(true);
  });

  it('chains the flow feature straight through an instruction boundary', () => {
    // This is the whole reason the second tracing exists. line-progress runs 0→1 inside ONE feature,
    // so a band swept along a path split at every "turn left" restarts at every turn — which reads as
    // a stutter, not as motion towards somewhere. There must be fewer flow runs than step runs.
    const all = props(walkedFloor);
    const flows = all.filter(p => p.flow === true).length;
    const perStep = all.filter(p => p.flow !== true && p.vertical === false).length;
    expect(flows).toBeGreaterThan(0);
    expect(flows).toBeLessThan(perStep);
  });

  it('breaks the flow at a flight rather than sliding through it', () => {
    // A lift ride is not a stretch of floor. Whatever floor you ask for, the flow features on it are
    // each one continuous walk — never two walks joined across a shaft.
    const floors = new Set(route.legs.map(l => l.from.floorId));
    for (const fid of floors) {
      const flow = props(fid).filter(p => p.flow === true);
      for (const f of flow) expect(f.onFloor).toBe(true);
    }
    // And the vertical legs still get their own marker features.
    expect(props(walkedFloor).some(p => p.vertical === true)).toBe(true);
  });

  it('only draws the unbroken tracing on the floor you are looking at', () => {
    // The per-step features carry an onFloor flag and the off-floor layer draws them dashed; the flow
    // features are the lit track itself, and a lit track on a storey you cannot see is a lie.
    const elsewhere = props('floor-08').filter(p => p.flow === true);
    for (const f of elsewhere) expect(f.onFloor).toBe(true);
  });
});

describe('the band travelling along it', () => {
  const stops = (g: unknown[]) => g.slice(3).filter((_, i) => i % 2 === 0) as number[];
  const alphas = (g: unknown[]) =>
    (g.slice(3).filter((_, i) => i % 2 === 1) as string[]).map(c => Number(c.match(/([\d.]+)\)$/)![1]));

  it('offers strictly ascending stops at every phase', () => {
    // interpolate refuses stops that are not strictly ascending, and the obvious implementation —
    // moving a window of stops along — has to clamp as it wraps past 0 and 1. Fixed stops with a
    // moving alpha have nothing to clamp, and this is the property that says so.
    for (let phase = 0; phase < 1; phase += 0.037) {
      const at = stops(routeFlowGradient(phase));
      expect(at[0]).toBe(0);
      expect(at.at(-1)).toBe(1);
      for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]);
    }
  });

  it('puts the light where the phase is, and moves it', () => {
    const brightest = (phase: number) => {
      const a = alphas(routeFlowGradient(phase));
      return a.indexOf(Math.max(...a)) / (a.length - 1);
    };
    expect(brightest(0.25)).toBeCloseTo(0.25, 1);
    expect(brightest(0.75)).toBeCloseTo(0.75, 1);
    expect(brightest(0.5)).not.toBeCloseTo(0.25, 1);
  });

  it('carries the band round the join instead of ending at it', () => {
    // The head of the path is the tail's neighbour: at phase 0 the light straddles both ends, so the
    // band leaves one and arrives at the other without a dark seam in between.
    const a = alphas(routeFlowGradient(0));
    const peak = Math.max(...a);
    expect(a[0]).toBe(peak);
    expect(a.at(-1)).toBe(peak); // the far end is as lit as the near one, not dark
    expect(a[Math.floor(a.length / 2)]).toBe(0); // and the middle, half a path away, is not lit at all
  });
});
