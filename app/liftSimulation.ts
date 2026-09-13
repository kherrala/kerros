import type { Floor, ProjectDocument, SiteObject } from '@kerros/schema';

export interface LiftState {
  carFloorId: string;
  targetFloorId?: string;
  open: boolean;
  phase: 'standing' | 'closing' | 'moving' | 'opening';
  carTravelSeconds?: number;
}
const CLOSE_MS = 450,
  TRAVEL_MS = 850,
  OPEN_MS = 650;
export function lifts(project: ProjectDocument): { object: SiteObject; floors: Floor[] }[] {
  const seen = new Set<string>();
  return project.objects
    .filter(o => {
      if (o.kind !== 'elevator' || !o.feedId || seen.has(o.feedId)) return false;
      seen.add(o.feedId);
      return true;
    })
    .map(object => ({
      object,
      floors: [...new Set(object.servedFloorIds ?? [object.floorId])]
        .map(id => project.floors.find(f => f.id === id))
        .filter((f): f is Floor => !!f)
        .sort((a, b) => b.elevation - a.elevation),
    }))
    .filter(l => l.floors.length > 1);
}

/** Host-owned simulation. One independent sequence per car, with doors closed before travel and
 * a reported arrival before opening. Readings never pretend that a moving car has already arrived. */
export class LiftSimulation {
  readonly state = new Map<string, LiftState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private banks: ReturnType<typeof lifts>,
    private changed: () => void,
  ) {
    for (const bank of banks)
      this.state.set(bank.object.feedId!, {
        carFloorId: bank.floors.at(-1)!.id,
        open: false,
        phase: 'standing',
      });
  }
  private set(id: string, state: LiftState) {
    this.state.set(id, state);
    this.changed();
  }
  private later(id: string, ms: number, action: () => void) {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        action();
      }, ms),
    );
  }
  call = (id: string, floorId: string) => {
    const bank = this.banks.find(b => b.object.feedId === id),
      now = this.state.get(id);
    const to = bank?.floors.find(f => f.id === floorId),
      from = bank?.floors.find(f => f.id === now?.carFloorId);
    if (!now || !to || !from || now.phase !== 'standing') return;
    if (floorId === now.carFloorId) return this.hold(id, true);
    this.set(id, { ...now, open: false, phase: 'closing' });
    this.later(id, CLOSE_MS, () => {
      const travel = Math.min(TRAVEL_MS, (Math.abs(to.elevation - from.elevation) / 1.5) * 1000);
      this.set(id, { ...now, open: false, phase: 'moving', targetFloorId: floorId, carTravelSeconds: travel / 1000 });
      this.later(id, travel, () => {
        this.hold(id, true, floorId);
      });
    });
  };
  hold = (id: string, open: boolean, arrived?: string) => {
    const now = this.state.get(id);
    if (!now || (!arrived && (now.phase === 'moving' || now.phase === 'closing'))) return;
    clearTimeout(this.timers.get(id));
    // Report an open door after its leaves have cleared the doorway. Consumers can board safely.
    const carFloorId = arrived ?? now.carFloorId;
    this.set(id, { carFloorId, open, phase: open ? 'opening' : 'closing' });
    this.later(id, OPEN_MS, () => {
      this.set(id, { carFloorId, open, phase: 'standing' });
      // Hold open until a passenger selects a destination or closes the doors.
    });
  };
  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
