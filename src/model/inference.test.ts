import { describe, expect, it } from 'vitest';
import {
  divideSpaces,
  inferOpenBoundaries,
  inferPortals,
  mergeSpaces,
  refreshPortals,
  spacesRejoinedBy,
} from './inference';
import { spaces } from './spaces';
import { validateProject } from './validate';
import { addFloor, addPortal as portal, addSpace as space, newProject } from './testFixtures';
import { addBarrier, objectArea, rectangle } from './geometry';

describe('open boundaries — the connections with no door in them', () => {
  /** Two 6 x 6 rooms side by side, sharing the edge at x = 3. */
  const pair = () => {
    const p = newProject();
    space(p, 'left', 'floor-ground', [0, 0]);
    space(p, 'right', 'floor-ground', [6, 0]);
    p.objects.find(o => o.id === 'left')!.rings = [rectangle([0, 0], 6, 6)];
    p.objects.find(o => o.id === 'right')!.rings = [rectangle([6, 0], 6, 6)];
    return p;
  };
  it('joins two spaces that simply run into each other', () => {
    const found = inferOpenBoundaries(pair());
    expect(found).toHaveLength(1);
    expect([found[0].a, found[0].b].sort()).toEqual(['left', 'right']);
  });
  it('marks the crossing as unobservable, because nothing watches an open edge', () => {
    expect(inferOpenBoundaries(pair())[0].attests).toBe('none');
  });
  it('does not join them through a wall', () => {
    const p = pair();
    addBarrier(p, [3, -3], [3, 3], 'floor-ground', 'wall');
    expect(inferOpenBoundaries(p)).toEqual([]);
  });
  it('ignores spaces that only brush at a corner', () => {
    const p = newProject();
    space(p, 'a', 'floor-ground', [0, 0]);
    space(p, 'b', 'floor-ground', [6, 6]);
    p.objects.find(o => o.id === 'a')!.rings = [rectangle([0, 0], 6, 6)];
    p.objects.find(o => o.id === 'b')!.rings = [rectangle([6, 6], 6, 6)];
    expect(inferOpenBoundaries(p)).toEqual([]);
  });
  it('lets you out of a lift car onto the lobby it opens into', () => {
    // The case that was silently broken: a car abuts its lobby with no door object between them,
    // so door-only inference found nothing and every landing was a dead end.
    const p = newProject();
    space(p, 'lobby', 'floor-ground', [0, 0]);
    space(p, 'car', 'floor-ground', [5, 0], 'elevator');
    p.objects.find(o => o.id === 'lobby')!.rings = [rectangle([0, 0], 8, 8)];
    p.objects.find(o => o.id === 'car')!.rings = [rectangle([6, 0], 4, 4)];
    const found = inferOpenBoundaries(p);
    expect(found).toHaveLength(1);
    expect([found[0].a, found[0].b].sort()).toEqual(['car', 'lobby']);
  });
});

