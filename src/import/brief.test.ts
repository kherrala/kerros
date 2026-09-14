import { expect, it } from 'vitest';
import { calibrateImport, importBriefInstructions, readImportBrief } from './brief';

it('calculates a single metric scale from user width, depth and polygon footprint area', () => {
  const brief = readImportBrief({
    buildingType: 'house',
    floorCount: 2,
    widthMetres: 20,
    depthMetres: 10,
    footprintAreaM2: 150,
  });
  expect(
    calibrateImport(
      { drawingWidth: 1000, drawingDepth: 500, drawingArea: 375000, realLengthMetres: 12, basis: 'Exterior footprint' },
      brief,
    ).metresPerUnit,
  ).toBe(0.02);
  // An area reference uses a square root, including a non-rectangular footprint.
  expect(
    calibrateImport({ drawingArea: 375000, basis: 'L-shaped footprint' }, { footprintAreaM2: 150 }).metresPerUnit,
  ).toBe(0.02);
  expect(importBriefInstructions(brief)).toContain('"floorCount":2');
  expect(importBriefInstructions(brief)).toContain('not summed usable room areas');
});
it('rejects conflicting references, invented substitutes and invalid template inputs', () => {
  expect(() =>
    calibrateImport(
      { drawingWidth: 1000, drawingArea: 375000, basis: 'Outline' },
      { widthMetres: 20, footprintAreaM2: 50 },
    ),
  ).toThrow('disagree');
  expect(() =>
    calibrateImport({ drawingLength: 1000, realLengthMetres: 12, basis: 'Guess' }, { widthMetres: 20 }),
  ).toThrow('drawingWidth');
  for (const value of [{ widthMetres: -20 }, { footprintAreaM2: 0 }, { floorCount: 1.5 }, { buildingType: 'unknown' }])
    expect(() => readImportBrief(value)).toThrow();
});
