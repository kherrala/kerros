# @kerros/schema

The framework-free Kerros floor-plan model: portable documents, validation, transactional geometry
editing, topology, and indoor routing. It runs in browsers and Node.js.

```sh
npm install @kerros/schema
```

```ts
import { applyMutations, emptyProject, validateProject } from '@kerros/schema';

const project = emptyProject([24.938, 60.169], 'Example building');
const floorId = project.floors[0].id;
const result = applyMutations(project, [
  { kind: 'addBarrier', floorId, barrierKind: 'wall', a: [0, 0], b: [8, 0] },
]);
if (!result.ok) throw new Error(result.error);
validateProject(result.project);
```

See the [schema reference](https://github.com/kherrala/kerros/blob/main/docs/reference/schema.md),
[portable format](https://github.com/kherrala/kerros/blob/main/docs/reference/portable-format.md), and
[changelog](https://github.com/kherrala/kerros/blob/main/CHANGELOG.md).

MIT licensed.
