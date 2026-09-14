import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { LocateFixed } from 'lucide-react';
import { isSpace, type Portal, type SiteObject } from '../model/types';
import { zoneSpaces } from '../model/ontology';
import { navEdges, navNodes } from '../model/navigation';
import { effectivePortals } from '../model/portals';
import type { StructureViewProps } from './StructureView';

const TABS = ['Spaces', 'Zones', 'Portals', 'Topology'] as const;
type Tab = (typeof TABS)[number];
const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const connectionLabel = (direction?: string) =>
  direction === 'none' ? 'Sealed' : direction === 'a-to-b' ? '→' : direction === 'b-to-a' ? '←' : '↔';

function Expandable({
  title,
  children,
  className,
  initialOpen = false,
  onLocate,
  locateLabel,
}: {
  title: ReactNode;
  children: () => ReactNode;
  className: string;
  initialOpen?: boolean;
  onLocate?: () => void;
  locateLabel?: string;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details className={className} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="structure-row-title">{title}</span>
        {onLocate && (
          <button
            className="structure-locate"
            aria-label={locateLabel}
            title="Find on map"
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              onLocate();
            }}
          >
            <LocateFixed size={13} />
          </button>
        )}
      </summary>
      {open && children()}
    </details>
  );
}

/** Bound the DOM even for the thousands of inferred portals in the sample buildings. */
function Rows<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const [limit, setLimit] = useState(50);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || limit >= items.length) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setLimit(current => Math.min(items.length, current + 50));
      },
      { root: element.closest('.inspector-scroll'), rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [limit, items.length]);
  return (
    <>
      {items.slice(0, limit).map(render)}
      {limit < items.length && (
        <div className="structure-load-more" ref={sentinel}>
          {limit} of {items.length} · scroll for more
        </div>
      )}
    </>
  );
}

