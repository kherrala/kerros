import {
  ArrowLeft,
  Building2,
  ChevronDown,
  ChevronRight,
  Compass,
  Copy,
  FileImage,
  Leaf,
  MapPin,
  Plus,
  Search,
  Settings2,
} from 'lucide-react';
import { useState } from 'react';
import { statusTone } from '../adapters/status';
import { EntityIcon } from '../components/Icons';
import type { PlannerMode } from '../model/host';
import type { StatusReading } from '../model/live';
import type { ProjectDocument } from '../model/types';
import { useStrings } from '../theme';
import { floorCode } from './floors';

interface ProjectSidebarProps {
  state: ReturnType<typeof useProjectSidebar>;
  project: ProjectDocument;
  floorId: string | null;
  selected: string | null;
  mode: PlannerMode;
  editing: boolean;
  readOnly: boolean;
  statuses: Map<string, StatusReading>;
  alarmFloors: Set<string | null>;
  activeTab: 'structure' | 'objects';
  setActiveTab: (tab: 'structure' | 'objects') => void;
  leave: () => void;
  select: (id: string | null, focus?: boolean) => void;
  changeFloor: (id: string | null) => void;
  onAnchor: () => void;
  onAddFloor: () => void;
  onDuplicateFloor: () => void;
  onImportReference: () => void;
}

// Owned by the planner so closing the panel preserves the current search and expansion.
export function useProjectSidebar() {
  const [search, setSearch] = useState('');
  const [collapsedBuildings, setCollapsedBuildings] = useState<Set<string>>(new Set());
  return { search, setSearch, collapsedBuildings, setCollapsedBuildings };
}

