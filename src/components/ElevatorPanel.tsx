import { useEffect, useMemo, useState } from 'react';
import type { ElevatorControls } from '../model/host';
import type { ProjectDocument, SiteObject } from '../model/types';
import type { WalkController } from '../map/walk';
import { distance } from '../model/geometry';
import { servedFloors, primaryShafts } from '../model/vertical';
import {
  elevatorFacing,
  elevatorLanding,
  elevatorMirrorFace,
  elevatorMirrorPoint,
  insideElevator,
} from '../map/elevators';

export function ElevatorPanel({
  project,
  floorId,
  controls,
  walker,
  riding,
  onRide,
  onFloor,
  requested,
  onWave,
  soundOn,
  onSound,
}: {
  project: ProjectDocument;
  floorId: string | null;
  controls: ElevatorControls;
  walker: { current: WalkController | null };
  riding: string | null;
  onRide(id: string | null): void;
  onFloor?(id: string): void;
  requested: number;
  onWave(): void;
  soundOn: boolean;
  onSound(): void;
}) {
  const banks = useMemo(() => {
    const primary = primaryShafts(project);
    return project.objects.filter(
      o =>
        o.kind === 'elevator' && o.feedId && primary.has(o.id) && servedFloors(project, o).some(f => f.id === floorId),
    );
  }, [project, floorId]);
  const [expanded, setExpanded] = useState(false),
    [chosen, setChosen] = useState<string>();
  const [near, setNear] = useState(false);
  const object = banks.find(o => o.id === (riding ?? chosen)) ?? banks[0];
  const status = controls.statuses.find(s => s.feedId === object?.feedId);
  const accessible = !!status?.open && !status.moving && !status.targetFloorId && status.carFloorId === floorId;
  const safeExit = riding === object?.id && accessible;
  useEffect(() => {
    if (requested) setExpanded(true);
  }, [requested]);
  useEffect(() => {
    if (!object) return;
    const check = () => {
      const at = walker.current?.position;
      if (!at) return;
      setNear(distance(at, elevatorLanding(object)) < 2.5);
      if (insideElevator(object, at) && accessible && !riding) {
        onRide(object.id);
        setExpanded(true);
      } else if (!insideElevator(object, at) && safeExit) onRide(null);
    };
    check();
    const timer = setInterval(check, 120);
    return () => clearInterval(timer);
  }, [object, accessible, riding, safeExit, walker, onRide]);
  useEffect(() => {
    if (riding && status?.carFloorId && !status.targetFloorId && status.carFloorId !== floorId)
      onFloor?.(status.carFloorId);
  }, [riding, status?.carFloorId, status?.targetFloorId, floorId, onFloor]);
  if (!object) return null;
  const floors = servedFloors(project, object).slice().reverse();
  const at = project.floors.find(f => f.id === status?.carFloorId);
  const destination = project.floors.find(f => f.id === status?.targetFloorId);
  const board = (o: SiteObject) => {
    if (!accessible || !near) return;
    onRide(o.id);
    walker.current?.place(o.position, -elevatorFacing(o));
  };
  return (
    <aside className="walk-elevator" aria-label="Elevator controls">
      <button className="elevator-toggle" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
        Elevator controls <span>{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="elevator-body">
          {banks.length > 1 ? (
            <select
              aria-label="Choose elevator"
              value={object.id}
              disabled={!!riding}
              onChange={e => setChosen(e.target.value)}
            >
              {banks.map(o => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{object.name}</strong>
          )}
          <p role="status">
            {destination ? `Travelling to ${destination.name}` : `${status?.label ?? 'Waiting'} · ${at?.name ?? '—'}`}
          </p>
          {riding ? (
            <p>You are inside the elevator.</p>
          ) : (
            <>
              <button disabled={!status || status.moving} onClick={() => controls.call(object.feedId!, floorId!)}>
                Call to this floor
              </button>
              <button disabled={!accessible || !near} onClick={() => board(object)}>
                Enter elevator
              </button>
              {!near && <small>Walk to the elevator doors to enter.</small>}
            </>
          )}
          {riding && (
            <div className="elevator-floors" aria-label="Destination floor">
              {floors.map(f => (
                <button
                  key={f.id}
                  aria-pressed={f.id === floorId}
                  disabled={!status || status.moving || f.id === floorId}
                  onClick={() => controls.call(object.feedId!, f.id)}
                >
                  {f.code} · {f.name}
                </button>
              ))}
            </div>
          )}
          {riding && (
            <>
              <button aria-pressed={soundOn} onClick={onSound}>
                {soundOn ? 'Cabin music on' : 'Cabin music muted'} · M
              </button>
              {elevatorMirrorFace(object) && (
                <div className="elevator-door-buttons">
                  <button onClick={() => walker.current?.lookAt(elevatorMirrorPoint(object))}>Look in mirror</button>
                  <button onClick={onWave}>Wave</button>
                </div>
              )}
            </>
          )}
          <div className="elevator-door-buttons">
            <button
              disabled={!status || status.moving || status.carFloorId !== floorId}
              onClick={() => controls.hold(object.feedId!, !status?.open)}
            >
              {status?.open ? 'Close doors' : 'Open doors'}
            </button>
            {riding && (
              <button
                disabled={!safeExit}
                onClick={() => {
                  onRide(null);
                  walker.current?.place(elevatorLanding(object));
                }}
              >
                Exit elevator
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
