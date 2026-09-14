// Browsing the building as a structure rather than a picture.
//
// A map is the wrong instrument for most of what the ontology says. A zone spanning eleven floors, a
// lift shaft, "everywhere a contractor may go" — none of those have a shape, and drawing them on a
// plan either lies about them or hides them. This view reads the same document as a list of what
// groups with what and what opens onto what, which is the form those questions actually take.
import { lazy, Suspense, useMemo, useState } from 'react';
import { isSpace, type Point, type Portal, type ProjectDocument, type SiteObject, type Zone } from '../model/types';
import { addZone, captive, entryInto, perimeter, removeZone, setZoneMembers, zoneSpaces } from '../model/ontology';
import { refreshPortals } from '../model/inference';
const StructureExplorer = lazy(() =>
  import('./StructureExplorer').then(module => ({ default: module.StructureExplorer })),
);
import {
  ChevronDown,
  ChevronRight,
  DoorOpen,
  Layers,
  LocateFixed,
  MoveHorizontal,
  Plus,
  RefreshCw,
  Shapes,
  Trash2,
} from 'lucide-react';

export interface StructureViewProps {
  project: ProjectDocument;
  selected?: string | null;
  /** Fires when a space or opening is picked, so a host can follow along on the plan. */
  onSelect?: (id: string) => void;
  /** Fires alongside onSelect when the pick lives on a particular floor. */
  onFloorChange?: (floorId: string | null) => void;
  onLocate?: (target: StructureTarget) => void;
  onGraphView?: (floorId?: string | null) => void;
  /** Omit to keep the panel read-only. Given, the panel can author zones: the host applies the
   *  mutation to a draft and owns undo, exactly as the map tools do. */
  onEdit?: (change: (draft: ProjectDocument) => void) => void;
}
export interface StructureTarget {
  objectIds?: string[];
  floorId?: string | null;
  position?: Point;
}

const OUTDOORS = 'Outdoor site';
/** Direction, said the way a person would: which way this portal lets you go, relative to a zone. */
function passageLabel(portal: Portal, insideId: string): string {
  const inward = entryInto(portal, insideId) !== null;
  const outward = entryInto(portal, portal.a === insideId ? portal.b : portal.a) !== null;
  if (inward && outward) return 'both ways';
  if (inward) return 'in only';
  if (outward) return 'out only';
  return 'sealed';
}

export function StructureView(props: StructureViewProps) {
  return (
    <Suspense
      fallback={
        <p className="structure-empty" role="status">
          Loading structure…
        </p>
      }
    >
      <StructureExplorer {...props} renderZones={filter => <ZoneList {...props} {...filter} />} />
    </Suspense>
  );
}

