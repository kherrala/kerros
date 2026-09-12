// Where the sun is, and how much of the light in the picture is its doing.
//
// The scene used to have two lightings — "day" and "evening" — chosen by a switch, and day was a
// fixed strong lamp from the west-south-west. That is not what light does. A building at 60°N never
// sees the sun higher than 53°, and for half the year it barely clears the rooftops; drawn under a
// permanent midday sun from the wrong quarter, a model's shadows fall in a direction the building
// has never seen and its façades read far brighter than they ever are. So the sun comes from the
// clock and the place instead, and the dusk treatment is what that produces after sunset rather
// than a mode someone remembers to turn on.
//
// The other half is that a building is lit from inside as well. Offices, shop floors and garages
// burn their own light all day and all night, and a plan that goes dark at sunset is describing a
// power cut, not an evening. So the interior term here does not follow the sun at all: it is what
// the building itself contributes, and the sun is added on top of it. That is also why the sun is
// weaker than it used to be — it is no longer carrying the whole scene.
import type { Point } from '../model/types';

/** The sun at the top of its scale, before the air takes its cut. Deliberately modest: see
 *  `sunlight` for why the beam is no longer the thing lighting the model. */
const SUN_PEAK = 2.3;

/** What a fully lit FLOOR sits at, all sources together, held across the day so the same storey
 *  reads the same at noon and at midnight — see `ambient`.
 *
 *  Set so a plate comes back at about the lightness it was authored at: a floor written as a pale
 *  grey should read as a pale grey. A cutaway is mostly floor — an open-plan storey has nothing in
 *  it to catch a highlight, and for most of a Nordic day the whole plate stands in the shadow of its
 *  own façade — so this number is very nearly what you see, and it has to be generous for the
 *  drawing to look like the inside of a working building rather than the inside of a cupboard. */
const TARGET_INTERIOR = 3.1;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Where the sun stands, seen from a place on the earth at a moment. */
export interface SolarPosition {
  /** Degrees above the horizon. Negative once the sun has set. */
  altitude: number;
  /** Degrees clockwise from due north: 90 is east, 180 south, 270 west. */
  azimuth: number;
}

/** The sun's position over `lngLat` at `when`.
 *
 *  The NOAA low-precision formulae: good to about a hundredth of a degree over a century either
 *  side of 2000, which is several orders of magnitude better than a picture of a building needs and
 *  costs a few lines of arithmetic. Time is read in UTC, so no timezone table is involved — the
 *  earth's rotation is the clock, and a longitude is a time of day.
 *
 *  Atmospheric refraction is left out. It lifts a sun on the horizon by about half a degree, which
 *  matters to an almanac and not to which way a shadow falls. */
export function solarPosition(lngLat: Point, when: Date | number = new Date()): SolarPosition {
  const [lng, lat] = lngLat;
  // Days since J2000.0 (2000-01-01 12:00 UTC), the epoch every term below is written against.
  const n = (typeof when === 'number' ? when : when.getTime()) / 86400000 - 10957.5;
  const meanLongitude = (280.46 + 0.9856474 * n) * RAD;
  const meanAnomaly = (357.528 + 0.9856003 * n) * RAD;
  // The earth's orbit is an ellipse, so the sun runs ahead of its mean position and falls behind it
  // over the year. Two terms of the equation of the centre carry that to well under a minute of arc.
  const ecliptic = meanLongitude + (1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(ecliptic));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(ecliptic), Math.cos(ecliptic));
  // Greenwich mean sidereal time: where the sky has turned to. Sidereal days are about four minutes
  // short of solar ones, which is the whole reason the stars — and the sun against them — drift.
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const localSidereal = (gmst * 15 + lng) * RAD;
  const hourAngle = localSidereal - rightAscension;
  const sinLat = Math.sin(lat * RAD),
    cosLat = Math.cos(lat * RAD);
  const altitude = Math.asin(sinLat * Math.sin(declination) + cosLat * Math.cos(declination) * Math.cos(hourAngle));
  const azimuth = Math.atan2(-Math.sin(hourAngle), Math.tan(declination) * cosLat - sinLat * Math.cos(hourAngle));
  return { altitude: altitude * DEG, azimuth: (((azimuth * DEG) % 360) + 360) % 360 };
}

