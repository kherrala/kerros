// SAMPLE INTEGRATION CODE — a host's own controls over its own feed.
//
// `StatusFeed` is deliberately read-only: a reading says what something IS DOING, and how you make it
// do something else is a question about your building management system, not about Kerros. So this
// panel is not part of the viewer library. It is what a host would write: a little simulated lift
// controller that holds the readings it would otherwise receive over the wire, and hands them to
// FloorViewer exactly as a real feed's would arrive.
//
// The sequencing matters and belongs here rather than in the renderer. A real controller reports
// "moving", then "arrived", then "doors open" — three readings over time. The renderer only ever sees
// one snapshot, so it cannot know a ride has finished; it draws the doors shut until the car is
// standing where the reading says it is. This panel times the arrival the same way the building would
// and sends the door reading after it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, DoorOpen, Minus } from 'lucide-react';
import type { Floor, ProjectDocument, SiteObject, StatusReading } from '@kerros/viewer';

/** Metres per second, and the seconds a lift holds its doors. An ordinary passenger lift. */
const SPEED = 1.5;
const DWELL = 6000;

export interface LiftState {
  carFloorId: string;
  open: boolean;
}

/** Every lift in the document that is bound to a feed, with the levels it serves. A lift with no
 *  `feedId` has nothing to report and nothing to command — the binding is what makes it live. */
export function lifts(project: ProjectDocument): { object: SiteObject; floors: Floor[] }[] {
  return project.objects
    .filter(o => o.kind === 'elevator' && o.feedId)
    .map(object => ({
      object,
      floors: [...new Set(object.servedFloorIds ?? (object.floorId ? [object.floorId] : []))]
        .map(id => project.floors.find(f => f.id === id))
        .filter((f): f is Floor => !!f)
        .sort((a, b) => b.elevation - a.elevation),
    }))
    .filter(l => l.floors.length > 1);
}

/** Hold the simulated readings and the timers that move them along. Returns the readings to hand
 *  FloorViewer, plus the one command a lift really has: go there, and open when you arrive. */
export function useLiftController(project: ProjectDocument) {
  const [state, setState] = useState<Map<string, LiftState>>(new Map());
  const timers = useRef<number[]>([]);
  const banks = useMemo(() => lifts(project), [project]);

  // Park every lift at the bottom of its shaft, which is where an idle one waits.
  useEffect(() => {
    setState(new Map(banks.map(l => [l.object.feedId!, { carFloorId: l.floors.at(-1)!.id, open: false }])));
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [banks]);

  const call = useCallback(
    (feedId: string, floorId: string) => {
      const bank = banks.find(l => l.object.feedId === feedId);
      const now = state.get(feedId);
      if (!bank || !now) return;
      const from = bank.floors.find(f => f.id === now.carFloorId),
        to = bank.floors.find(f => f.id === floorId);
      if (!to) return;
      // Doors shut first, then the ride, then they open — the order a lift does it in, and the order
      // the readings would arrive in. Timed off the distance, so a long ride takes longer.
      const ride = (Math.abs((to.elevation ?? 0) - (from?.elevation ?? 0)) / SPEED) * 1000;
      setState(m => new Map(m).set(feedId, { carFloorId: floorId, open: false }));
      timers.current.forEach(clearTimeout);
      timers.current = [
        window.setTimeout(() => setState(m => new Map(m).set(feedId, { carFloorId: floorId, open: true })), ride + 250),
        window.setTimeout(
          () => setState(m => new Map(m).set(feedId, { carFloorId: floorId, open: false })),
          ride + 250 + DWELL,
        ),
      ];
    },
    [banks, state],
  );

  const hold = useCallback((feedId: string, open: boolean) => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setState(m => {
      const now = m.get(feedId);
      return now ? new Map(m).set(feedId, { ...now, open }) : m;
    });
  }, []);

  const statuses = useMemo<StatusReading[]>(
    () =>
      [...state].map(([feedId, s]) => ({
        feedId,
        tone: 'normal' as const,
        label: s.open ? 'Doors open' : 'Standing',
        carFloorId: s.carFloorId,
        open: s.open,
        timestamp: Date.now(),
      })),
    [state],
  );

  return { banks, state, statuses, call, hold };
}

export function LiftPanel({
  project,
  controller,
  onFloor,
}: {
  project: ProjectDocument;
  controller: ReturnType<typeof useLiftController>;
  onFloor?: (floorId: string) => void;
}) {
  const { banks, state, call, hold } = controller;
  if (!banks.length) return null;
  return (
    <div className="lift-panel">
      <h3>Lifts</h3>
      {banks.map(({ object, floors }) => {
        const now = state.get(object.feedId!);
        const at = project.floors.find(f => f.id === now?.carFloorId);
        return (
          <section key={object.id}>
            <header>
              <strong>{object.name}</strong>
              <span>{at ? at.name : '—'}</span>
            </header>
            <div className="lift-landings">
              {floors.map(f => {
                const here = f.id === now?.carFloorId;
                return (
                  <button
                    key={f.id}
                    className={here ? 'active' : ''}
                    title={`Send ${object.name} to ${f.name}`}
                    onClick={() => {
                      call(object.feedId!, f.id);
                      onFloor?.(f.id);
                    }}
                  >
                    {here ? (
                      <Minus size={12} />
                    ) : (at?.elevation ?? 0) < f.elevation ? (
                      <ArrowUp size={12} />
                    ) : (
                      <ArrowDown size={12} />
                    )}
                    {f.name}
                  </button>
                );
              })}
            </div>
            <button
              className={`lift-doors ${now?.open ? 'active' : ''}`}
              onClick={() => hold(object.feedId!, !now?.open)}
            >
              <DoorOpen size={13} />
              {now?.open ? 'Close doors' : 'Open doors'}
            </button>
          </section>
        );
      })}
    </div>
  );
}