function ZoneList({
  project,
  selected,
  onSelect,
  onFloorChange,
  onEdit,
  onLocate,
  query,
  floor,
}: StructureViewProps & { query: string; floor: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const selectedSpace = selected && project.objects.find(o => o.id === selected && isSpace(o.kind));
  const model = useMemo(() => {
    const byId = new Map(project.objects.map(o => [o.id, o]));
    const floors = new Map(project.floors.map(f => [f.id, f.name]));
    const zones = project.zones ?? [];
    const groups = new Map<string, Zone[]>();
    for (const z of zones) {
      const members = zoneSpaces(project, z)
        .map(id => byId.get(id))
        .filter(Boolean);
      const text = [z.name, z.id, z.purpose, ...members.map(o => o?.name)].join(' ').toLowerCase();
      if (query.trim() && !text.includes(query.trim().toLowerCase())) continue;
      if (
        floor !== 'all' &&
        !members.some(o => (o?.floorId ?? 'outdoors') === floor || o?.servedFloorIds?.includes(floor))
      )
        continue;
      const key = z.purpose ?? 'other';
      const list = groups.get(key);
      if (list) list.push(z);
      else groups.set(key, [z]);
    }
    return { byId, floors, groups };
  }, [project, query, floor]);

  const name = (id: string) => model.byId.get(id)?.name ?? 'Unknown';
  const floorOf = (id: string) => {
    const floorId = model.byId.get(id)?.floorId ?? null;
    return { floorId, label: floorId === null ? OUTDOORS : (model.floors.get(floorId) ?? 'Unknown level') };
  };
  const pick = (id: string) => {
    onSelect?.(id);
    onFloorChange?.(floorOf(id).floorId);
  };

  const actions = onEdit ? (
    <div className="structure-actions">
      <button
        type="button"
        className="text-button"
        disabled={!selectedSpace}
        title={selectedSpace ? `New zone containing ${selectedSpace.name}` : 'Select an area on the plan first'}
        onClick={() => {
          if (!selectedSpace) return;
          onEdit(d => addZone(d, `${selectedSpace.name} zone`, [selectedSpace.id], 'security'));
        }}
      >
        <Plus size={13} /> New zone
      </button>
      <button
        type="button"
        className="text-button"
        title="Re-read portals from the plan, keeping any you have edited"
        onClick={() => onEdit(d => refreshPortals(d))}
      >
        <RefreshCw size={13} /> Re-read portals
      </button>
    </div>
  ) : null;

  if (!model.groups.size)
    return (
      <div className="structure-zone-list">
        {actions}
        <div className="structure-empty">
          <Shapes size={22} />
          <strong>{project.zones?.length ? 'No zones match these filters' : 'No semantic zones yet'}</strong>
          <p>Spaces and portals are available in their own tabs. Select a space on the plan to create a named zone.</p>
        </div>
      </div>
    );

  return (
    <div className="structure-zone-list">
      {actions}
      <div className="inspector-scroll structure-scroll">
        {[...model.groups].map(([purpose, zones]) => (
          <section key={purpose} className="structure-group">
            <h3>{purpose}</h3>
            {zones.map(zone => {
              const isOpen = open === zone.id;
              const members = zoneSpaces(project, zone);
              const ways = perimeter(project, zone);
              const inner = isOpen ? captive(project, zone) : [];
              const inside = new Set(members);
              return (
                <div key={zone.id} className={`structure-zone ${isOpen ? 'open' : ''}`}>
                  <div className="structure-zone-toolbar">
                    <button
                      type="button"
                      className="structure-zone-head"
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : zone.id)}
                    >
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <strong>{zone.name}</strong>
                      <span className="structure-counts">
                        {members.length} {members.length === 1 ? 'space' : 'spaces'}
                        {ways.length > 0 && ` · ${ways.length} in`}
                        {zone.connects &&
                          ` · ${{ all: 'lift', adjacent: 'stairs', up: 'escalator up', down: 'escalator down' }[zone.connects]}`}
                      </span>
                    </button>
                    <button
                      className="structure-locate"
                      aria-label={`Find ${zone.name} on map`}
                      title="Find on map"
                      disabled={!members.length}
                      onClick={() => (onLocate ? onLocate({ objectIds: members }) : pick(members[0]))}
                    >
                      <LocateFixed size={13} />
                    </button>
                  </div>
                  {isOpen && (
                    <div className="structure-detail">
                      {onEdit && (
                        <div className="structure-edit">
                          <input
                            aria-label="Zone name"
                            value={zone.name}
                            onChange={e => {
                              const name = e.target.value;
                              onEdit(d => {
                                const z = d.zones?.find(x => x.id === zone.id);
                                if (z) z.name = name;
                              });
                            }}
                          />
                          <select
                            aria-label="Connects"
                            value={zone.connects ?? ''}
                            onChange={e => {
                              const v = e.target.value;
                              onEdit(d => {
                                const z = d.zones?.find(x => x.id === zone.id);
                                if (z) z.connects = (v || undefined) as Zone['connects'];
                              });
                            }}
                          >
                            <option value="">No implied route</option>
                            <option value="all">Lift · any landing to any</option>
                            <option value="adjacent">Stair · level by level</option>
                            <option value="up">Escalator · up only</option>
                            <option value="down">Escalator · down only</option>
                          </select>
                          <button
                            type="button"
                            className="text-button"
                            disabled={!selectedSpace}
                            title={
                              !selectedSpace
                                ? 'Select an area on the plan first'
                                : inside.has(selectedSpace.id)
                                  ? `Remove ${selectedSpace.name}`
                                  : `Add ${selectedSpace.name}`
                            }
                            onClick={() => {
                              if (!selectedSpace) return;
                              const add = !inside.has(selectedSpace.id);
                              onEdit(d => setZoneMembers(d, zone.id, [selectedSpace.id], add));
                            }}
                          >
                            {selectedSpace && inside.has(selectedSpace.id) ? 'Remove selected' : 'Add selected'}
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Delete ${zone.name}`}
                            onClick={() => onEdit(d => removeZone(d, zone.id))}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                      {ways.length > 0 && (
                        <>
                          <h4>
                            <DoorOpen size={12} /> Ways in
                          </h4>
                          <ul>
                            {ways.map(portal => {
                              const insideId = inside.has(portal.a) ? portal.a : portal.b;
                              const outsideId = insideId === portal.a ? portal.b : portal.a;
                              return (
                                <li key={portal.id} className="structure-member">
                                  <span className="structure-member-title">
                                    <span className="structure-from">{name(outsideId)}</span>
                                    <MoveHorizontal size={11} />
                                    <span>{name(insideId)}</span>
                                    <em>{passageLabel(portal, insideId)}</em>
                                  </span>
                                  <button
                                    type="button"
                                    className="structure-locate"
                                    title="Find on map"
                                    aria-label={`Find passage from ${name(outsideId)} to ${name(insideId)} on map`}
                                    onClick={() =>
                                      onLocate
                                        ? onLocate({
                                            objectIds: portal.openingId ? [portal.openingId] : [insideId, outsideId],
                                            floorId: floorOf(outsideId).floorId,
                                          })
                                        : pick(portal.openingId ?? insideId)
                                    }
                                  >
                                    <LocateFixed size={13} />
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </>
                      )}
                      {!!zone.childZoneIds?.length && (
                        <div className="structure-note">
                          Contains zones:{' '}
                          {zone.childZoneIds.map(id => project.zones?.find(z => z.id === id)?.name ?? id).join(', ')}
                        </div>
                      )}
                      {project.zones?.some(z => z.childZoneIds?.includes(zone.id)) && (
                        <div className="structure-note">
                          Part of:{' '}
                          {project.zones
                            .filter(z => z.childZoneIds?.includes(zone.id))
                            .map(z => z.name)
                            .join(', ')}
                        </div>
                      )}
                      <h4>
                        <Layers size={12} /> Spaces
                      </h4>
                      <ul>
                        {members.map(id => (
                          <li key={id} className="structure-member">
                            <span className="structure-member-title">
                              <span>{name(id)}</span>
                              <em>{floorOf(id).label}</em>
                            </span>
                            <button
                              type="button"
                              className="structure-locate"
                              title="Find on map"
                              aria-label={`Find ${name(id)} on map`}
                              onClick={() => (onLocate ? onLocate({ objectIds: [id] }) : pick(id))}
                            >
                              <LocateFixed size={13} />
                            </button>
                          </li>
                        ))}
                      </ul>
                      {inner.length > 0 && (
                        <p className="structure-note">
                          {inner.length} portal{inner.length > 1 ? 's' : ''} inside this zone — crossing one does not
                          leave it.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Exported for hosts that want the same grouping without the chrome. */
export const zoneMembers = (project: ProjectDocument, zone: Zone): SiteObject[] =>
  zoneSpaces(project, zone)
    .map(id => project.objects.find(o => o.id === id))
    .filter((o): o is SiteObject => !!o);
