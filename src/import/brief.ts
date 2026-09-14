/** User-supplied import scope and whole-floor exterior scale references. */
export interface ImportBrief {
  buildingType?: 'apartment' | 'house' | 'office' | 'retail' | 'other';
  floorCount?: number;
  widthMetres?: number;
  depthMetres?: number;
  footprintAreaM2?: number;
}
export function readImportBrief(value: unknown): ImportBrief | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid import template.');
  const result: ImportBrief = {};
  for (const key of ['widthMetres', 'depthMetres', 'footprintAreaM2'] as const) {
    const n = (value as ImportBrief)[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
      throw new Error('Dimensions and footprint area must be positive numbers.');
    result[key] = n;
  }
  const { buildingType, floorCount } = value as ImportBrief;
  if (buildingType !== undefined) {
    if (!['apartment', 'house', 'office', 'retail', 'other'].includes(buildingType))
      throw new Error('Choose a building type from the template.');
    result.buildingType = buildingType;
  }
  if (floorCount !== undefined) {
    if (!Number.isSafeInteger(floorCount) || floorCount < 1 || floorCount > 100)
      throw new Error('Floor count must be a whole number between 1 and 100.');
    result.floorCount = floorCount;
  }
  return result;
}
export function importBriefInstructions(brief?: ImportBrief): string {
  if (!brief || !Object.keys(brief).length) return '';
  return `User import template: ${JSON.stringify(brief)}. Dimensions are in metres. Footprint area is the whole floor outline to the outside of walls, not summed usable room areas. Width/depth follow the drawing's main axes, not the page margins. Calibrate to these values. For area use scale = sqrt(real footprint area / source footprint polygon area); respect non-rectangular outlines. If references disagree, ask which is more reliable instead of stretching axes independently. Check an existing draft against these references before preserving its scale. Building type guides naming/use, never invents dimensions. Import the requested floor count only where source plans exist; report missing floor drawings rather than cloning or inventing layouts.`;
}

export interface SourceCalibration {
  drawingWidth?: number;
  drawingDepth?: number;
  drawingArea?: number;
  drawingLength?: number;
  realLengthMetres?: number;
  basis: string;
  metresPerUnit: number;
}
/** Compute scale from the user's references; never let the model silently substitute a smaller
 * real-world width. Multiple references must agree within 10% in linear scale. */
export function calibrateImport(value: unknown, brief?: ImportBrief): SourceCalibration {
  if (!value || typeof value !== 'object') throw new Error('Supply a source calibration.');
  const c = value as SourceCalibration;
  if (typeof c.basis !== 'string' || !c.basis.trim() || c.basis.length > 500)
    throw new Error('Identify the reference in basis (at most 500 characters).');
  const positive = (n: unknown, name: string) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
      throw new Error(`Supply a positive ${name} in original source units.`);
    return n;
  };
  const scales: number[] = [];
  const result: SourceCalibration = { basis: c.basis, metresPerUnit: 0 };
  if (brief?.widthMetres) {
    result.drawingWidth = positive(c.drawingWidth, 'drawingWidth');
    scales.push(brief.widthMetres / result.drawingWidth);
  }
  if (brief?.depthMetres) {
    result.drawingDepth = positive(c.drawingDepth, 'drawingDepth');
    scales.push(brief.depthMetres / result.drawingDepth);
  }
  if (brief?.footprintAreaM2) {
    result.drawingArea = positive(c.drawingArea, 'drawingArea');
    scales.push(Math.sqrt(brief.footprintAreaM2 / result.drawingArea));
  }
  if (!scales.length) {
    result.drawingLength = positive(c.drawingLength, 'drawingLength');
    result.realLengthMetres = positive(c.realLengthMetres, 'realLengthMetres');
    scales.push(result.realLengthMetres / result.drawingLength);
  }
  if (Math.max(...scales) / Math.min(...scales) > 1.1)
    throw new Error(
      'Scale references disagree by more than 10%. Recheck the source outline and user dimensions; ask for clarification instead of distorting the plan.',
    );
  result.metresPerUnit = scales[0];
  return result;
}