/** How the scene is lit at a moment: where the sun is, and whether it is low enough that the model
 *  should wear its dusk treatment. */
export interface Sun extends SolarPosition {
  /** Dusk: lamps on, warm low light, dark sky. True below civil twilight. */
  evening: boolean;
}

/** Civil twilight. Below this the sky is no longer doing the lighting and the lamps are what you
 *  see by — which at 60°N in June the sun only just reaches, for an hour either side of midnight,
 *  and that is the honest picture of a white night. */
export const CIVIL_TWILIGHT = -6;

/** The sun over a project's origin at a moment, ready to light a scene with. */
export function sunAt(lngLat: Point, when: Date | number = new Date()): Sun {
  const at = solarPosition(lngLat, when);
  return { ...at, evening: at.altitude < CIVIL_TWILIGHT };
}

/** A sun pinned to a look rather than to a clock, for the manual override and for tests. Afternoon
 *  and dusk, at the angles the two fixed lightings used before this file knew where the sun was. */
export const FIXED: Record<'day' | 'evening', Sun> = {
  day: { altitude: 34, azimuth: 247, evening: false },
  evening: { altitude: -3, azimuth: 294, evening: true },
};

/** Linear interpolation through a table of (altitude, value) stops, flat outside its ends. */
function graded<T>(stops: [number, T][], altitude: number, mix: (a: T, b: T, t: number) => T): T {
  if (altitude <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [hi, above] = stops[i],
      [lo, below] = stops[i - 1];
    if (altitude <= hi) return mix(below, above, (altitude - lo) / (hi - lo || 1));
  }
  return stops[stops.length - 1][1];
}