describe('a shaft stands on every floor it serves', () => {
  /** One lift drawn once, told it serves three levels, with a lobby beside it on each. This is how a
   *  plan that draws its cores once is authored; the alternative — a landing object per storey — is
   *  covered by the cases above, because those landings are ordinary spaces on their own floors. */
  const tower = () => {
    const p = newProject();
    addFloor(p, 'floor-1', 4);
    addFloor(p, 'floor-2', 8);
    space(p, 'lift', 'floor-ground', [0, 0], 'elevator');
    p.objects.find(o => o.id === 'lift')!.servedFloorIds = ['floor-ground', 'floor-1', 'floor-2'];
    for (const [id, floor] of [
      ['lobby-g', 'floor-ground'],
      ['lobby-1', 'floor-1'],
      ['lobby-2', 'floor-2'],
    ] as const)
      space(p, id, floor, [4, 0]);
    return p;
  };

  it('is entered from the lobby on each floor, not only the one it is filed under', () => {
    // A ten-storey lift found exactly one way in reads as a cupboard in the basement. The floors a
    // shaft serves are a claim about where it stands, and open-boundary inference has to walk it on
    // all of them or the model says the lift only opens in the basement.
    const found = inferOpenBoundaries(tower());
    const lobbies = found
      .filter(f => f.a === 'lift' || f.b === 'lift')
      .map(f => (f.a === 'lift' ? f.b : f.a))
      .sort();
    expect(lobbies).toEqual(['lobby-1', 'lobby-2', 'lobby-g']);
  });

  it('does not join two lobbies to each other just because a lift passes both', () => {
    // Standing the shaft on every floor must not smuggle those floors into one another: the lobbies
    // meet the lift, and nothing else.
    const found = inferOpenBoundaries(tower());
    const between = found.filter(f => f.a.startsWith('lobby') && f.b.startsWith('lobby'));
    expect(between).toEqual([]);
  });

  it('leaves a shaft that serves one floor where it is', () => {
    const p = tower();
    p.objects.find(o => o.id === 'lift')!.servedFloorIds = ['floor-ground'];
    const lobbies = inferOpenBoundaries(p)
      .filter(f => f.a === 'lift' || f.b === 'lift')
      .map(f => (f.a === 'lift' ? f.b : f.a));
    expect(lobbies).toEqual(['lobby-g']);
  });
});

describe('holes are boundaries too', () => {
  it('connects a pavilion standing in a courtyard', () => {
    const p = newProject();
    space(p, 'plate', 'floor-ground', [0, 0], 'zone');
    space(p, 'pavilion', 'floor-ground', [0, 0]);
    p.objects.find(o => o.id === 'plate')!.rings = [rectangle([0, 0], 40, 40), rectangle([0, 0], 16, 16)];
    p.objects.find(o => o.id === 'pavilion')!.rings = [rectangle([0, 0], 15.4, 15.4)];
    expect(inferOpenBoundaries(p)).toHaveLength(1);
  });
  it('finds nothing across an empty void', () => {
    const p = newProject();
    space(p, 'plate', 'floor-ground', [0, 0], 'zone');
    p.objects.find(o => o.id === 'plate')!.rings = [rectangle([0, 0], 40, 40), rectangle([0, 0], 16, 16)];
    expect(inferOpenBoundaries(p)).toEqual([]);
  });
});

