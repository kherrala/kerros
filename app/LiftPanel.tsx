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
import { ArrowDown, ArrowUp, DoorOpen, Minus, Pause, Play } from 'lucide-react';
import type { ProjectDocument, SiteObject, StatusReading } from '@kerros/viewer';
import { lifts, LiftSimulation, type LiftState } from './liftSimulation';
export { lifts } from './liftSimulation';

export interface EscalatorState {
  running: boolean;
  travel: 'up' | 'down';
}

/** Every escalator bound to a feed. An escalator has two things a building can tell you about it and
 *  two things a building can do to it: it is running or it is not, and it is carrying people up or
 *  down — a station bank flips at the peak. Both arrive as readings, the same as a lift's car. */
export function escalators(project: ProjectDocument): SiteObject[] {
  return project.objects.filter(o => o.kind === 'stairs' && o.stairModel === 'escalator' && o.feedId);
}

/** Hold the simulated readings and the timers that move them along. Returns the readings to hand
 *  FloorViewer, plus the one command a lift really has: go there, and open when you arrive. */
export function useLiftController(project: ProjectDocument) {
  const [state, setState] = useState<Map<string, LiftState>>(new Map());
  const [steps, setSteps] = useState<Map<string, EscalatorState>>(new Map());
  const simulation = useRef<LiftSimulation | null>(null);
  const banks = useMemo(() => lifts(project), [project]);
  const stairs = useMemo(() => escalators(project), [project]);

  // An escalator starts the way the document says it was built, and running — which is the state a
  // working building is in almost all of the time.
  useEffect(() => {
    setSteps(new Map(stairs.map(o => [o.feedId!, { running: true, travel: o.travel ?? 'up' }])));
  }, [stairs]);

  const bankKey = JSON.stringify(banks.map(b => [b.object.feedId, b.floors.map(f => [f.id, f.elevation])]));
  useEffect(() => {
    const controller = new LiftSimulation(banks, () => setState(new Map(controller.state)));
    simulation.current = controller;
    setState(new Map(controller.state));
    return () => {
      controller.dispose();
      simulation.current = null;
    };
  }, [bankKey]);
  const call = useCallback((feedId: string, floorId: string) => simulation.current?.call(feedId, floorId), []);
  const hold = useCallback((feedId: string, open: boolean) => simulation.current?.hold(feedId, open), []);

  const run = useCallback((feedId: string, running: boolean) => {
    setSteps(m => {
      const now = m.get(feedId);
      return now ? new Map(m).set(feedId, { ...now, running }) : m;
    });
  }, []);

  const reverse = useCallback((feedId: string) => {
    setSteps(m => {
      const now = m.get(feedId);
      return now ? new Map(m).set(feedId, { ...now, travel: now.travel === 'up' ? 'down' : 'up' }) : m;
    });
  }, []);

  const statuses = useMemo<StatusReading[]>(
    () => [
      ...[...state].map(([feedId, s]) => ({
        feedId,
        tone: 'normal' as const,
        label:
          s.phase === 'moving'
            ? 'Moving'
            : s.phase === 'opening'
              ? 'Opening doors'
              : s.phase === 'closing'
                ? 'Closing doors'
                : s.open
                  ? 'Doors open'
                  : 'Standing',
        targetFloorId: s.targetFloorId,
        carTravelSeconds: s.carTravelSeconds,
        moving: s.phase !== 'standing',
        carFloorId: s.carFloorId,
        open: s.open,
        timestamp: Date.now(),
      })),
      // A stopped escalator is not an alarm — it is a stair. Whether a host calls that a warning is
      // its own judgement, and this one does not; `running` is what the thing is doing, and `tone`
      // is whether to worry, which is exactly why they are separate fields.
      ...[...steps].map(([feedId, s]) => ({
        feedId,
        tone: 'normal' as const,
        label: s.running ? `Running ${s.travel}` : 'Stopped',
        running: s.running,
        travel: s.travel,
        timestamp: Date.now(),
      })),
    ],
    [state, steps],
  );

  return { banks, stairs, state, steps, statuses, call, hold, run, reverse };
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
  const { banks, stairs, state, steps, call, hold, run, reverse } = controller;
  if (!banks.length && !stairs.length) return null;
  return (
    <div className="lift-panel">
      {banks.length > 0 && <h3>Lifts</h3>}
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
                    disabled={now?.phase !== 'standing'}
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
              disabled={now?.phase !== 'standing'}
              onClick={() => hold(object.feedId!, !now?.open)}
            >
              <DoorOpen size={13} />
              {now?.open ? 'Close doors' : 'Open doors'}
            </button>
          </section>
        );
      })}
      {stairs.length > 0 && <h3>Escalators</h3>}
      {stairs.map(object => {
        const now = steps.get(object.feedId!);
        return (
          <section key={object.id}>
            <header>
              <strong>{object.name}</strong>
              <span>{now?.running ? `Running ${now.travel}` : 'Stopped'}</span>
            </header>
            <div className="lift-landings">
              <button
                className={now?.running ? 'active' : ''}
                title={`${now?.running ? 'Stop' : 'Start'} ${object.name}`}
                onClick={() => run(object.feedId!, !now?.running)}
              >
                {now?.running ? <Pause size={12} /> : <Play size={12} />}
                {now?.running ? 'Stop' : 'Start'}
              </button>
              <button title={`Reverse ${object.name}`} onClick={() => reverse(object.feedId!)}>
                {now?.travel === 'down' ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
                Reverse
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
