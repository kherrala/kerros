import { entryInto, perimeter, zoneSpaces, type Portal, type ProjectDocument, type Zone } from '@kerros/schema';

export interface DirectionalCrossing {
  key: string;
  portalId: string;
  openingId?: string;
  fromSpaceId: string;
  toSpaceId: string;
  zoneId: string;
  entering: boolean;
  attests: NonNullable<Portal['attests']>;
}

export function directionalCrossings(project: ProjectDocument, zone: Zone): DirectionalCrossing[] {
  const inside = new Set(zoneSpaces(project, zone));
  return perimeter(project, zone).flatMap(portal => {
    const crossings: DirectionalCrossing[] = [];
    for (const [from, to] of [
      [portal.a, portal.b],
      [portal.b, portal.a],
    ]) {
      if (entryInto(portal, to) === null) continue;
      crossings.push({
        // The same physical direction has the same key from either adjacent zone.
        key: JSON.stringify([portal.id, from, to]),
        portalId: portal.id,
        openingId: portal.openingId,
        fromSpaceId: from,
        toSpaceId: to,
        zoneId: zone.id,
        entering: inside.has(to),
        attests: portal.attests ?? 'assumed',
      });
    }
    return crossings;
  });
}