const hex = (c: string): [number, number, number] => [
  Number.parseInt(c.slice(1, 3), 16),
  Number.parseInt(c.slice(3, 5), 16),
  Number.parseInt(c.slice(5, 7), 16),
];
const rgb = (c: [number, number, number]) =>
  `#${c
    .map(v =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
const blend = (a: string, b: string, t: number) => {
  const [ar, ag, ab] = hex(a),
    [br, bg, bb] = hex(b);
  return rgb([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** How much of the beam survives the air it comes through.
 *
 *  Kasten–Young air mass and a Meinel transmittance — two lines that say the thing everyone knows:
 *  a sun overhead is fierce and a sun on the horizon is not, because the low one is shining through
 *  ten times as much atmosphere. This is why the scene no longer needs a "too strong" fixed value.
 *  Helsinki's sun tops out at 53° in June and 6° at midwinter, and the difference now shows. */
function beam(altitude: number): number {
  // Afterglow. Below the horizon the sky is still lit from under the rim, and that light still
  // arrives from a direction — it is what gives a dusk façade its warm edge, and drawing dusk with
  // no directional light at all left the model flat and lifeless. Faded in as the sun nears the
  // horizon and out again at civil twilight, so nothing jumps as it crosses.
  const glow =
    0.12 *
    Math.max(0, Math.min(1, (altitude - CIVIL_TWILIGHT) / -CIVIL_TWILIGHT)) *
    Math.max(0, Math.min(1, 1 - altitude / 3));
  return beamAbove(altitude) + glow;
}

/** The direct beam alone, with no allowance for afterglow: what the sun is actually delivering to a
 *  surface, and so what the ceiling has to make up. */
function beamAbove(altitude: number): number {
  if (altitude <= 0) return 0;
  const airMass = 1 / (Math.sin(altitude * RAD) + 0.50572 * (altitude + 6.07995) ** -1.6364);
  return 0.7 ** (airMass ** 0.678);
}

/** Scene axes are east, north, up. Both renderers use this world-anchored sun. */
export const sunlight = (sun: Sun) => {
  // Held a little above the true horizon: a sun at 2° throws a shadow a hundred times the height of
  // whatever casts it, and the shadow map would spend its whole resolution on a smear across the
  // next parcel. Keep the direction, borrow a few degrees of height.
  const altitude = Math.max(sun.altitude, sun.evening ? 4 : 7);
  const r = 100 * Math.cos(altitude * RAD);
  const position: [number, number, number] = [
    r * Math.sin(sun.azimuth * RAD),
    r * Math.cos(sun.azimuth * RAD),
    100 * Math.sin(altitude * RAD),
  ];
  const [x, y, z] = position;
  return {
    position,
    // Low light is long light: the blue is scattered out of it before it arrives.
    color: graded<string>(
      [
        [-6, '#ffb083'],
        [2, '#ffc094'],
        [10, '#ffdcb4'],
        [25, '#fff1dc'],
        [45, '#fff8ee'],
      ],
      sun.altitude,
      blend,
    ),
    // A fifth of what it was, and falling with the air the beam comes through. Two reasons. The sun
    // no longer has to carry the scene — the building's own lighting does that — and a cutaway has
    // no roof, so direct sun lands on a shop floor that in life never sees any. What the sun is for
    // here is direction: which way the shadows fall and which façade is the bright one.
    intensity: SUN_PEAK * beam(sun.altitude),
    mapPosition: [1.5, (Math.atan2(x, y) * DEG + 360) % 360, Math.atan2(Math.hypot(x, y), z) * DEG] as [
      number,
      number,
      number,
    ],
  };
};

/** The artificial light a level burns.
 *
 *  A building is not lit by the sky. Offices, shop floors, garages and platforms run their own
 *  lighting through the working day and often through the night, and what colour that light is says
 *  as much about a space as its plan does: a 4000 K fluorescent office, a 2700 K hotel corridor and
 *  a 5000 K operating theatre are three different rooms before anything is drawn in them. So it is
 *  a property of the floor, authored like its name and its height, rather than a render setting. */
export interface InteriorLight {
  /** Colour temperature in kelvin. 2700 is a tungsten lamp, 4000 a fluorescent tube, 6500 daylight. */
  kelvin: number;
  /** How brightly, 0 (dark — an unlit store or a shell) to 1 (a fully lit workplace). */
  level: number;
}

/** The lamps a floor is likely to be fitted with, warmest first. Fluorescent is the default because
 *  it is what is actually overhead in most of the buildings anyone draws: offices, shops, schools,
 *  hospitals, car parks. */
export const LAMPS: { id: string; label: string; kelvin: number }[] = [
  { id: 'tungsten', label: 'Tungsten', kelvin: 2700 },
  { id: 'halogen', label: 'Halogen', kelvin: 3000 },
  { id: 'warm-led', label: 'Warm LED', kelvin: 3500 },
  { id: 'fluorescent', label: 'Fluorescent', kelvin: 4000 },
  { id: 'daylight', label: 'Daylight LED', kelvin: 5000 },
  { id: 'cool', label: 'Cool white', kelvin: 6500 },
];

/** What a floor is lit by when it does not say: a fluorescent ceiling, fully on. Most floors are
 *  fully lit; dimming is the thing worth authoring. */
export const DEFAULT_LIGHT: InteriorLight = { kelvin: 4000, level: 1 };

/** The nearest named lamp to a colour temperature, for showing an authored number as a choice. */
export const lampFor = (kelvin: number) =>
  LAMPS.reduce((best, lamp) => (Math.abs(lamp.kelvin - kelvin) < Math.abs(best.kelvin - kelvin) ? lamp : best));

/** Where white is. A room lit at 4500 K reads as neutral to someone standing in it, because eyes
 *  adapt to the light they are under — which is why a 4000 K fluorescent office looks white and not
 *  amber, though a 4000 K blackbody plotted against daylight is distinctly amber. Rendering the raw
 *  blackbody colour stains the whole model beige; rendering it RELATIVE to this leaves the tint that
 *  a person in the room would actually notice. */
const NEUTRAL_KELVIN = 4500;

/** Tanner Helland's fit to the blackbody locus — three logarithms rather than a colour-science
 *  dependency, and within a couple of percent across the range a luminaire lives in. */
function blackbody(kelvin: number): [number, number, number] {
  const t = Math.max(1000, Math.min(12000, kelvin)) / 100;
  const clamp = (v: number) => Math.max(1, Math.min(255, v));
  return [
    t <= 66 ? 255 : clamp(329.698727446 * (t - 60) ** -0.1332047592),
    clamp(t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492),
    t >= 66 ? 255 : t <= 19 ? 1 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307),
  ];
}

/** A colour temperature as a light colour: relative to the adapted white above, and held at one
 *  brightness so that changing the temperature changes the TINT and nothing else. How bright a floor
 *  is lit is the level's job, and the two must not fight each other. */
export function kelvinColor(kelvin: number): string {
  const here = blackbody(kelvin),
    white = blackbody(NEUTRAL_KELVIN);
  const ratio = here.map((v, i) => v / white[i]) as [number, number, number];
  const peak = Math.max(...ratio);
  const [r, g, b] = ratio.map(v => (v / peak) * 255) as [number, number, number];
  // Rec. 709 luma, held just under white, so a tungsten floor is warm rather than dim.
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const scale = luma > 0.01 ? 0.94 / luma : 1;
  return rgb([r * scale, g * scale, b * scale]);
}

/** Everything in the picture that is not the sun.
 *
 *  Two contributions, and they are different in kind. The SKY is daylight bouncing off the ground
 *  and the air, so it follows the sun down and goes out with it. The INTERIOR is the building's own
 *  lighting, and that does not follow anything: a shop floor is lit at four in the afternoon and at
 *  four in the morning, which is why a cutaway of a storey at midnight is legible rather than black.
 *  Kerros draws buildings from the inside, so this is most of what you are looking at. */
export function ambient(sun: Sun, light: InteriorLight = DEFAULT_LIGHT) {
  const day = graded<number>(
    [
      [-6, 0],
      [0, 0.3],
      [12, 0.75],
      [40, 1],
    ],
    sun.altitude,
    lerp,
  );
  const hemisphere = lerp(0.18, 0.26, day),
    environment = lerp(0.2, 0.28, day);
  // What the sky alone puts on a level surface: the beam foreshortened by its own angle, plus the
  // two diffuse terms. This is the number the ceiling has to make up.
  const daylight =
    SUN_PEAK * beamAbove(sun.altitude) * Math.max(0, Math.sin(sun.altitude * RAD)) + hemisphere + environment;
  const lit = Math.max(0, Math.min(1, light.level));
  return {
    /** Hemisphere sky and ground colours, and its strength: the outdoor half. */
    sky: blend('#8ea7cf', '#c7ddf5', day),
    ground: blend('#3f3a48', '#b9ac94', day),
    hemisphere,
    /** The image-based environment, for specular life on glass and metal. */
    environment,
    /** The building's own lights: colour and strength, both from the floor, neither following the
     *  sun. A level that says nothing is lit by a fluorescent ceiling, because most levels are.
     *
     *  A ceiling, which is to say it comes from ABOVE. Drawn as light arriving equally from every
     *  direction it lit the underside of a landing as brightly as the floor under it, and to get a
     *  floor bright enough it had to be turned up until the walls glowed — so the floor takes the
     *  full value and a wall about half of it, which is what a room of downlights actually does. */
    interior: kelvinColor(light.kelvin),
    /** What comes back UP off the floor: the same lamps, much weaker, which is the half of the
     *  picture that keeps a soffit from going black. */
    interiorBounce: blend(kelvinColor(light.kelvin), '#000000', 0.6),
    // The ceiling makes up the difference between what the sky is giving and what a lit interior is
    // supposed to sit at — which is what a real building does. A workplace is designed to a lux
    // level and modern lighting control holds it there, dimming as the sun comes round and coming up
    // as it goes; the lamps being "always on" is about the level being held, not about a fixed
    // wattage. It is also the only way a plan is equally readable at every hour, which is the point
    // of drawing one. A floor dimmed below full sits proportionally lower, and one set to nothing
    // goes dark, because an unlit level is a thing a building has.
    interiorLevel: lit > 0 ? Math.max(0.25, TARGET_INTERIOR * lit - daylight) : 0,
    /** How far along the fade to night the scene is: 1 in full day, 0 after civil twilight. */
    day,
    /** What the sky alone puts on a level surface, before the ceiling makes up the difference. */
    daylight,
  };
}
