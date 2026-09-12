import { describe, expect, it } from 'vitest';
import { ambient, CIVIL_TWILIGHT, kelvinColor, lampFor, solarPosition, sunAt, sunlight } from './lighting';
import type { Point } from '../model/types';

const HELSINKI: Point = [24.9421808, 60.1683719];
const QUITO: Point = [-78.4678, -0.1807];

/** The highest and lowest the sun gets over a place on a given day, by sampling it every minute.
 *  Both are geometric identities — 90 − |lat − declination| and (lat + declination) − 90 — so they
 *  check the whole chain (Julian day, declination, sidereal time, hour angle) against arithmetic
 *  that owes nothing to the implementation. */
function extremes(at: Point, day: string) {
  let low = 90,
    high = -90,
    noon = 0;
  for (let minute = 0; minute < 1440; minute++) {
    const { altitude, azimuth } = solarPosition(at, new Date(`${day}T00:00:00Z`).getTime() + minute * 60000);
    if (altitude > high) {
      high = altitude;
      noon = azimuth;
    }
    low = Math.min(low, altitude);
  }
  return { high, low, noon };
}

describe('where the sun is', () => {
  it('rises to 53° over Helsinki at midsummer and barely sets', () => {
    // 90 − (60.17 − 23.44) = 53.3 at noon; 60.17 + 23.44 − 90 = −6.4 at midnight. The white night:
    // the sun dips just past civil twilight and no further, which is why the auto-dusk threshold
    // sits where it does.
    const { high, low, noon } = extremes(HELSINKI, '2026-06-21');
    expect(high).toBeCloseTo(53.3, 0);
    expect(low).toBeCloseTo(-6.4, 0);
    expect(noon).toBeCloseTo(180, 0); // due south at its highest
  });

  it('clears the rooftops by 6° at midwinter', () => {
    // 90 − (60.17 + 23.44) = 6.4. A Helsinki December noon is lower than a midsummer midnight is
    // deep, and a fixed "day" light at 34° was drawing a sun the city does not have.
    const { high, low } = extremes(HELSINKI, '2026-12-21');
    expect(high).toBeCloseTo(6.4, 0);
    expect(low).toBeCloseTo(-53.3, 0);
  });

  it('passes overhead at the equator at the equinox', () => {
    const { high } = extremes(QUITO, '2026-03-20');
    expect(high).toBeGreaterThan(89);
  });

  it('runs east to west through the day', () => {
    const morning = solarPosition(HELSINKI, new Date('2026-06-21T05:00:00Z'));
    const evening = solarPosition(HELSINKI, new Date('2026-06-21T16:00:00Z'));
    expect(morning.azimuth).toBeGreaterThan(60);
    expect(morning.azimuth).toBeLessThan(140); // east-ish
    expect(evening.azimuth).toBeGreaterThan(230); // west-ish
    expect(evening.azimuth).toBeLessThan(300);
  });
});

describe('what the sun does to the picture', () => {
  it('calls it evening only below civil twilight', () => {
    expect(sunAt(HELSINKI, new Date('2026-12-21T10:30:00Z')).evening).toBe(false); // low midwinter noon
    expect(sunAt(HELSINKI, new Date('2026-12-21T22:00:00Z')).evening).toBe(true);
    expect(sunAt(HELSINKI, new Date('2026-06-21T21:00:00Z')).evening).toBe(false); // still light at nine
  });

  it('softens as the sun drops, instead of burning at one fixed value', () => {
    const noon = sunlight(sunAt(HELSINKI, new Date('2026-06-21T10:20:00Z')));
    const winter = sunlight(sunAt(HELSINKI, new Date('2026-12-21T10:30:00Z')));
    const night = sunlight(sunAt(HELSINKI, new Date('2026-12-21T22:00:00Z')));
    expect(noon.intensity).toBeGreaterThan(winter.intensity);
    expect(winter.intensity).toBeGreaterThan(night.intensity);
    expect(night.intensity).toBe(0);
    // And warmer the lower it gets: less blue survives the air, so the blue channel falls while
    // the red stays pinned.
    const blue = (c: string) => Number.parseInt(c.slice(5, 7), 16);
    expect(blue(noon.color)).toBeGreaterThan(blue(winter.color));
  });

  it('keeps the light above the horizon so shadows stay on the parcel', () => {
    // A sun at 1° would throw a shadow sixty times the height of what casts it, and the shadow map
    // would spend its whole resolution on a smear across the next block.
    const { position } = sunlight({ altitude: 0.5, azimuth: 200, evening: false });
    expect(position[2]).toBeGreaterThan(5);
  });

  it('never turns the building lights off', () => {
    // A plan that goes black at sunset is describing a power cut, not an evening. Kerros draws
    // buildings from the inside, so the interior term is what most of the picture is lit by, and it
    // is the same at two in the morning as at ten in the morning.
    const noon = ambient(sunAt(HELSINKI, new Date('2026-06-21T10:00:00Z')));
    const night = ambient(sunAt(HELSINKI, new Date('2026-12-21T02:00:00Z')));
    expect(night.interiorLevel).toBeGreaterThan(1);
    expect(night.interiorLevel).toBe(noon.interiorLevel);
    expect(night.interior).toBe(noon.interior);
    expect(ambient(sunAt(HELSINKI, new Date('2026-12-21T02:00:00Z'))).day).toBe(0);
    expect(ambient(sunAt(HELSINKI, new Date('2026-06-21T10:20:00Z'))).day).toBe(1);
  });

  it('takes the lamp from the floor, and warms the light with it', () => {
    const sun = sunAt(HELSINKI, new Date('2026-12-21T02:00:00Z'));
    const tube = ambient(sun, { kelvin: 4000, level: 0.8 });
    const tungsten = ambient(sun, { kelvin: 2700, level: 0.8 });
    const dimmed = ambient(sun, { kelvin: 4000, level: 0.3 });
    const blue = (c: string) => Number.parseInt(c.slice(5, 7), 16);
    expect(blue(tungsten.interior)).toBeLessThan(blue(tube.interior));
    // The temperature changes the tint, not the brightness — dimming is the level's job.
    expect(tungsten.interiorLevel).toBe(tube.interiorLevel);
    expect(dimmed.interiorLevel).toBeLessThan(tube.interiorLevel);
    // A floor that says nothing is lit by a fluorescent ceiling.
    expect(ambient(sun).interior).toBe(tube.interior);
  });

  it('rejects a lamp that is not a lamp', () => {
    expect(kelvinColor(4000)).toMatch(/^#[0-9a-f]{6}$/);
    expect(kelvinColor(-50)).toBe(kelvinColor(1000));
    expect(kelvinColor(99999)).toBe(kelvinColor(12000));
    expect(lampFor(3900).id).toBe('fluorescent');
    expect(lampFor(2750).id).toBe('tungsten');
  });

  it('agrees with the threshold it publishes', () => {
    expect(sunAt(HELSINKI, new Date()).evening).toBe(solarPosition(HELSINKI, new Date()).altitude < CIVIL_TWILIGHT);
  });
});