describe('re-reading portals keeps what a person decided', () => {
  /** Two abutting rooms (an open boundary), plus a doored pair behind a wall further north. */
  const plan = () => {
    const p = newProject();
    space(p, 'left', 'floor-ground', [0, 0]);
    space(p, 'right', 'floor-ground', [6, 0]);
    p.objects.find(o => o.id === 'left')!.rings = [rectangle([0, 0], 6, 6)];
    p.objects.find(o => o.id === 'right')!.rings = [rectangle([6, 0], 6, 6)];
    space(p, 'store', 'floor-ground', [0, 20]);
    space(p, 'yard', 'floor-ground', [6, 20]);
    p.objects.find(o => o.id === 'store')!.rings = [rectangle([0, 20], 6, 6)];
    p.objects.find(o => o.id === 'yard')!.rings = [rectangle([6, 20], 6, 6)];
    addBarrier(p, [3, 17], [3, 23], 'floor-ground', 'wall');
    const door = space(p, 'door-1', 'floor-ground', [3, 20], 'door');
    p.objects.find(o => o.id === 'door-1')!.rotation = 90; // faces across the wall
    p.objects.find(o => o.id === 'door-1')!.barrierId = p.barriers.at(-1)!.id;
    p.objects.find(o => o.id === 'door-1')!.offset = 3;
    return { p, door };
  };
  it('re-reads portals from the plan but keeps hand-authored ones', () => {
    const { p } = plan();
    const mine = portal(p, 'left', 'right', { passage: 'a-to-b' }); // a decision inference cannot make
    refreshPortals(p);
    expect(
      p.portals!.some(x => x.id === mine.id),
      'the hand-made one survives',
    ).toBe(true);
    expect(p.portals!.length, 'and inference still runs').toBeGreaterThan(1);
  });
  it('finds the doorway and the open boundary to begin with', () => {
    const { p } = plan();
    refreshPortals(p);
    expect(p.portals!.some(x => x.id === 'inferred:door-1')).toBe(true);
    expect(p.portals!.some(x => x.id.startsWith('open:'))).toBe(true);
  });
  it('carries a passage sealed by hand across a re-read', () => {
    // The editor edits inferred portals in place — sealing an open boundary, one-waying a door.
    // Re-reading the plan must not quietly reopen what a person shut.
    const { p } = plan();
    refreshPortals(p);
    const boundary = p.portals!.find(x => x.id.startsWith('open:'))!;
    boundary.passage = 'none';
    refreshPortals(p);
    expect(p.portals!.find(x => x.id === boundary.id)?.passage).toBe('none');
  });
  it('carries an attests upgrade across a re-read', () => {
    const { p } = plan();
    refreshPortals(p);
    const doorway = p.portals!.find(x => x.id === 'inferred:door-1')!;
    expect(doorway.attests, 'a plain door is only assumed').toBe('assumed');
    doorway.attests = 'confirmed'; // somebody wired a door monitor
    refreshPortals(p);
    expect(p.portals!.find(x => x.id === 'inferred:door-1')?.attests).toBe('confirmed');
  });
  it('drops the edits with the portal when the plan no longer describes it', () => {
    const { p } = plan();
    refreshPortals(p);
    const boundary = p.portals!.find(x => x.id.startsWith('open:'))!;
    boundary.passage = 'none';
    // Wall the boundary off: the open portal should vanish, sealed or not.
    addBarrier(p, [3, -3], [3, 3], 'floor-ground', 'wall');
    refreshPortals(p);
    expect(p.portals!.some(x => x.id === boundary.id)).toBe(false);
    expect(() => validateProject(p)).not.toThrow();
  });
});

describe('inferring portals from doors', () => {
  it('reads the space on either side of a doored wall', () => {
    const p = newProject();
    space(p, 'store', 'floor-ground', [0, 0]);
    space(p, 'yard', 'floor-ground', [6, 0]);
    p.objects.find(o => o.id === 'store')!.rings = [rectangle([0, 0], 6, 6)];
    p.objects.find(o => o.id === 'yard')!.rings = [rectangle([6, 0], 6, 6)];
    addBarrier(p, [3, -3], [3, 3], 'floor-ground', 'wall');
    const door = space(p, 'door-1', 'floor-ground', [3, 0], 'door');
    p.objects.find(o => o.id === 'door-1')!.barrierId = p.barriers.at(-1)!.id;
    p.objects.find(o => o.id === 'door-1')!.offset = 3;
    const found = inferPortals(p);
    expect(found).toHaveLength(1);
    expect([found[0].a, found[0].b].sort()).toEqual(['store', 'yard']);
    expect(found[0].openingId).toBe(door);
    expect(found[0].attests).toBe('assumed');
  });
  it('skips an opening it cannot resolve rather than guessing', () => {
    const p = newProject();
    space(p, 'store', 'floor-ground', [0, 0]);
    space(p, 'door-1', 'floor-ground', [30, 0], 'door'); // nothing on either side
    expect(inferPortals(p)).toEqual([]);
  });
});