/** Project browsing chrome, with search and collapsed groups local to the sidebar. */
export function ProjectSidebar({
  state,
  project,
  floorId,
  selected,
  mode,
  editing,
  readOnly,
  statuses,
  alarmFloors,
  activeTab,
  setActiveTab,
  leave,
  select,
  changeFloor,
  onAnchor,
  onAddFloor,
  onDuplicateFloor,
  onImportReference,
}: ProjectSidebarProps) {
  const en = useStrings();
  const floor = project.floors.find(f => f.id === floorId);
  const { search, setSearch, collapsedBuildings, setCollapsedBuildings } = state;
  const filteredObjects = project.objects.filter(
    o =>
      (search ? o.name.toLowerCase().includes(search.toLowerCase()) : o.floorId === floorId || o.kind === 'building') &&
      o.kind !== 'window',
  );
  return (
    <aside className="sidebar">
      <button className="back-link" onClick={leave}>
        <ArrowLeft size={14} />
        All spaces
      </button>
      <div className="site-card">
        <div className="site-icon">
          <Building2 size={24} />
        </div>
        <div>
          <h1>{project.name}</h1>
          <span>
            <MapPin size={11} />
            {project.description.split('·').at(-1)?.trim()}
          </span>
        </div>
        <button className="icon-button" aria-label="Switch project" onClick={leave}>
          <ChevronDown size={15} />
        </button>
      </div>
      <div className="site-badge">
        <span />
        WORKSPACE
        <span className="badge-right">
          {project.buildings.length} building{project.buildings.length > 1 ? 's' : ''}
        </span>
      </div>
      <div className="sidebar-tabs">
        <button className={activeTab === 'structure' ? 'active' : ''} onClick={() => setActiveTab('structure')}>
          Structure
        </button>
        <button className={activeTab === 'objects' ? 'active' : ''} onClick={() => setActiveTab('objects')}>
          Objects<span>{project.objects.filter(o => o.kind !== 'window').length}</span>
        </button>
      </div>
      <div className="sidebar-scroll">
        {activeTab === 'structure' ? (
          <>
            {!readOnly && (
              <button
                className="anchor-entry"
                title="Where the plan is pinned and which way it faces"
                onClick={onAnchor}
              >
                <Compass size={16} />
                <span>
                  Site anchor
                  <small>
                    {(project.origin[2] ?? 0).toFixed(1)}° · {project.origin[1].toFixed(5)},{' '}
                    {project.origin[0].toFixed(5)}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            )}
            <div className="section-label">
              {en.floors}
              {editing && (
                <button className="icon-button" aria-label="Add floor" onClick={onAddFloor}>
                  <Plus size={15} />
                </button>
              )}
            </div>
            <button
              className={`floor-item outdoor ${floorId === null ? 'active' : ''}`}
              onClick={() => changeFloor(null)}
            >
              <Leaf size={17} />
              <span>
                Outdoor site<small>Perimeters & surroundings</small>
              </span>
            </button>
            {project.buildings.map(building => {
              const open = !collapsedBuildings.has(building.id);
              return (
                <div className="building-group" key={building.id}>
                  <button
                    className="building-label"
                    aria-expanded={open}
                    onClick={() =>
                      setCollapsedBuildings(prev => {
                        const next = new Set(prev);
                        if (next.has(building.id)) next.delete(building.id);
                        else next.add(building.id);
                        return next;
                      })
                    }
                  >
                    <Building2 size={13} />
                    {building.name}
                    {mode !== 'view' &&
                      project.floors.some(f => f.buildingId === building.id && alarmFloors.has(f.id)) && (
                        <span className="floor-alarm" title="Active alarm in this building" />
                      )}
                    <span className="building-count">
                      {project.floors.filter(f => f.buildingId === building.id).length}
                    </span>
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  {open &&
                    project.floors
                      .filter(f => f.buildingId === building.id)
                      .sort((a, b) => b.elevation - a.elevation)
                      .map(f => (
                        <button
                          key={f.id}
                          className={`floor-item ${floorId === f.id ? 'active' : ''}`}
                          onClick={() => changeFloor(f.id)}
                        >
                          <span className="floor-number">{floorCode(project, f)}</span>
                          <span>
                            {f.name}
                            <small>{f.elevation.toFixed(1)} m elevation</small>
                          </span>
                          {mode !== 'view' && alarmFloors.has(f.id) && (
                            <span className="floor-alarm" title="Active alarm on this floor" />
                          )}
                          {floorId === f.id && <span className="active-floor-dot" />}
                        </button>
                      ))}
                </div>
              );
            })}
            {editing && floorId && (
              <button className="duplicate-floor" onClick={onDuplicateFloor}>
                <Copy size={13} />
                Duplicate current floor
              </button>
            )}
            <div className="section-label drawings-heading">
              {en.drawings}
              {editing && (
                <button
                  className="icon-button"
                  aria-label="Import reference drawing"
                  onClick={() => onImportReference()}
                >
                  <Plus size={15} />
                </button>
              )}
            </div>
            {project.drawings.filter(d => d.floorId === floorId).length ? (
              project.drawings
                .filter(d => d.floorId === floorId)
                .map(d => (
                  <button
                    className={`drawing-item ${selected === d.id ? 'active' : ''}`}
                    key={d.id}
                    onClick={() => select(d.id)}
                  >
                    <FileImage size={18} />
                    <span>
                      {d.name}
                      <small>
                        {d.locked ? 'Locked' : 'Aligned reference'} · {Math.round(d.opacity * 100)}%
                      </small>
                    </span>
                  </button>
                ))
            ) : (
              <button className="empty-drawings" onClick={() => editing && onImportReference()}>
                <div>
                  <FileImage size={20} />
                  <Plus size={12} />
                </div>
                <strong>Add a floor drawing</strong>
                <span>Align a plan. Trace your space.</span>
                <small>PNG, JPEG or PDF</small>
              </button>
            )}
          </>
        ) : (
          <>
            <label className="object-search">
              <Search size={15} />
              <input
                aria-label="Search objects"
                placeholder="Find a space or object…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </label>
            <div className="section-label">
              {search ? 'Search all floors' : (floor?.name ?? 'Outdoor objects')}
              <span>{filteredObjects.length}</span>
            </div>
            {filteredObjects.map(o => (
              <button
                key={o.id}
                className={`object-row list-object ${selected === o.id ? 'active' : ''}`}
                onClick={() => select(o.id, true)}
              >
                <EntityIcon kind={o.kind} symbol={o.symbol} travel={o.travel} />
                <span>
                  {o.name}
                  <small>{o.kind}</small>
                </span>
                {o.feedId && <span className={`status-dot ${statusTone(statuses.get(o.feedId))}`} />}
              </button>
            ))}
            {!filteredObjects.length && <p className="helper padded">No matching objects.</p>}
          </>
        )}
      </div>
      <div className="sidebar-footer">
        <span className="workspace-avatar">K</span>
        <div>
          <strong>Kerros workspace</strong>
          <small>Local prototype</small>
        </div>
        <Settings2 size={16} />
      </div>
    </aside>
  );
}
