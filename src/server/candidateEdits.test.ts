import { expect, it } from 'vitest';
import { CandidateEdits, projectRevision } from './candidateEdits';
import { calibrateSource, vectorBounds, type SourceAnalysis, type VectorCommand } from './analysis';
import { emptyProject, geoOrigin, applyMutations, validateProject } from '../schema';
import { boundaryRegions } from '../model/boundaries';
import { objectArea } from '../model/geometry';
import { findRoute } from '../model/navigation';

const fixture = () => {
  const paths: [string, VectorCommand[]][] = [
    ['shell', [['M', 0, 0], ['L', 12, 0], ['L', 12, 8], ['L', 0, 8], ['Z']]],
    [
      'partition',
      [
        ['M', 6, 0],
        ['L', 6, 8],
      ],
    ],
    ['left', [['M', 3, 3]]],
    ['right', [['M', 9, 3]]],
    ['door', [['M', 6, 4]]],
  ];
  const a: SourceAnalysis = {
    version: 1,
    id: 'source-1',
    sourceHash: 'a'.repeat(64),
    page: 1,
    sourceKind: 'cad',
    units: 'm',
    axis: 'y-up',
    bounds: [0, 0, 12, 8],
    warnings: [],
    candidates: paths.map(([id, path]) => ({
      id,
      kind: path.length === 1 ? 'label' : 'wall',
      path,
      bounds: vectorBounds(path),
      thickness: 0.2,
      text: id,
      evidence: 'Measured fixture',
    })),
  };
  let current = emptyProject(geoOrigin([24, 60]));
  let accepts = 0;
  const planner = new CandidateEdits({
    current: () => current,
    accept: p => {
      current = p;
      accepts++;
    },
  });
  const transform = calibrateSource(a, undefined, { referenceIds: ['shell'] });
  return {
    a,
    planner,
    transform,
    current: () => current,
    accepts: () => accepts,
    update: (p: typeof current) => {
      current = p;
    },
  };
};
const floorId = 'floor-ground';
const roomEdits = [
  { candidateId: 'shell', as: 'wall' },
  { candidateId: 'partition', as: 'wall' },
  { candidateId: 'left', as: 'room' },
  { candidateId: 'right', as: 'room' },
];

it('previews a connected T-junction network and usable areas without writing, then applies exactly those IDs', async () => {
  const f = fixture();
  const before = JSON.stringify(f.current());
  const p = f.planner.preview(f.a, f.transform, { floorId, edits: roomEdits });
  expect(JSON.stringify(f.current())).toBe(before);
  expect(f.accepts()).toBe(0);
  expect(p.topology.junctions.filter(j => j.kind === 'T')).toHaveLength(2);
  expect(p.topology.enclosedFaces).toBe(2);
  expect(p.rooms).toHaveLength(2);
  for (const room of p.rooms) expect(room.usableAreaM2).toBeCloseTo(5.8 * 7.8);
  await f.planner.apply(f.a, f.transform, p);
  expect(f.accepts()).toBe(1);
  expect(f.current().objects.map(o => o.id)).toEqual(p.rooms.map(r => r.id));
  expect(f.current().objects.every(o => o.geometry?.mode === 'boundaries')).toBe(true);
  expect(validateProject(f.current())).toBeTruthy();
  expect(() => f.planner.preview(f.a, f.transform, { floorId, edits: roomEdits })).toThrow('already accepted');
  await expect(f.planner.apply(f.a, f.transform, p)).rejects.toThrow('expired');
});

it('refuses a complete batch when a later room is too small, preserving the live project', () => {
  const f = fixture();
  f.a.candidates.find(c => c.id === 'partition')!.path = [
    ['M', 0.3, 0],
    ['L', 0.3, 8],
  ];
  f.a.candidates.find(c => c.id === 'left')!.path = [['M', 0.15, 4]];
  const before = projectRevision(f.current());
  expect(() => f.planner.preview(f.a, f.transform, { floorId, edits: roomEdits })).toThrow('1 m²');
  expect(projectRevision(f.current())).toBe(before);
  expect(f.accepts()).toBe(0);
});

it('rejects both a stale live project and a recalibrated transform', async () => {
  const f = fixture();
  const p = f.planner.preview(f.a, f.transform, { floorId, edits: roomEdits });
  const changed = applyMutations(f.current(), [{ kind: 'patchProject', set: { name: 'Manual correction' } }]);
  if (!changed.ok) throw new Error(changed.error);
  f.update(changed.project);
  await expect(f.planner.apply(f.a, f.transform, p)).rejects.toThrow('Project changed');
  expect(f.current().name).toBe('Manual correction');
  const next = f.planner.preview(f.a, f.transform, { floorId, edits: roomEdits });
  await expect(f.planner.apply(f.a, { ...f.transform, id: 'new-transform' }, next)).rejects.toThrow('expired');
  expect(f.current().barriers).toHaveLength(0);
});