export function StructureExplorer({
  project,
  selected,
  onSelect,
  onFloorChange,
  onLocate,
  onGraphView,
  renderZones,
}: StructureViewProps & {
  renderZones: (filter: { query: string; floor: string }) => ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('Spaces');
  const [query, setQuery] = useState('');
  const [floor, setFloor] = useState('all');
  const [portalGroup, setPortalGroup] = useState('all');
  const [groupFilterOpen, setGroupFilterOpen] = useState(false);
  const [onlyIsolated, setOnlyIsolated] = useState(false);
  const id = useId();
  const index = useMemo(() => {
    const objects = new Map(project.objects.map(o => [o.id, o]));
    const spaces = project.objects.filter(o => isSpace(o.kind));
    const portals = effectivePortals(project);
    const bySpace = new Map<string, Portal[]>();
    for (const portal of portals)
      for (const id of new Set([portal.a, portal.b])) {
        const rows = bySpace.get(id) ?? [];
        rows.push(portal);
        bySpace.set(id, rows);
      }
    const memberships = new Map<string, string[]>();
    for (const zone of project.zones ?? [])
      for (const id of zoneSpaces(project, zone)) {
        const names = memberships.get(id) ?? [];
        names.push(zone.name);
        memberships.set(id, names);
      }
    const children = new Map<string, SiteObject[]>();
    for (const object of project.objects)
      if (object.parentId) {
        const rows = children.get(object.parentId) ?? [];
        rows.push(object);
        children.set(object.parentId, rows);
      }
    return { objects, spaces, portals, bySpace, memberships, children };
  }, [project]);
  // Use the exact graph accessors that routing uses, and only build it when requested.
  const graph = useMemo(() => {
    if (tab !== 'Topology') return null;
    const nodes = navNodes(project),
      edges = navEdges(project);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const adjacency = new Map(nodes.map(n => [n.id, [] as typeof edges]));
    for (const edge of edges) {
      adjacency.get(edge.aId)?.push(edge);
      adjacency.get(edge.bId)?.push(edge);
    }
    return { nodes, edges, byId, adjacency };
  }, [project, tab]);
  const floorName = (floorId: string | null) =>
    floorId === null ? 'Outdoor site' : (project.floors.find(f => f.id === floorId)?.name ?? floorId);
  const objectName = (objectId: string) => index.objects.get(objectId)?.name || objectId;
  const matches = (...values: (string | undefined)[]) =>
    !query.trim() || values.some(value => value?.toLowerCase().includes(query.trim().toLowerCase()));
  const matchesFloor = (floorId: string | null) => floor === 'all' || floor === (floorId ?? 'outdoors');
  const pick = (object: SiteObject, floorId = object.floorId) => {
    onSelect?.(object.id);
    onFloorChange?.(floorId);
  };
  const locate = (objectIds: string[], floorId?: string | null, position?: [number, number]) => {
    if (onLocate) onLocate({ objectIds, floorId, position });
    else {
      const object = index.objects.get(objectIds[0]);
      if (object) pick(object, floorId === undefined ? object.floorId : floorId);
      else if (floorId !== undefined) onFloorChange?.(floorId);
    }
  };
  const objectLink = (objectId: string) => {
    const object = index.objects.get(objectId);
    return object ? (
      <span className="structure-object-link">
        <span title={object.name || object.id}>{object.name || object.id}</span>
        <button
          type="button"
          className="structure-locate"
          aria-label={`Find ${object.name || object.id} on map`}
          title="Find on map"
          onClick={() => locate([object.id])}
        >
          <LocateFixed size={13} />
        </button>
      </span>
    ) : (
      <span>{objectId}</span>
    );
  };
  const portalRow = (portal: Portal) => (
    <Expandable
      className="structure-record"
      key={portal.id}
      onLocate={() => locate([...(portal.openingId ? [portal.openingId] : []), portal.a, portal.b])}
      locateLabel={`Find ${portal.name || 'portal'} on map`}
      title={
        <>
          <span>{portal.name || (portal.openingId ? objectName(portal.openingId) : 'Open boundary')}</span>
          <small>{connectionLabel(portal.passage)}</small>
        </>
      }
    >
      {() => (
        <div className="structure-record-body">
          <div className="structure-connection">
            {objectLink(portal.a)}
            <span>{connectionLabel(portal.passage)}</span>
            {objectLink(portal.b)}
          </div>
          <p>
            {[...new Set([portal.a, portal.b].map(id => floorName(index.objects.get(id)?.floorId ?? null)))].join(
              ' · ',
            )}
          </p>
          <div className="structure-facts">
            <span>Crossing evidence: {portal.attests ?? 'assumed'}</span>
            {portal.openingId && <span className="structure-fact">Opening: {objectLink(portal.openingId)}</span>}
          </div>
          {(project.portalGroups ?? [])
            .filter(group => group.portalIds.includes(portal.id))
            .map(group => (
              <p key={group.id}>Group: {group.name}</p>
            ))}
          <code title={portal.id}>{portal.id}</code>
        </div>
      )}
    </Expandable>
  );
  const spaceRow = (space: SiteObject) => (
    <Expandable
      className={`structure-record ${space.id === selected ? 'selected' : ''}`}
      key={space.id}
      onLocate={() => locate([space.id])}
      locateLabel={`Find ${space.name} on map`}
      title={
        <>
          <span>{space.name || space.id}</span>
          <small>
            {space.kind} · {(index.bySpace.get(space.id) ?? []).length} portals
          </small>
        </>
      }
    >
      {() => (
        <div className="structure-record-body">
          {space.parentId && <p className="structure-fact">Inside: {objectLink(space.parentId)}</p>}
          <p>Zones: {index.memberships.get(space.id)?.join(', ') || 'Not grouped into a zone'}</p>
          {!!space.servedFloorIds?.length && (
            <div>
              <h4>Served floors</h4>
              {space.servedFloorIds.map(id => (
                <div className="structure-object-link structure-item" key={id}>
                  <span>{floorName(id)}</span>
                  <button
                    className="structure-locate"
                    title="Find on map"
                    aria-label={`Find ${space.name} on ${floorName(id)}`}
                    onClick={() => locate([space.id], id)}
                  >
                    <LocateFixed size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!!index.children.get(space.id)?.length && (
            <div>
              <h4>Contained objects</h4>
              <Rows
                items={index.children.get(space.id)!}
                render={object => (
                  <div className="structure-item" key={object.id}>
                    {objectLink(object.id)} <small>{object.kind}</small>
                  </div>
                )}
              />
            </div>
          )}
          <h4>Connections</h4>
          <Rows items={index.bySpace.get(space.id) ?? []} render={portalRow} />
          {!index.bySpace.has(space.id) && (
            <p>No direct portals. Transport connectivity may be supplied by its zone.</p>
          )}
          <code title={space.id}>{space.id}</code>
        </div>
      )}
    </Expandable>
  );
  const visibleSpaces = index.spaces.filter(
    space => matchesFloor(space.floorId) && matches(space.name, space.id, space.kind, floorName(space.floorId)),
  );
  const group = project.portalGroups?.find(group => group.id === portalGroup);
  const visiblePortals = index.portals.filter(
    portal =>
      (!group || group.portalIds.includes(portal.id)) &&
      (matchesFloor(index.objects.get(portal.a)?.floorId ?? null) ||
        matchesFloor(index.objects.get(portal.b)?.floorId ?? null)) &&
      matches(
        portal.name,
        portal.id,
        objectName(portal.a),
        objectName(portal.b),
        portal.openingId ? objectName(portal.openingId) : 'Open boundary',
      ),
  );
  const visibleNodes =
    graph?.nodes.filter(
      node =>
        matchesFloor(node.floorId) &&
        matches(node.id, node.objectId ? objectName(node.objectId) : '', floorName(node.floorId)) &&
        (!onlyIsolated || !graph.adjacency.get(node.id)?.length),
    ) ?? [];
  const floorGroup = (floorId: string | null, label: string) => {
    if (!matchesFloor(floorId)) return null;
    const rows = visibleSpaces.filter(space => space.floorId === floorId);
    if (query.trim() && !rows.length) return null;
    return (
      <Expandable
        className="structure-floor"
        key={`${floorId}:${query}`}
        onLocate={() =>
          locate(
            rows.map(space => space.id),
            floorId,
          )
        }
        locateLabel={`Find ${label} on map`}
        initialOpen={!!query.trim() || floor !== 'all'}
        title={
          <>
            <span>{label}</span>
            <small>{countLabel(rows.length, 'space')}</small>
          </>
        }
      >
        {() => (
          <>
            {rows.length ? (
              <Rows key={`${query}:${floor}`} items={rows} render={spaceRow} />
            ) : (
              <p className="structure-note">No spaces on this level.</p>
            )}
          </>
        )}
      </Expandable>
    );
  };
  return (
    <div className="structure-panel">
      <div className="structure-heading">
        <strong>Structure</strong>
        <small>{project.name}</small>
      </div>
      <div className="structure-tabs" role="tablist" aria-label="Structure views">
        {TABS.map((name, i) => (
          <button
            key={name}
            role="tab"
            id={`${id}-${name}`}
            aria-controls={`${id}-panel`}
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={event => {
              const next =
                event.key === 'ArrowRight'
                  ? (i + 1) % TABS.length
                  : event.key === 'ArrowLeft'
                    ? (i + TABS.length - 1) % TABS.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? TABS.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                setTab(TABS[next]);
                document.getElementById(`${id}-${TABS[next]}`)?.focus();
              }
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="structure-filters">
        <input
          type="search"
          aria-label="Search structure"
          placeholder={`Search ${tab.toLowerCase()}…`}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <select aria-label="Structure floor" value={floor} onChange={event => setFloor(event.target.value)}>
          <option value="all">All floors</option>
          <option value="outdoors">Outdoor site</option>
          {project.floors.map(f => (
            <option key={f.id} value={f.id}>
              {[f.code, f.name].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
      </div>
      <div className="structure-summary">
        <span>{countLabel(index.spaces.length, 'space')}</span>
        <span>{countLabel(project.zones?.length ?? 0, 'zone')}</span>
        <span>{countLabel(index.portals.length, 'portal')}</span>
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} className="structure-tab-content">
        {tab === 'Zones' ? (
          renderZones({ query, floor })
        ) : (
          <div className="inspector-scroll structure-scroll">
            {tab === 'Spaces' && (
              <>
                <p className="structure-note">Buildings → floors → spaces, including spaces outside any zone.</p>
                {project.buildings.map(building => (
                  <section className="structure-group" key={building.id}>
                    <h3>{building.name}</h3>
                    <button
                      title="Find on map"
                      className="structure-locate structure-floor-find"
                      aria-label={`Find ${building.name} on map`}
                      onClick={() =>
                        locate(
                          index.spaces
                            .filter(space =>
                              project.floors.some(f => f.id === space.floorId && f.buildingId === building.id),
                            )
                            .map(space => space.id),
                        )
                      }
                    >
                      <LocateFixed size={13} />
                    </button>
                    {project.floors
                      .filter(f => f.buildingId === building.id)
                      .sort((a, b) => b.elevation - a.elevation)
                      .map(f => floorGroup(f.id, [f.code, f.name].filter(Boolean).join(' · ')))}
                  </section>
                ))}
                {project.floors
                  .filter(f => !project.buildings.some(b => b.id === f.buildingId))
                  .map(f => floorGroup(f.id, [f.code, f.name].filter(Boolean).join(' · ')))}
                {floorGroup(null, 'Outdoor site')}
                {!visibleSpaces.length && <p className="structure-empty">No spaces match these filters.</p>}
              </>
            )}
            {tab === 'Portals' && (
              <>
                {!!project.portalGroups?.length && (
                  <div className="structure-group-filter">
                    <button
                      className="text-button"
                      aria-expanded={groupFilterOpen}
                      onClick={() => {
                        setGroupFilterOpen(!groupFilterOpen);
                        if (groupFilterOpen) setPortalGroup('all');
                      }}
                    >
                      {groupFilterOpen ? 'Remove portal group filter' : 'Filter by portal group'}
                    </button>
                  </div>
                )}
                {groupFilterOpen && (
                  <label className="structure-group-filter">
                    Portal group
                    <select
                      aria-label="Portal group"
                      value={portalGroup}
                      onChange={event => setPortalGroup(event.target.value)}
                    >
                      <option value="all">All portals</option>
                      {project.portalGroups?.map(group => (
                        <option key={group.id} value={group.id}>
                          {group.name} · {group.portalIds.length}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {group && (
                  <div className="structure-group-filter">
                    <button
                      title="Find on map"
                      className="structure-locate"
                      aria-label={`Find ${group.name} on map`}
                      onClick={() =>
                        locate(
                          index.portals
                            .filter(portal => group.portalIds.includes(portal.id))
                            .flatMap(portal => [portal.a, portal.b]),
                        )
                      }
                    >
                      <LocateFixed size={13} />
                    </button>
                  </div>
                )}
                <p className="structure-note">
                  {countLabel(visiblePortals.length, 'portal')} shown · arrows follow the two listed spaces.
                </p>
                <Rows key={`${query}:${floor}:${portalGroup}`} items={visiblePortals} render={portalRow} />
                {!visiblePortals.length && <p className="structure-empty">No portals match these filters.</p>}
              </>
            )}
            {tab === 'Topology' && graph && (
              <>
                {onGraphView && (
                  <div className="structure-group-filter">
                    <button
                      className="button secondary small"
                      onClick={() => onGraphView(floor === 'all' ? undefined : floor === 'outdoors' ? null : floor)}
                    >
                      Open graph view
                    </button>
                  </div>
                )}
                <p className="structure-note">
                  {project.navNodes !== undefined || project.navEdges !== undefined
                    ? 'Authored graph overrides'
                    : 'Derived from spaces, portals and transport zones'}{' '}
                  · {countLabel(graph.nodes.length, 'node')} · {countLabel(graph.edges.length, 'edge')}
                </p>
                <label className="structure-group-filter">
                  <input
                    type="checkbox"
                    checked={onlyIsolated}
                    onChange={event => setOnlyIsolated(event.target.checked)}
                  />
                  Only isolated nodes ({graph.nodes.filter(n => !graph.adjacency.get(n.id)?.length).length})
                </label>
                <Rows
                  key={`${query}:${floor}:${onlyIsolated}`}
                  items={visibleNodes}
                  render={node => (
                    <Expandable
                      className="structure-record"
                      key={node.id}
                      onLocate={() => locate(node.objectId ? [node.objectId] : [], node.floorId, node.position)}
                      locateLabel={`Find ${node.objectId ? objectName(node.objectId) : node.id} on map`}
                      title={
                        <>
                          <span>{node.objectId ? objectName(node.objectId) : node.id}</span>
                          <small>{graph.adjacency.get(node.id)?.length ?? 0} edges</small>
                        </>
                      }
                    >
                      {() => (
                        <div className="structure-record-body">
                          <p>
                            {floorName(node.floorId)} · {node.position.map(n => n.toFixed(2)).join(', ')} m
                          </p>

                          <Rows
                            items={graph.adjacency.get(node.id) ?? []}
                            render={edge => {
                              const other = graph.byId.get(edge.aId === node.id ? edge.bId : edge.aId);
                              return (
                                <div className="structure-edge" key={edge.id}>
                                  <div className="structure-edge-target">
                                    {other?.objectId ? (
                                      objectLink(other.objectId)
                                    ) : (
                                      <span title={other?.id}>{other?.id ?? 'Missing node'}</span>
                                    )}
                                  </div>
                                  <div className="structure-edge-meta">
                                    <span>
                                      {edge.directed
                                        ? edge.aId === node.id
                                          ? '→ outgoing'
                                          : '← incoming'
                                        : '↔ both ways'}{' '}
                                      · {edge.kind}
                                    </span>
                                    {edge.objectId && (
                                      <span className="structure-fact">Via {objectLink(edge.objectId)}</span>
                                    )}
                                  </div>
                                  <button
                                    title="Find on map"
                                    className="structure-locate structure-edge-locate"
                                    aria-label={`Find connection ${edge.id} on map`}
                                    onClick={() =>
                                      locate(
                                        [node.objectId, other?.objectId, edge.objectId].filter(
                                          (id): id is string => !!id,
                                        ),
                                        node.floorId,
                                        node.position,
                                      )
                                    }
                                  >
                                    <LocateFixed size={13} />
                                  </button>
                                </div>
                              );
                            }}
                          />
                          {!graph.adjacency.get(node.id)?.length && <p>No route connections.</p>}
                          <code title={node.id}>{node.id}</code>
                        </div>
                      )}
                    </Expandable>
                  )}
                />
                {!visibleNodes.length && <p className="structure-empty">No nodes match these filters.</p>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
