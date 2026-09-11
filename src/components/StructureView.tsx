// Browsing the building as a structure rather than a picture.
//
// A map is the wrong instrument for most of what the ontology says. A zone spanning eleven floors, a
// lift shaft, "everywhere a contractor may go" — none of those have a shape, and drawing them on a
// plan either lies about them or hides them. This view reads the same document as a list of what
// groups with what and what opens onto what, which is the form those questions actually take.
import { useMemo, useState } from 'react';
import { isSpace, type Portal, type ProjectDocument, type SiteObject, type Zone } from '../model/types';
import { addZone, captive, entryInto, perimeter, removeZone, setZoneMembers, zoneSpaces } from '../model/ontology';
import { refreshPortals } from '../model/inference';
import { spaces } from '../model/spaces';
import {
  ChevronDown,
  ChevronRight,
  DoorOpen,
  Layers,
  Link2,
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
  /** Omit to keep the panel read-only. Given, the panel can author zones: the host applies the
   *  mutation to a draft and owns undo, exactly as the map tools do. */
  onEdit?: (change: (draft: ProjectDocument) => void) => void;
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

export function StructureView({ project, selected, onSelect, onFloorChange, onEdit }: StructureViewProps) {
  const [open, setOpen] = useState<string | null>(null);
  const selectedSpace = selected && project.objects.find(o => o.id === selected && isSpace(o.kind));
  const model = useMemo(() => {
    const byId = new Map(project.objects.map(o => [o.id, o]));
    const floors = new Map(project.floors.map(f => [f.id, f.name]));
    const zones = project.zones ?? [];
    const groups = new Map<string, Zone[]>();
    for (const z of zones) {
      const key = z.purpose ?? 'other';
      const list = groups.get(key);
      if (list) list.push(z);
      else groups.set(key, [z]);
    }
    return { byId, floors, groups, spaceCount: spaces(project).length, portalCount: (project.portals ?? []).length };
  }, [project]);

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

  if (!project.zones?.length && !project.portals?.length)
    return (
      <div className="structure-panel">
        {actions}
        <div className="structure-empty">
          <Shapes size={22} />
          <strong>No structure yet</strong>
          <p>
            This project has geometry but nothing describing what it <em>means</em> — no zones grouping its spaces, no
            portals joining them.
          </p>
          <p>Portals can be read straight off the plan; zones are yours to name.</p>
        </div>
      </div>
    );

  return (
    <div className="structure-panel">
      <div className="structure-summary">
        <span>
          <Layers size={13} /> {model.spaceCount} spaces
        </span>
        <span>
          <Shapes size={13} /> {(project.zones ?? []).length} zones
        </span>
        <span>
          <Link2 size={13} /> {model.portalCount} portals
        </span>
      </div>
      {onEdit && (
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
      )}
      <div className="inspector-scroll structure-scroll">
        {[...model.groups].map(([purpose, zones]) => (
          <section key={purpose} className="structure-group">
            <h3>{purpose}</h3>
            {zones.map(zone => {
              const isOpen = open === zone.id;
              const members = zoneSpaces(project, zone);
              const ways = perimeter(project, zone);
              const inner = captive(project, zone);
              const inside = new Set(members);
              return (
                <div key={zone.id} className={`structure-zone ${isOpen ? 'open' : ''}`}>
                  <button
                    type="button"
                    className="structure-zone-head"
                    onClick={() => setOpen(isOpen ? null : zone.id)}
                  >
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <strong>{zone.name}</strong>
                    <span className="structure-counts">
                      {members.length} spaces
                      {ways.length > 0 && ` · ${ways.length} in`}
                      {zone.connects && ` · ${zone.connects === 'all' ? 'lift' : 'stair'}`}
                    </span>
                  </button>
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
                                <li key={portal.id}>
                                  <button
                                    type="button"
                                    className={portal.openingId === selected ? 'active' : ''}
                                    onClick={() => pick(portal.openingId ?? insideId)}
                                  >
                                    <span className="structure-from">{name(outsideId)}</span>
                                    <MoveHorizontal size={11} />
                                    <span>{name(insideId)}</span>
                                    <em>{passageLabel(portal, insideId)}</em>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </>
                      )}
                      <h4>
                        <Layers size={12} /> Spaces
                      </h4>
                      <ul>
                        {members.map(id => (
                          <li key={id}>
                            <button type="button" className={id === selected ? 'active' : ''} onClick={() => pick(id)}>
                              <span>{name(id)}</span>
                              <em>{floorOf(id).label}</em>
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
