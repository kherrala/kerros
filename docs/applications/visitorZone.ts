import { addZone, spaces, transact, type ProjectDocument } from '@kerros/schema';

export function addVisitArea(project: ProjectDocument, spaceIds: string[]) {
  return transact(project, draft => {
    const known = new Set(spaces(draft).map(space => space.id));
    if (spaceIds.length === 0 || spaceIds.some(id => !known.has(id))) {
      throw new Error('Select existing spaces for the visit area.');
    }
    addZone(draft, 'Visitor destinations', spaceIds, 'visitor');
  });
}