describe('a wall across a space divides it', () => {
  const hall = () => {
    const p = newProject();
    space(p, 'hall', 'floor-ground', [0, 0]);
    p.objects.find(o => o.id === 'hall')!.rings = [rectangle([0, 0], 20, 10)];
    return p;
  };
  it('used to leave one space, so both halves were the same place', () => {
    // The behaviour this replaces, kept as a statement of what was wrong: a wall alone changes
    // nothing about the space it crosses.
    const p = hall();
    addBarrier(p, [0, -6], [0, 6], 'floor-ground', 'wall');
    expect(spaces(p)).toHaveLength(1);
  });
  it('splits the space the wall crosses', () => {
    const p = hall();
    const made = divideSpaces(p, 'floor-ground', [0, -6], [0, 6]);
    expect(made).toHaveLength(1);
    expect(spaces(p)).toHaveLength(2);
    expect(() => validateProject(p)).not.toThrow();
  });
  it('gives both halves the same area, and neither the whole', () => {
    const p = hall();
    divideSpaces(p, 'floor-ground', [0, -6], [0, 6]);
    const areas = spaces(p).map(s => Math.round(objectArea(s)));
    expect(areas).toEqual([100, 100]);
  });
  it('leaves a space alone when the wall only reaches halfway in', () => {
    const p = hall();
    expect(divideSpaces(p, 'floor-ground', [0, -6], [0, 0])).toEqual([]);
    expect(spaces(p)).toHaveLength(1);
  });
  it('leaves a space alone when the wall misses it', () => {
    const p = hall();
    expect(divideSpaces(p, 'floor-ground', [30, -6], [30, 6])).toEqual([]);
    expect(spaces(p)).toHaveLength(1);
  });
  it('divides every space the wall runs through, not just the first', () => {
    const p = hall();
    space(p, 'annexe', 'floor-ground', [0, 0]);
    p.objects.find(o => o.id === 'annexe')!.rings = [rectangle([0, 20], 20, 10)];
    // One long wall crossing both.
    expect(divideSpaces(p, 'floor-ground', [0, -8], [0, 28])).toHaveLength(2);
    expect(spaces(p)).toHaveLength(4);
  });
});

describe('removing a wall that divided a space', () => {
  /** A hall split in two by a wall, exactly as the editor would leave it. */
  const divided = () => {
    const p = newProject();
    p.objects = [];
    p.barriers = [];
    p.junctions = [];
    space(p, 'hall', 'floor-ground', [0, 0]);
    p.objects.find(o => o.id === 'hall')!.rings = [rectangle([0, 0], 20, 10)];
    // The wall comes first, as it does in the editor, and the split follows from it.
    addBarrier(p, [0, -5], [0, 5], 'floor-ground', 'wall');
    const wall = p.barriers.at(-1)!;
    divideSpaces(p, 'floor-ground', [0, -8], [0, 8]);
    const [a, b] = spaces(p);
    return { p, wall, a, b };
  };
  it('names the two spaces the wall was keeping apart', () => {
    const { p, wall, a, b } = divided();
    const pair = spacesRejoinedBy(p, wall.id);
    expect(pair).not.toBeNull();
    expect(pair!.map(s => s.id).sort()).toEqual([a.id, b.id].sort());
  });
  it('says nothing for a wall that divides nothing', () => {
    const { p } = divided();
    addBarrier(p, [40, -5], [40, 5], 'floor-ground', 'wall');
    expect(spacesRejoinedBy(p, p.barriers.at(-1)!.id)).toBeNull();
  });
  it('unites the footprints when a merge is confirmed, and keeps one identity', () => {
    const { p, a, b } = divided();
    const before = objectArea(a) + objectArea(b);
    expect(mergeSpaces(p, a.id, b.id)).toBe(true);
    expect(spaces(p)).toHaveLength(1);
    expect(spaces(p)[0].id, 'the survivor is the one asked for').toBe(a.id);
    expect(Math.round(objectArea(spaces(p)[0])), 'and it covers both halves').toBe(Math.round(before));
    expect(() => validateProject(p)).not.toThrow();
  });
  it('refuses to merge two spaces that do not touch', () => {
    const { p, a } = divided();
    space(p, 'far', 'floor-ground', [80, 80]);
    expect(mergeSpaces(p, a.id, 'far')).toBe(false);
    expect(() => validateProject(p)).not.toThrow();
  });
});