it('binds a confirmed opening to its actual wall and connects the rooms through core portals', async () => {
  const f = fixture();
  const walls = f.planner.preview(f.a, f.transform, { floorId, edits: roomEdits });
  await f.planner.apply(f.a, f.transform, walls);
  const hostBarrierId = walls.mappings.find(m => m.candidateId === 'partition')!.modelIds[0];
  const unchanged = projectRevision(f.current());
  expect(() =>
    f.planner.preview(f.a, f.transform, {
      floorId,
      edits: [{ candidateId: 'door', as: 'door', width: 9, hostBarrierId }],
    }),
  ).toThrow('too short');
  expect(projectRevision(f.current())).toBe(unchanged);
  const p = f.planner.preview(f.a, f.transform, {
    floorId,
    edits: [{ candidateId: 'door', as: 'door', width: 0.9, hostBarrierId }],
  });
  expect(p.openings).toMatchObject([{ length: 8, offset: 4, width: 0.9, fitInterval: [0.45, 7.55] }]);
  await f.planner.apply(f.a, f.transform, p);
  const rooms = f.current().objects.filter(o => o.kind === 'room');
  expect(f.current().portals?.length).toBeGreaterThan(0);
  expect(findRoute(f.current(), rooms[0].id, rooms[1].id)).toBeTruthy();
});

it('updates older candidate mappings when a later partition splits their shared edges', async () => {
  const f = fixture();
  const first = f.planner.preview(f.a, f.transform, { floorId, edits: roomEdits });
  await f.planner.apply(f.a, f.transform, first);
  const path: VectorCommand[] = [
    ['M', 0, 4],
    ['L', 12, 4],
  ];
  f.a.candidates.push({
    id: 'cross',
    kind: 'wall',
    path,
    bounds: vectorBounds(path),
    thickness: 0.2,
    evidence: 'Crossing partition',
  });
  const p = f.planner.preview(f.a, f.transform, { floorId, edits: [{ candidateId: 'cross', as: 'wall' }] });
  expect(p.topology.junctions.filter(j => j.degree === 4)).toHaveLength(1);
  await f.planner.apply(f.a, f.transform, p);
  expect(f.planner.decisions.find(d => d.candidateId === 'partition')!.modelIds).toHaveLength(2);
  expect(f.planner.decisions.find(d => d.candidateId === 'shell')!.modelIds).toHaveLength(8);
});

it('preserves an explicit unwalled opening and courtyard holes when deriving rooms', async () => {
  const f = fixture();
  f.a.candidates = f.a.candidates.filter(c => c.id !== 'partition');
  for (const [id, path] of [
    [
      'lower',
      [
        ['M', 6, 0],
        ['L', 6, 3.5],
      ],
    ],
    [
      'upper',
      [
        ['M', 6, 4.5],
        ['L', 6, 8],
      ],
    ],
    [
      'gap',
      [
        ['M', 6, 3.5],
        ['L', 6, 4.5],
      ],
    ],
  ] as [string, VectorCommand[]][])
    f.a.candidates.push({
      id,
      kind: 'wall',
      path,
      bounds: vectorBounds(path),
      thickness: 0.2,
      evidence: 'Fixture gap',
    });
  const edits = [
    { candidateId: 'shell', as: 'wall' },
    { candidateId: 'lower', as: 'wall' },
    { candidateId: 'upper', as: 'wall' },
    { candidateId: 'gap', as: 'boundary' },
    { candidateId: 'left', as: 'room' },
    { candidateId: 'right', as: 'room' },
  ];
  const p = f.planner.preview(f.a, f.transform, { floorId, edits });
  await f.planner.apply(f.a, f.transform, p);
  expect(f.current().virtualBoundaries).toHaveLength(1);
  const rooms = f.current().objects.filter(o => o.kind === 'room');
  expect(findRoute(f.current(), rooms[0].id, rooms[1].id)).toBeTruthy();
  const h = fixture();
  const path: VectorCommand[] = [['M', 4, 2], ['L', 8, 2], ['L', 8, 6], ['L', 4, 6], ['Z']];
  h.a.candidates.push({
    id: 'courtyard',
    kind: 'outline',
    path,
    bounds: vectorBounds(path),
    evidence: 'Open courtyard',
  });
  const hole = h.planner.preview(h.a, h.transform, {
    floorId,
    edits: [
      { candidateId: 'shell', as: 'wall' },
      { candidateId: 'courtyard', as: 'boundary' },
      { candidateId: 'left', as: 'room' },
    ],
  });
  await h.planner.apply(h.a, h.transform, hole);
  expect(hole.rooms[0].holes).toBe(1);
  expect(objectArea(h.current().objects[0])).toBeCloseTo(11.8 * 7.8 - 16);
  expect(boundaryRegions(h.current(), floorId)).toHaveLength(2);
});
