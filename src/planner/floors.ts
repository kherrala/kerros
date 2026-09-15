import type { Floor, ProjectDocument } from '../model/types';

export function floorCode(project: ProjectDocument, f: Floor) {
  if (f.code) return f.code;
  return f.mezzanine
    ? 'M'
    : f.elevation < 0
      ? 'B' +
        project.floors.filter(
          x => x.buildingId === f.buildingId && !x.mezzanine && x.elevation < 0 && x.elevation >= f.elevation,
        ).length
      : String(
          project.floors.filter(
            x => x.buildingId === f.buildingId && !x.mezzanine && x.elevation >= 0 && x.elevation < f.elevation,
          ).length,
        ).padStart(2, '0');
}

export function floorBand(project: ProjectDocument, floorId: string | null) {
  const floor = project.floors.find(f => f.id === floorId);
  return project.floors
    .filter(f => f.buildingId === (floor?.buildingId ?? project.buildings[0].id))
    .sort((a, b) => a.elevation - b.elevation);
}
