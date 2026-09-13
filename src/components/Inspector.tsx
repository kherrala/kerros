import { useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Camera,
  Compass,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Eye,
  Copy,
  Layers,
  Layers3,
  LockKeyhole,
  MoreHorizontal,
  ShieldCheck,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import type { Barrier, Drawing, Floor, Portal, ProjectDocument, SiteObject } from '../model/types';
import type { StatusReading } from '../model/live';
import type { StatusPanelContext } from '../model/host';
import { isArea, isOpening, isSpace } from '../model/types';
import { barrierEnds, distance, moveOrigin, objectArea, objectPosition } from '../model/geometry';
import { entryInto, zoneSpaces } from '../model/ontology';
import { coverageOf } from '../model/coverage';
import { spaceAt } from '../model/spaces';
import { connectSpace, disconnectSpace } from '../model/boundaries';
import { statusLabel, statusTone } from '../adapters/status';
import { EntityIcon } from './Icons';
import { Choice, Field, Toggle } from './controls';
import { DEFAULT_LIGHT, kelvinColor, LAMPS, lampFor } from '../map/lighting';
import { AMBIENCES } from '../map/ambience';

interface Props {
  project: ProjectDocument;
  floorId: string | null;
  selected: string | null;
  statuses: Map<string, StatusReading>;
  /** Whether the host supplied a StatusFeed at all. False hides every live-status surface — a
   *  rollup of bindings that can only ever read "unknown" is worse than no rollup. */
  monitoring: boolean;
  editing: boolean;
  live: boolean;
  renderStatusPanel?: (ctx: StatusPanelContext) => ReactNode;
  onClose: () => void;
  onUpdateObject: (id: string, patch: Partial<SiteObject>) => void;
  /** Apply an arbitrary change through the host's commit/undo path — used for the ontology, which
   *  edits entities beside the object rather than fields on it. */
  onEdit?: (change: (draft: ProjectDocument) => void) => void;
  onUpdateBarrier: (id: string, patch: Partial<Barrier>) => void;
  onUpdateDrawing: (id: string, patch: Partial<Drawing>) => void;
  onUpdateFloor: (id: string, patch: Partial<Floor>) => void;
  /** Set (or clear, with null) the floor a viewer opens this document on. */
  onSetInitialFloor: (id: string | null) => void;
  /** Remove a floor and everything on it (confirms first). */
  onDeleteFloor: (id: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSelect: (id: string) => void;
  /** Open a floor — a lift's levels are the one relation that crosses them. */
  onFloor: (id: string) => void;
  onTraceFootprint: (id: string) => void;
}
/** What a selected thing is joined to, and a way to go there.
 *
 *  The ontology is the half of the model with no shape — a portal is two ids, a zone is a list of
 *  them, a lift is a set of floors it reaches. None of that is visible on the plan, so until now the
 *  only way to read it was the structure panel or the JSON. Everything here is derived; nothing is
 *  stored twice. */
function Connections({
  project,
  object,
  onSelect,
  onFloor,
}: {
  project: ProjectDocument;
  object: SiteObject;
  onSelect: (id: string) => void;
  onFloor: (id: string) => void;
}) {
  const name = (id: string) => project.objects.find(o => o.id === id)?.name ?? 'elsewhere';
  const floorName = (id: string) => project.floors.find(f => f.id === id)?.name ?? id;
  const rows: { key: string; icon: ReactNode; label: string; detail: string; go: () => void }[] = [];
  const kindOf = (id: string) => project.objects.find(o => o.id === id)?.kind ?? '';

  // An opening: the two sides of the portal it carries, and which way each may be crossed.
  const portal = (project.portals ?? []).find(x => x.openingId === object.id);
  if (portal)
    for (const side of [portal.a, portal.b]) {
      const other = side === portal.a ? portal.b : portal.a;
      const way = entryInto(portal, side);
      rows.push({
        key: `p-${side}`,
        icon: <ArrowRight size={14} />,
        label: name(side),
        detail: way ? `enter from ${name(other)}` : `no way through from ${name(other)}`,
        go: () => onSelect(side),
      });
    }

  // A doorway the plan has not joined into a portal still separates two places, and saying which
  // is more use than an empty panel — it also shows WHY there is no portal, when one side turns out
  // to be nowhere in particular.
  if (!portal && isOpening(object.kind) && object.barrierId) {
    const barrier = project.barriers.find(b => b.id === object.barrierId);
    if (barrier) {
      const [a, b] = barrierEnds(project, barrier);
      const len = distance(a, b) || 1;
      const nx = -(b[1] - a[1]) / len,
        ny = (b[0] - a[0]) / len;
      const step = barrier.thickness / 2 + 0.35;
      for (const sign of [1, -1]) {
        const probe: [number, number] = [object.position[0] + nx * step * sign, object.position[1] + ny * step * sign];
        const space = spaceAt(project, object.floorId, probe);
        rows.push({
          key: `s-${sign}`,
          icon: <ArrowRight size={14} />,
          label: space?.name ?? 'Outside any space',
          detail: space ? 'on this side of the doorway' : 'nothing drawn on this side',
          go: () => space && onSelect(space.id),
        });
      }
    }
  }

  // What a camera can see. Derived from its own cone and the walls in the way, so it follows the
  // camera when it is turned or moved rather than going stale.
  if (object.kind === 'camera')
    for (const id of coverageOf(project, object)) {
      rows.push({
        key: `c-${id}`,
        icon: <Eye size={14} />,
        label: name(id),
        detail: `in view · ${kindOf(id)}`,
        go: () => onSelect(id),
      });
    }

  // A shaft: every level it reaches. This is the one relation that crosses floors, so it is also
  // the one you most want a button for.
  if (object.servedFloorIds?.length)
    for (const fid of object.servedFloorIds) {
      const f = project.floors.find(x => x.id === fid);
      if (!f) continue;
      rows.push({
        key: `f-${fid}`,
        icon: <Layers size={14} />,
        label: floorName(fid),
        detail: `${f.elevation.toFixed(1)} m`,
        go: () => onFloor(fid),
      });
    }

  // A space: every portal on it, named by what is on the other side.
  if (isSpace(object.kind))
    for (const p of project.portals ?? []) {
      if (p.a !== object.id && p.b !== object.id) continue;
      const other = p.a === object.id ? p.b : p.a;
      const opening = p.openingId ? project.objects.find(o => o.id === p.openingId) : undefined;
      rows.push({
        key: `w-${p.id}`,
        icon: <ArrowRight size={14} />,
        label: name(other),
        detail: opening ? (opening.name ?? opening.kind) : 'open boundary',
        go: () => onSelect(p.openingId ?? other),
      });
    }

  // The other direction: which cameras have this in frame.
  for (const cam of project.objects)
    if (cam.kind === 'camera' && cam.floorId === object.floorId && cam.id !== object.id)
      if (coverageOf(project, cam).includes(object.id))
        rows.push({
          key: `v-${cam.id}`,
          icon: <Eye size={14} />,
          label: cam.name,
          detail: 'has this in view',
          go: () => onSelect(cam.id),
        });
  const zones = (project.zones ?? []).filter(z => zoneSpaces(project, z).includes(object.id));
  if (!rows.length && !zones.length) return null;
  return (
    <section className="property-section">
      <h3>Connections</h3>
      {rows.map(r => (
        <button className="object-row" key={r.key} onClick={r.go}>
          {r.icon}
          <span>
            {r.label}
            <small>{r.detail}</small>
          </span>
          <ChevronRight size={15} />
        </button>
      ))}
      {zones.map(z => (
        <p className="helper" key={z.id}>
          In zone <strong>{z.name}</strong>
          {z.purpose ? ` · ${z.purpose}` : ''}
        </p>
      ))}
    </section>
  );
}

export function Inspector(props: Props) {
  const { project, floorId, selected, statuses, monitoring, editing } = props;
  // The portal this opening carries, if the plan has one. Direction is the part a person decides:
  // a fire exit lets you out and never back in, and nothing else in the model can say so.
  const portal = (project.portals ?? []).find(x => x.openingId === selected);
  const spaceName = (id: string) => project.objects.find(o => o.id === id)?.name ?? 'elsewhere';
  const object = project.objects.find(o => o.id === selected),
    barrier = project.barriers.find(b => b.id === selected),
    boundary = project.virtualBoundaries?.find(b => b.id === selected),
    drawing = project.drawings.find(d => d.id === selected),
    floor = project.floors.find(f => f.id === floorId);
  const objects = project.objects.filter(o => o.floorId === floorId),
    bound = objects.filter(o => o.feedId),
    allBound = project.objects.filter(o => o.feedId);
  const alarms = allBound.filter(o => statusTone(statuses.get(o.feedId!)) === 'critical');
  // Environment rollup: everything reporting metrics on this floor (or the whole site outdoors).
  const sensed = bound.filter(o => statuses.get(o.feedId!)?.metrics?.occupancy !== undefined);
  const people = (list: SiteObject[]) =>
    list.reduce((n, o) => n + (statuses.get(o.feedId!)?.metrics?.occupancy ?? 0), 0);
  const co2Values = sensed.map(o => statuses.get(o.feedId!)!.metrics!.co2).filter((n): n is number => n !== undefined);
  const busiest = [...sensed].sort(
    (a, b) => (statuses.get(b.feedId!)?.metrics?.occupancy ?? 0) - (statuses.get(a.feedId!)?.metrics?.occupancy ?? 0),
  )[0];
  const status = object?.feedId ? statuses.get(object.feedId) : undefined;
  const [step, setStep] = useState(0.5);
  /** Edit one part of the site anchor. A blank or unparseable box leaves the anchor alone rather
   *  than snapping the whole site to the null island mid-keystroke. */
  const setBearing = (value: number) => {
    if (!Number.isFinite(value)) return;
    const b = ((value % 360) + 360) % 360;
    props.onEdit?.(d => {
      d.origin = (b ? [d.origin[0], d.origin[1], b] : [d.origin[0], d.origin[1]]) as typeof d.origin;
    });
  };
  const turn = (delta: number) => setBearing((project.origin[2] ?? 0) + delta);
  const shift = (east: number, north: number) =>
    props.onEdit?.(d => {
      d.origin = moveOrigin(d.origin, east, north);
    });
  const setOrigin = (part: 0 | 1 | 2, raw: string) => {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) return;
    if (part === 0 && Math.abs(value) > 180) return;
    if (part === 1 && Math.abs(value) > 90) return;
    props.onEdit?.(d => {
      const [lng, lat, bearing = 0] = d.origin;
      const next = part === 0 ? [value, lat, bearing] : part === 1 ? [lng, value, bearing] : [lng, lat, value];
      // A zero bearing is the absence of one — keep the two-element shape the schema started with.
      d.origin = (next[2] ? next : next.slice(0, 2)) as typeof d.origin;
    });
  };
  // Event footage: the camera assigned to watch this object (SiteObject.watchedIds).
  const watcher = object
    ? project.objects.find(c => c.kind === 'camera' && c.watchedIds?.includes(object.id))
    : undefined;
  const update = (patch: Partial<SiteObject>) => object && props.onUpdateObject(object.id, patch);
  const number = (label: string, value: number, key: keyof SiteObject, suffix = 'm', min = 0.01, max?: number) => (
    <Field
      label={label}
      value={value}
      type="number"
      suffix={suffix}
      min={min}
      max={max}
      onChange={v => update({ [key]: Number(v) })}
    />
  );
  const title = object?.name ?? barrier?.name ?? drawing?.name ?? (boundary ? 'Virtual boundary' : undefined);
  return (
    <aside className="inspector">
      <div className="inspector-top">
        <span>{selected ? 'Properties' : 'Space overview'}</span>
        {selected ? (
          <button className="icon-button" aria-label="Close properties" onClick={props.onClose}>
            <X size={17} />
          </button>
        ) : (
          <Layers3 size={17} />
        )}
      </div>
      <div className="inspector-scroll">
        {title ? (
          <>
            <div className="object-title">
              <div className={`object-avatar ${object ? statusTone(status) : ''}`}>
                {object ? (
                  <EntityIcon kind={object.kind} size={25} symbol={object.symbol} travel={object.travel} />
                ) : barrier ? (
                  <EntityIcon kind={barrier.kind} size={25} />
                ) : (
                  <Layers3 size={25} />
                )}
              </div>
              <span className="eyebrow">
                {object?.kind ?? barrier?.kind ?? (boundary ? 'SPACE BOUNDARY' : 'REFERENCE DRAWING')}
              </span>
              <h2>{title}</h2>
              <p>
                {project.floors.find(
                  f => f.id === (object?.floorId ?? barrier?.floorId ?? boundary?.floorId ?? drawing?.floorId),
                )?.name ?? 'Outdoor site'}
              </p>
            </div>
            {monitoring && object?.feedId && !isArea(object.kind) && (
              <section className="property-section">
                <div className={`status-banner ${statusTone(status)}`}>
                  <ShieldCheck size={18} />
                  <strong>{statusLabel(status)}</strong>
                  <span className="live-pip" />
                </div>
                <div className="status-grid">
                  <div>
                    <span>Last update</span>
                    <strong>
                      {status?.timestamp
                        ? new Date(status.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })
                        : '—'}
                    </strong>
                  </div>
                </div>
                {watcher && (
                  <p className="helper">
                    <Camera size={13} /> {watcher.name} covers this {object!.kind}.
                  </p>
                )}
              </section>
            )}
            {status?.metrics && (
              <section className="property-section">
                <h3>Environment</h3>
                <div className="status-grid">
                  {status.metrics.occupancy !== undefined && (
                    <div>
                      <span>People</span>
                      <strong>
                        {status.metrics.occupancy}
                        {status.metrics.capacity ? ` / ${status.metrics.capacity}` : ''}
                      </strong>
                    </div>
                  )}
                  {status.metrics.co2 !== undefined && (
                    <div>
                      <span>CO₂</span>
                      <strong>{status.metrics.co2} ppm</strong>
                    </div>
                  )}
                  {status.metrics.lux !== undefined && (
                    <div>
                      <span>Light</span>
                      <strong>{status.metrics.lux} lx</strong>
                    </div>
                  )}
                  {status.metrics.temperature !== undefined && (
                    <div>
                      <span>Temperature</span>
                      <strong>{status.metrics.temperature} °C</strong>
                    </div>
                  )}
                </div>
                {status.metrics.presence !== undefined && (
                  <p className="helper">
                    {status.metrics.presence ? 'Presence detected in this space.' : 'No presence detected right now.'}
                  </p>
                )}
              </section>
            )}
            {editing && object && (
              <section className="property-section">
                <h3>Object details</h3>
                <Field label="Name" value={object.name} onChange={name => update({ name })} />
                {isArea(object.kind) && (
                  <>
                    <label className="field">
                      <span>Space geometry</span>
                      <select
                        aria-label="Space geometry"
                        value={object.geometry?.mode ?? 'independent'}
                        onChange={e => {
                          const mode = e.target.value;
                          props.onEdit?.(p =>
                            mode === 'boundaries' ? connectSpace(p, object.id) : disconnectSpace(p, object.id),
                          );
                        }}
                      >
                        <option value="boundaries">Shared boundaries</option>
                        <option value="independent">Independent outline</option>
                      </select>
                    </label>
                    <p className="helper">
                      {object.geometry?.mode === 'boundaries'
                        ? 'Move the boundary handles or walls. Adjacent spaces follow the same boundary.'
                        : 'This outline stays where you draw it. Connect it to share edits with adjacent spaces.'}
                    </p>
                    {object.geometry?.mode !== 'boundaries' && (
                      <button
                        className="button secondary"
                        onClick={() => props.onEdit?.(p => connectSpace(p, object.id, 'walls'))}
                      >
                        Use surrounding walls
                      </button>
                    )}
                  </>
                )}
                {object.feedId !== undefined ||
                ['door', 'gate', 'camera', 'reader', 'turnstile', 'elevator'].includes(object.kind) ? (
                  <Field
                    label="Feed ID"
                    value={object.feedId ?? ''}
                    onChange={feedId => update({ feedId: feedId || undefined })}
                  />
                ) : null}
                {object.geometry?.mode !== 'boundaries' && (
                  <div className="field-grid">
                    {object.barrierId ? (
                      number('Along barrier', object.offset ?? 0, 'offset', 'm', 0)
                    ) : (
                      <Field
                        label="East / X"
                        value={object.position[0]}
                        type="number"
                        suffix="m"
                        onChange={v => update({ position: [Number(v), object.position[1]] })}
                      />
                    )}
                    {object.barrierId ? (
                      number('Width', object.width, 'width')
                    ) : (
                      <Field
                        label="North / Y"
                        value={object.position[1]}
                        type="number"
                        suffix="m"
                        onChange={v => update({ position: [object.position[0], Number(v)] })}
                      />
                    )}
                  </div>
                )}
                {!object.barrierId && object.geometry?.mode !== 'boundaries' && (
                  <div className="field-grid">
                    {number('Width', object.width, 'width')}
                    {number('Depth', object.depth, 'depth')}
                  </div>
                )}
                {portal && (
                  <label className="field">
                    <span>Passage</span>
                    <select
                      value={portal.passage ?? 'both'}
                      disabled={!editing}
                      onChange={e => {
                        const passage = e.target.value as NonNullable<Portal['passage']>;
                        props.onEdit?.(d => {
                          const target = d.portals?.find(x => x.id === portal.id);
                          if (target) target.passage = passage === 'both' ? undefined : passage;
                        });
                      }}
                    >
                      <option value="both">Both ways</option>
                      <option value="a-to-b">{`Into ${spaceName(portal.b)} only`}</option>
                      <option value="b-to-a">{`Into ${spaceName(portal.a)} only`}</option>
                      <option value="none">Sealed</option>
                    </select>
                    <small>
                      {`Between ${spaceName(portal.a)} and ${spaceName(portal.b)}. Routing obeys this — a one-way portal is a one-way edge.`}
                    </small>
                  </label>
                )}
                {portal && (
                  <label className="field">
                    <span>Attestation</span>
                    <select
                      value={portal.attests ?? 'assumed'}
                      disabled={!editing}
                      onChange={e => {
                        const attests = e.target.value as NonNullable<Portal['attests']>;
                        props.onEdit?.(d => {
                          const target = d.portals?.find(x => x.id === portal.id);
                          if (target) target.attests = attests;
                        });
                      }}
                    >
                      <option value="confirmed">Confirmed — a sensor sees it</option>
                      <option value="assumed">Assumed — granted, not watched</option>
                      <option value="none">None — a request, not an event</option>
                    </select>
                    <small>
                      How far a crossing here can be trusted to have happened. Anything counting crossings must ignore
                      portals that attest nothing.
                    </small>
                  </label>
                )}
                <div className="field-grid">
                  {number('Height', object.height, 'height', 'm', 0)}
                  {!object.barrierId &&
                    object.geometry?.mode !== 'boundaries' &&
                    number('Rotation', object.rotation, 'rotation', '°', -360, 360)}
                </div>
                {object.rings && (
                  <div className="measurement-row">
                    <span>Net area</span>
                    <strong>{objectArea(object).toFixed(1)} m²</strong>
                  </div>
                )}
                {object.rings && (
                  <label className="field">
                    <span>Fill colour</span>
                    <input
                      aria-label="Fill colour"
                      type="color"
                      value={object.color ?? '#e0e8df'}
                      onChange={e => update({ color: e.target.value })}
                    />
                  </label>
                )}
                {object.rings && (
                  <label className="field">
                    <span>Parent zone</span>
                    <select
                      value={object.parentId ?? ''}
                      onChange={e => update({ parentId: e.target.value || undefined })}
                    >
                      <option value="">None · independent area</option>
                      {project.objects
                        .filter(o => o.id !== object.id && o.floorId === object.floorId && o.kind === 'zone')
                        .map(o => (
                          <option value={o.id} key={o.id}>
                            {o.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {object.kind === 'poi' && (
                  <label className="field">
                    <span>Symbol</span>
                    <select
                      value={object.symbol}
                      onChange={e => update({ symbol: e.target.value as SiteObject['symbol'] })}
                    >
                      <option value="personnel">Personnel entrance</option>
                      <option value="service">Service access</option>
                      <option value="driveway">Main driveway</option>
                      <option value="parking">Parking</option>
                      <option value="assembly">Assembly point</option>
                      <option value="info">Information</option>
                    </select>
                  </label>
                )}
                {isSpace(object.kind) && (
                  <label className="field">
                    <span>Ambient sound</span>
                    <select
                      aria-label="Ambient sound"
                      value={object.ambience?.preset ?? 'floor'}
                      onChange={e =>
                        update({
                          ambience:
                            e.target.value === 'floor'
                              ? undefined
                              : { preset: e.target.value as NonNullable<SiteObject['ambience']>['preset'] },
                        })
                      }
                    >
                      <option value="floor">Same as the floor</option>
                      {AMBIENCES.map(a => (
                        <option value={a.id} key={a.id} title={a.description}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {object.kind === 'light' && object.light && (
                  <>
                    <h3>Ceiling light</h3>
                    <div className="field-grid">
                      {(
                        [
                          ['Colour temperature', 'kelvin', 'K', 1000, 12000],
                          ['Light intensity', 'intensity', 'cd', 0, 10000],
                          ['Light range', 'range', 'm', 0.1, 100],
                          ['Flicker depth', 'flicker', '', 0, 1],
                        ] as const
                      ).map(([label, key, suffix, min, max]) => (
                        <Field
                          key={key}
                          label={label}
                          value={object.light![key] ?? 0}
                          type="number"
                          suffix={suffix}
                          min={min}
                          max={max}
                          onChange={v => update({ light: { ...object.light!, [key]: Number(v) } })}
                        />
                      ))}
                    </div>
                  </>
                )}
                {object.kind === 'camera' && (
                  <>
                    <h3>Illustrative coverage</h3>
                    <div className="field-grid">
                      {number('Field of view', object.coverageAngle ?? 70, 'coverageAngle', '°', 1, 360)}
                      {number('Range', object.coverageRange ?? 12, 'coverageRange')}
                    </div>
                    <p className="helper">
                      Coverage illustrates direction and range; walls do not calculate occlusion.
                    </p>
                    <h3>Watches</h3>
                    {project.objects
                      .filter(
                        x =>
                          x.floorId === object.floorId &&
                          x.id !== object.id &&
                          ['door', 'gate', 'turnstile', 'elevator', 'room', 'zone'].includes(x.kind),
                      )
                      .map(x => ({ x, d: distance(objectPosition(project, x), object.position) }))
                      .sort((a, b) => a.d - b.d)
                      .slice(0, 12)
                      .map(({ x, d }) => (
                        <label className="check-row" key={x.id}>
                          <input
                            type="checkbox"
                            checked={object.watchedIds?.includes(x.id) ?? false}
                            onChange={e =>
                              update({
                                watchedIds: e.target.checked
                                  ? [...(object.watchedIds ?? []), x.id]
                                  : (object.watchedIds ?? []).filter(id => id !== x.id),
                              })
                            }
                          />
                          {x.name}
                          <span>{d.toFixed(0)} m</span>
                        </label>
                      ))}
                    <p className="helper">Watched objects use this camera for event footage.</p>
                  </>
                )}
                {editing && object.kind === 'stairs' && (
                  <>
                    <h3>Stair geometry</h3>
                    <select
                      className="field"
                      value={object.stairModel ?? ''}
                      onChange={e => update({ stairModel: (e.target.value || undefined) as SiteObject['stairModel'] })}
                    >
                      <option value="">Fit to the footprint</option>
                      <option value="straight">Straight flight</option>
                      <option value="switchback">Switchback (half turn)</option>
                      <option value="dogleg">Dogleg (quarter turn)</option>
                      <option value="spiral">Spiral</option>
                      <option value="escalator">Escalator</option>
                    </select>
                    <p className="helper">
                      Left to fit, a run too steep for its footprint is drawn as the stair that turns.
                    </p>
                    {object.stairModel === 'escalator' && (
                      <>
                        <Choice
                          label="Carries you"
                          description="An escalator runs one way — routing rides it that way and walks round to come back"
                          value={object.travel ?? 'up'}
                          options={[
                            { value: 'up', label: 'Up', title: 'From the lower landing to the upper' },
                            { value: 'down', label: 'Down', title: 'From the upper landing to the lower' },
                          ]}
                          onChange={travel => update({ travel })}
                        />
                        {object.feedId && (
                          <p className="helper">
                            {statuses.get(object.feedId)?.running === false
                              ? 'Stopped right now — the plan draws its steps standing still.'
                              : 'Running. A feed may stop it or reverse it; the direction above is how it was built.'}
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
                {editing && object.kind === 'elevator' && (
                  <>
                    <h3>Doors open onto</h3>
                    {(['front', 'right', 'back', 'left'] as const).map(side => (
                      <label className="check-row" key={side}>
                        <input
                          type="checkbox"
                          checked={(object.doorSides ?? ['front']).includes(side)}
                          onChange={e => {
                            const now = new Set(object.doorSides ?? ['front']);
                            if (e.target.checked) now.add(side);
                            else now.delete(side);
                            update({
                              doorSides: now.size
                                ? (['front', 'back', 'left', 'right'] as const).filter(x => now.has(x))
                                : undefined,
                            });
                          }}
                        />
                        {side[0].toUpperCase() + side.slice(1)}
                      </label>
                    ))}
                    <p className="helper">
                      Relative to the lift's own rotation. A level it passes without serving has no doors at all.
                    </p>
                  </>
                )}
                {editing && ['elevator', 'stairs'].includes(object.kind) && (
                  <>
                    <h3>Served floors</h3>
                    {project.floors.map(f => (
                      <label className="check-row" key={f.id}>
                        <input
                          type="checkbox"
                          checked={object.servedFloorIds?.includes(f.id) ?? false}
                          onChange={e =>
                            update({
                              servedFloorIds: e.target.checked
                                ? [...(object.servedFloorIds ?? []), f.id]
                                : object.servedFloorIds?.filter(id => id !== f.id),
                            })
                          }
                        />
                        {f.name}
                        <span>{f.elevation} m</span>
                      </label>
                    ))}
                  </>
                )}
                {object.kind === 'building' && (
                  <button className="button secondary full" onClick={() => props.onTraceFootprint(object.id)}>
                    Create floor walls
                    <ArrowUpRight size={15} />
                  </button>
                )}
              </section>
            )}
            {!editing && object && (
              <section className="property-section">
                <h3>Object details</h3>
                <div className="measurement-row">
                  <span>Type</span>
                  <strong>{object.kind}</strong>
                </div>
                <div className="measurement-row">
                  <span>Position</span>
                  <strong>
                    {objectPosition(project, object)
                      .map(n => n.toFixed(1))
                      .join(', ')}{' '}
                    m
                  </strong>
                </div>
                {object.rings && (
                  <div className="measurement-row">
                    <span>Area</span>
                    <strong>{objectArea(object).toFixed(1)} m²</strong>
                  </div>
                )}
                {object.feedId && <p className="feed-id">{object.feedId}</p>}
              </section>
            )}
            {editing && barrier && (
              <section className="property-section">
                <h3>Barrier geometry</h3>
                <Field
                  label="Name"
                  value={barrier.name}
                  onChange={name => props.onUpdateBarrier(barrier.id, { name })}
                />
                <div className="field-grid">
                  <Field
                    label="Thickness"
                    value={barrier.thickness}
                    type="number"
                    suffix="m"
                    onChange={v => props.onUpdateBarrier(barrier.id, { thickness: Number(v) })}
                  />
                  <Field
                    label="Height"
                    value={barrier.height}
                    type="number"
                    suffix="m"
                    onChange={v => props.onUpdateBarrier(barrier.id, { height: Number(v) })}
                  />
                </div>
                <div className="measurement-row">
                  <span>Length</span>
                  <strong>{distance(...barrierEnds(project, barrier)).toFixed(2)} m</strong>
                </div>
                <p className="helper">
                  Drag the endpoint handles to reshape this segment. Connected walls and attached openings follow.
                </p>
                <h3>Attached objects</h3>
                {project.objects
                  .filter(o => o.barrierId === barrier.id)
                  .map(o => (
                    <button className="object-row" onClick={() => props.onSelect(o.id)} key={o.id}>
                      <EntityIcon kind={o.kind} />
                      <span>{o.name}</span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
              </section>
            )}
            {editing && boundary && (
              <section className="property-section">
                <h3>Virtual boundary</h3>
                <div className="measurement-row">
                  <span>Length</span>
                  <strong>{distance(...barrierEnds(project, boundary)).toFixed(2)} m</strong>
                </div>
                <p className="helper">
                  Drag its handles to reshape the shared division. To remove a division between spaces, choose which
                  space survives the merge.
                </p>
              </section>
            )}
            {editing && drawing && (
              <section className="property-section">
                <h3>Reference image</h3>
                <Field
                  label="Name"
                  value={drawing.name}
                  onChange={name => props.onUpdateDrawing(drawing.id, { name })}
                />
                <Toggle
                  label="Visible"
                  value={drawing.visible}
                  onChange={() => props.onUpdateDrawing(drawing.id, { visible: !drawing.visible })}
                />
                <Toggle
                  label="Lock position"
                  value={drawing.locked}
                  onChange={() => props.onUpdateDrawing(drawing.id, { locked: !drawing.locked })}
                />
                <label className="field">
                  <span>Opacity · {Math.round(drawing.opacity * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={drawing.opacity}
                    onChange={e => props.onUpdateDrawing(drawing.id, { opacity: Number(e.target.value) })}
                  />
                </label>
                {!drawing.locked && (
                  <>
                    <div className="field-grid">
                      <Field
                        label="East / X"
                        value={drawing.origin[0]}
                        type="number"
                        suffix="m"
                        onChange={v => props.onUpdateDrawing(drawing.id, { origin: [Number(v), drawing.origin[1]] })}
                      />
                      <Field
                        label="North / Y"
                        value={drawing.origin[1]}
                        type="number"
                        suffix="m"
                        onChange={v => props.onUpdateDrawing(drawing.id, { origin: [drawing.origin[0], Number(v)] })}
                      />
                    </div>
                    <Field
                      label="Metres per pixel"
                      value={drawing.scale}
                      type="number"
                      step={0.001}
                      min={0.000001}
                      onChange={v => props.onUpdateDrawing(drawing.id, { scale: Number(v) })}
                    />
                    <Field
                      label="Rotation"
                      value={drawing.rotation}
                      type="number"
                      suffix="°"
                      onChange={v => props.onUpdateDrawing(drawing.id, { rotation: Number(v) })}
                    />
                  </>
                )}
              </section>
            )}
            {object && (
              <Connections project={project} object={object} onSelect={props.onSelect} onFloor={props.onFloor} />
            )}
            {monitoring && object?.feedId && props.renderStatusPanel?.({ object, status, editing, live: props.live })}
          </>
        ) : (
          <>
            <div className="overview-hero">
              <div className="overview-art">
                <div className="mini-building">
                  <i />
                  <i />
                  <i />
                  <i />
                  <div className="mini-access">
                    <LockKeyhole size={15} />
                  </div>
                </div>
                <span className="hero-dots" />
              </div>
              <span className="eyebrow">{floor ? 'MAIN BUILDING' : 'SITE & SURROUNDINGS'}</span>
              <h2>{floor?.name ?? 'Outdoor site'}</h2>
              <p>
                {floor
                  ? `Level ${floor.elevation < 0 ? 'B' + project.floors.filter(x => x.buildingId === floor.buildingId && x.elevation < 0 && x.elevation >= floor.elevation).length : project.floors.filter(x => x.buildingId === floor.buildingId && x.elevation >= 0 && x.elevation < floor.elevation).length} · ${floor.elevation.toFixed(1)} m elevation`
                  : project.description}
              </p>
            </div>
            {editing && (
              <section className="property-section">
                <h3>
                  Site anchor <Compass size={15} />
                </h3>
                <p className="helper">
                  Where the plan is pinned and which way it faces — the one thing a drawing cannot tell you. Geometry is
                  untouched: metres stay metres, only the frame moves.
                </p>
                <label className="field">
                  <span>Bearing</span>
                  <input
                    type="range"
                    aria-label="Bearing slider"
                    min={0}
                    max={360}
                    step={0.1}
                    value={((project.origin[2] ?? 0) + 360) % 360}
                    onChange={e => setBearing(Number(e.target.value))}
                  />
                </label>
                <div className="nudge-row">
                  {[-5, -1, -0.1].map(d => (
                    <button className="button secondary small" key={d} onClick={() => turn(d)}>
                      {d}°
                    </button>
                  ))}
                  <input
                    className="nudge-value"
                    aria-label="Bearing"
                    type="number"
                    step={0.1}
                    value={Number((((project.origin[2] ?? 0) + 360) % 360).toFixed(2))}
                    onChange={e => setBearing(Number(e.target.value))}
                  />
                  {[0.1, 1, 5].map(d => (
                    <button className="button secondary small" key={d} onClick={() => turn(d)}>
                      +{d}°
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>Move the site</span>
                </label>
                <div className="nudge-pad">
                  <button className="button secondary small up" onClick={() => shift(0, step)} aria-label="Move north">
                    <ArrowUp size={14} />
                  </button>
                  <button
                    className="button secondary small left"
                    onClick={() => shift(-step, 0)}
                    aria-label="Move west"
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <select
                    className="step"
                    aria-label="Step size"
                    value={step}
                    onChange={e => setStep(Number(e.target.value))}
                  >
                    {[0.1, 0.25, 0.5, 1, 5].map(v => (
                      <option key={v} value={v}>
                        {v} m
                      </option>
                    ))}
                  </select>
                  <button
                    className="button secondary small right"
                    onClick={() => shift(step, 0)}
                    aria-label="Move east"
                  >
                    <ArrowRight size={14} />
                  </button>
                  <button
                    className="button secondary small down"
                    onClick={() => shift(0, -step)}
                    aria-label="Move south"
                  >
                    <ArrowDown size={14} />
                  </button>
                </div>
                <p className="helper">
                  Steps are metres on the ground, north-up — the compass, not the plan's own grid.
                </p>
                <details className="anchor-exact">
                  <summary>Exact coordinates</summary>
                  <div className="field-row">
                    <Field
                      label="Longitude"
                      type="number"
                      step={0.000001}
                      value={project.origin[0]}
                      onChange={v => setOrigin(0, v)}
                      suffix="°"
                    />
                    <Field
                      label="Latitude"
                      type="number"
                      step={0.000001}
                      value={project.origin[1]}
                      onChange={v => setOrigin(1, v)}
                      suffix="°"
                    />
                  </div>
                </details>
              </section>
            )}
            <div className="overview-stats">
              {monitoring ? (
                <div>
                  <strong>{bound.length}</strong>
                  <span>Live bindings</span>
                </div>
              ) : (
                <div>
                  <strong>{objects.length}</strong>
                  <span>Objects here</span>
                </div>
              )}
              <div>
                <strong>{objects.filter(o => o.kind === 'room' || o.kind === 'zone').length}</strong>
                <span>Spaces & zones</span>
              </div>
            </div>
            {monitoring && sensed.length > 0 && (
              <section className="property-section">
                <h3>Occupancy & environment</h3>
                <div className="overview-status">
                  <span className="status-dot normal" />
                  <span>People on this {floor ? 'floor' : 'site'}</span>
                  <strong>{people(sensed)}</strong>
                </div>
                <div className="overview-status">
                  <span className="status-dot normal" />
                  <span>Whole building</span>
                  <strong>{people(allBound)}</strong>
                </div>
                {co2Values.length > 0 && (
                  <div className="overview-status">
                    <span className={`status-dot ${Math.max(...co2Values) > 1000 ? 'warning' : 'normal'}`} />
                    <span>CO₂ · avg / peak</span>
                    <strong>
                      {Math.round(co2Values.reduce((a, b) => a + b, 0) / co2Values.length)} / {Math.max(...co2Values)}{' '}
                      ppm
                    </strong>
                  </div>
                )}
                {busiest && (
                  <button className="alarm-row" onClick={() => props.onSelect(busiest.id)}>
                    <span className="status-dot normal" />
                    <span>
                      {busiest.name}
                      <small>Busiest space · {statuses.get(busiest.feedId!)?.metrics?.occupancy} people</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                )}
              </section>
            )}
            {monitoring && (
              <section className="property-section">
                <h3>
                  Status overview <ShieldCheck size={15} />
                </h3>
                <div className="overview-status">
                  <span className="status-dot normal" />
                  <span>Normal</span>
                  <strong>{bound.filter(o => statusTone(statuses.get(o.feedId!)) === 'normal').length}</strong>
                </div>
                <div className="overview-status">
                  <span className="status-dot critical" />
                  <span>Active alarms</span>
                  <strong>{bound.filter(o => statusTone(statuses.get(o.feedId!)) === 'critical').length}</strong>
                </div>
                <div className="overview-status">
                  <span className="status-dot warning" />
                  <span>Offline / stale / unknown</span>
                  <strong>
                    {bound.filter(o => ['warning', 'unknown'].includes(statusTone(statuses.get(o.feedId!)))).length}
                  </strong>
                </div>
              </section>
            )}
            {monitoring && alarms.length > 0 && (
              <section className="property-section">
                <h3>Site alarms</h3>
                {alarms.map(o => (
                  <button className="alarm-row" onClick={() => props.onSelect(o.id)} key={o.id}>
                    <span className="status-dot critical" />
                    <span>
                      {o.name}
                      <small>{statusLabel(statuses.get(o.feedId!))}</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </section>
            )}
            <section className="property-section">
              <h3>
                Quick access <MoreHorizontal size={16} />
              </h3>
              {bound.slice(0, 4).map(o => (
                <button className="object-row" onClick={() => props.onSelect(o.id)} key={o.id}>
                  <EntityIcon kind={o.kind} />
                  <span>{o.name}</span>
                  <span className={`status-dot ${statusTone(statuses.get(o.feedId!))}`} />
                </button>
              ))}
              {!bound.length && <p className="helper">Give an object a feed id to connect it to your own live data.</p>}
            </section>
            {editing && floor && (
              <section className="property-section">
                <h3>Floor settings</h3>
                <Field
                  label="Floor name"
                  value={floor.name}
                  onChange={name => props.onUpdateFloor(floor.id, { name })}
                />
                <div className="field-grid">
                  <Field
                    label="Elevation"
                    value={floor.elevation}
                    type="number"
                    suffix="m"
                    onChange={v => props.onUpdateFloor(floor.id, { elevation: Number(v) })}
                  />
                  <Field
                    label="Floor height"
                    value={floor.height}
                    type="number"
                    suffix="m"
                    onChange={v => props.onUpdateFloor(floor.id, { height: Number(v) })}
                  />
                </div>
                <Toggle
                  label="Intermediate level"
                  description="An entresol between full floors: the plan shows it over the level below"
                  value={floor.mezzanine ?? false}
                  onChange={() => props.onUpdateFloor(floor.id, { mezzanine: !floor.mezzanine || undefined })}
                />
                <label className="field">
                  <span>Ceiling light</span>
                  <select
                    aria-label="Ceiling light"
                    value={lampFor((floor.light ?? DEFAULT_LIGHT).kelvin).id}
                    onChange={e =>
                      props.onUpdateFloor(floor.id, {
                        light: {
                          ...(floor.light ?? DEFAULT_LIGHT),
                          kelvin: LAMPS.find(l => l.id === e.target.value)!.kelvin,
                        },
                      })
                    }
                  >
                    {LAMPS.map(lamp => (
                      <option value={lamp.id} key={lamp.id}>
                        {lamp.label} · {lamp.kelvin} K
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Ambient sound</span>
                  <select
                    aria-label="Ambient sound"
                    value={floor.ambience?.preset ?? 'silent'}
                    onChange={e =>
                      props.onUpdateFloor(floor.id, {
                        ambience:
                          e.target.value === 'silent'
                            ? undefined
                            : { preset: e.target.value as NonNullable<Floor['ambience']>['preset'] },
                      })
                    }
                  >
                    {AMBIENCES.map(a => (
                      <option value={a.id} key={a.id} title={a.description}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field-grid">
                  <Field
                    label="Colour temperature"
                    value={(floor.light ?? DEFAULT_LIGHT).kelvin}
                    type="number"
                    suffix="K"
                    min={1500}
                    max={12000}
                    step={100}
                    onChange={v =>
                      props.onUpdateFloor(floor.id, {
                        light: {
                          ...(floor.light ?? DEFAULT_LIGHT),
                          kelvin: Math.max(1000, Math.min(12000, Number(v) || DEFAULT_LIGHT.kelvin)),
                        },
                      })
                    }
                  />
                  <Field
                    label="Brightness"
                    value={Math.round((floor.light ?? DEFAULT_LIGHT).level * 100)}
                    type="number"
                    suffix="%"
                    min={0}
                    max={100}
                    step={5}
                    onChange={v =>
                      props.onUpdateFloor(floor.id, {
                        light: {
                          ...(floor.light ?? DEFAULT_LIGHT),
                          level: Math.max(0, Math.min(1, Number(v) / 100)),
                        },
                      })
                    }
                  />
                </div>
                <p className="helper lamp-note">
                  <i style={{ background: kelvinColor((floor.light ?? DEFAULT_LIGHT).kelvin) }} />
                  This level's own lighting, which stays on whatever the sun is doing — it is what keeps the plan
                  legible after dark.
                </p>
                <Toggle
                  label="Open here by default"
                  description="Anyone opening this plan starts on this level instead of the ground floor"
                  value={project.initialFloorId === floor.id}
                  onChange={() => props.onSetInitialFloor(project.initialFloorId === floor.id ? null : floor.id)}
                />
                {project.floors.length > 1 && (
                  <button className="text-button danger" onClick={() => props.onDeleteFloor(floor.id)}>
                    <Trash2 size={14} />
                    Delete this floor
                  </button>
                )}
                <p className="helper">{project.datum}</p>
              </section>
            )}
            <div className="inspector-note">
              <Compass size={17} />
              <p>
                Your space, described.
                <br />
                <span>Select anything on the plan to inspect and edit it.</span>
              </p>
            </div>
          </>
        )}
      </div>
      {selected && editing && (
        <div className="inspector-footer">
          <button
            className="button secondary"
            onClick={props.onDuplicate}
            disabled={!!drawing || !!barrier || !!boundary || !!object?.barrierId}
          >
            <Copy size={15} />
            Duplicate
          </button>
          <button className="button danger-quiet" onClick={props.onDelete}>
            <Trash2 size={16} />
            Delete
          </button>
        </div>
      )}
      {!editing && monitoring && (
        <div className="viewer-note">
          <Unplug size={14} />
          Read-only status feed
        </div>
      )}
    </aside>
  );
}
