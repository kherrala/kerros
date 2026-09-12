// A brand-new site, kept apart from the demo generators. The picker offers "New blank site" before
// it offers anything else, and pulling a thousand-object campus into the eager bundle to get an
// empty one would be the wrong way round.
import { emptyProject, geoOrigin } from '@kerros/schema';
import type { ProjectDocument } from '../../src/model/types';

export function newProject(name = 'Untitled site'): ProjectDocument {
  const p = emptyProject(geoOrigin([24.946, 60.185]), name);
  p.description = 'New site · Helsinki, Finland';
  return p;
}
