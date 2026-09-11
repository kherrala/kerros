import type { StatusFeed, StatusReading } from '@kerros/viewer/host';

export function createSnapshotFeed() {
  let current: StatusReading[] = [];
  const listeners = new Set<(snapshot: StatusReading[]) => void>();

  const feed: StatusFeed = {
    subscribe(project, listener) {
      const bindings = new Set(project.objects.flatMap(o => (o.feedId ? [o.feedId] : [])));
      const send = (snapshot: StatusReading[]) => {
        listener(structuredClone(snapshot.filter(reading => bindings.has(reading.feedId))));
      };
      listeners.add(send);
      send(current);
      return () => {
        listeners.delete(send);
      };
    },
  };

  return {
    feed,
    publish(snapshot: readonly StatusReading[]) {
      const unique = new Map(snapshot.map(reading => [reading.feedId, reading]));
      current = structuredClone([...unique.values()]);
      for (const send of listeners) send(current);
    },
  };
}
