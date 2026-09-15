import { useMemo, useRef, useState } from 'react';
import {
  appendAreaPoint,
  applyGeometryDrag,
  drawBarrier,
  encloseRoom,
  endsBoundaryStroke,
  type GeometryDrag,
} from '../model/authoring';
import { addBoundaryHole, boundaryRegionAt, connectSpace, drawVirtualBoundary } from '../model/boundaries';
import { draggedDoorSwing } from '../model/doors';
import { createObject } from '../model/factory';
import {
  addBarrier,
  centroid,
  closeRing,
  distance,
  objectArea,
  objectPosition,
  pointInRing,
  rectangle,
  snapPoint,
  splitRoom,
} from '../model/geometry';
import { addNavEdge, addNavNode, chainVertical } from '../model/navigation';
import { transformObject } from '../model/project';
import type { NavNode, ObjectKind, Point, ProjectDocument, SiteObject, Tool } from '../model/types';
import { isArea, isDevice, isOpening, uid } from '../model/types';
import { fitOpening, mainAxis, proposeWall, snapDragPoint, type OpeningFit, type WallProposal } from '../model/walls';
import type { CommitProject } from './types';

interface DrawingToolsOptions {
  project: ProjectDocument;
  floorId: string | null;
  selected: string | null;
  editing: boolean;
  threeD: boolean;
  commit: CommitProject;
  notify: (message: string) => void;
  setSelected: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onFloorChange: (id: string | null) => void;
  onChooseTool: () => void;
}

/** Snap labels that mean "an angle is being held", and so deserve naming what it is held to. */
const HELD = new Set(['Parallel', 'Square', '15°', '30°', '45°', '60°', '75°']);
/** Default leaf widths, so the preview can size itself before the object exists. Matches factory.ts. */
const OPENING_WIDTH: Record<string, number> = { door: 0.9, window: 1.2, gate: 3.5 };
const PLACE_TOOLS: Tool[] = [
  'door',
  'window',
  'gate',
  'turnstile',
  'reader',
  'camera',
  'elevator',
  'stairs',
  'office',
  'container',
  'storage',
  'poi',
  'sensor',
  'light',
  'alarm',
  'equipment',
];
/**
 * Owns in-progress drawing and handle gestures. Previews only calculate geometry;
 * completed edits go through the planner's validated history transaction.
 */
export function useDrawingTools({
  project,
  floorId,
  selected,
  editing,
  threeD,
  commit,
  notify,
  setSelected,
  onSelect,
  onFloorChange,
  onChooseTool,
}: DrawingToolsOptions) {
  const [tool, setTool] = useState<Tool>('select');
  const [draft, setDraft] = useState<Point[]>([]);
  const [hover, setHover] = useState<Point | null>(null);
  const [proposal, setProposal] = useState<WallProposal | null>(null);
  const [openingFit, setOpeningFit] = useState<OpeningFit | null>(null);
  const [held, setHeld] = useState(false);
  const [snapLabel, setSnapLabel] = useState('');
  const [snapping, setSnapping] = useState(true);
  const [routeAnchor, setRouteAnchor] = useState<string | null>(null);
  const toleranceRef = useRef(0.7);
  function chooseTool(next: Tool) {
    if (next === 'hole') {
      const o = project.objects.find(o => o.id === selected);
      if (!o?.rings) {
        notify('Select an area first, then use Cut a hole.');
        return;
      }
    }
    setTool(next);
    setDraft([]);
    setProposal(null);
    setOpeningFit(null);
    onChooseTool();
    setRouteAnchor(null);
  }
  function updateObject(id: string, patch: Partial<SiteObject>) {
    commit(p => transformObject(p.objects.find(o => o.id === id)!, patch));
  }
  function finish() {
    if (tool === 'wall' || tool === 'boundary' || tool === 'fence' || tool === 'measure') {
      setDraft([]);
      setTool('select');
      return;
    }
    if (!['zone', 'room', 'hole', 'evacuation'].includes(tool) || draft.length < 3) {
      notify('Add at least three points to finish an area.');
      return;
    }
    const rings = [closeRing(draft)];
    const success = commit(p => {
      if (tool === 'hole') {
        const o = p.objects.find(o => o.id === selected);
        if (!o?.rings) throw new Error('Select an area first.');
        if (o.geometry?.mode === 'boundaries') addBoundaryHole(p, o, rings[0]);
        else o.rings.push(rings[0]);
      } else {
        const object = createObject(tool as ObjectKind, centroid(draft), floorId);
        object.rings = rings;
        const xs = draft.map(p => p[0]),
          ys = draft.map(p => p[1]);
        object.width = Math.max(...xs) - Math.min(...xs);
        object.depth = Math.max(...ys) - Math.min(...ys);
        p.objects.push(object);
        if (tool === 'room') connectSpace(p, object.id);
        setSelected(object.id);
      }
    });
    if (success) {
      setDraft([]);
      setTool('select');
    }
  }
  function mapClick(raw: Point, id: string | null) {
    if (!editing || tool === 'select' || threeD) {
      onSelect(id);
      return;
    }
    if (tool === 'pan') return;
    if (tool === 'partition') {
      // Recomputed from the click rather than reused from hover, so a tap that never hovered (touch)
      // creates exactly the wall a pointer would have been shown.
      const offer = proposeWall(project, floorId, raw);
      if (offer)
        commit(p => {
          drawBarrier(p, floorId, offer.segment[0], offer.segment[1]);
        });
      setProposal(null);
      return;
    }
    // Read a space off the walls that already surround the click, rather than asking someone to
    // trace an outline the drawing has already stated. The click lands in exactly one enclosed
    // region or in none, so there is nothing to aim at but the room itself.
    if (tool === 'enclose') {
      const region = boundaryRegionAt(project, floorId, raw);
      if (!region) {
        notify('Nothing encloses that point. The walls around it have a gap, or it is outside the building.');
        return;
      }
      let existing = false;
      let roomName = '';
      let area = 0;
      let found = false;
      const done = commit(p => {
        const result = encloseRoom(p, floorId, raw);
        if (!result) return;
        found = true;
        existing = result.existing;
        roomName = result.room.name;
        area = objectArea(result.room);
        setSelected(result.room.id);
      });
      // Only when it took. A rejected commit has already said why, and a second toast claiming
      // success on top of it would contradict the first.
      if (done && found)
        notify(
          existing
            ? `“${roomName}” follows its boundaries · ${area.toFixed(1)} m²`
            : `Space follows its boundaries · ${area.toFixed(1)} m²`,
        );
      return;
    }
    const anchor = draft.at(-1);
    const axis = snapping && anchor ? mainAxis(project, floorId) : 0;
    const point = snapping ? snapPoint(project, floorId, raw, toleranceRef.current, anchor, true, axis).point : raw;
    if (tool === 'wall' || tool === 'fence' || tool === 'boundary') {
      if (!anchor) {
        setDraft([point]);
        return;
      }
      const complete = endsBoundaryStroke(project, floorId, anchor, point, tool);
      let drawn = false;
      if (
        commit(p => {
          drawn = !!(tool === 'boundary'
            ? drawVirtualBoundary(p, floorId, anchor, point)
            : drawBarrier(p, floorId, anchor, point, tool));
        })
      ) {
        if (drawn && complete) finish();
        else setDraft([point]);
      }
      return;
    }
    if (tool === 'rectangle') {
      if (!draft.length) {
        setDraft([point]);
        return;
      }
      const a = draft[0];
      if (
        commit(p => {
          const o = createObject('zone', [(a[0] + point[0]) / 2, (a[1] + point[1]) / 2], floorId, 'New area');
          o.width = Math.abs(a[0] - point[0]);
          o.depth = Math.abs(a[1] - point[1]);
          o.rings = [rectangle(o.position, o.width, o.depth)];
          p.objects.push(o);
          setSelected(o.id);
        })
      ) {
        setDraft([]);
        setTool('select');
      }
      return;
    }
    if (['zone', 'room', 'hole', 'evacuation'].includes(tool)) {
      if (draft.length >= 3 && distance(point, draft[0]) < toleranceRef.current) finish();
      else {
        const next = appendAreaPoint(draft, point);
        setDraft(next.points);
        if (next.error) notify(next.error);
      }
      return;
    }
    if (tool === 'measure') {
      setDraft(draft.length >= 2 ? [point] : [...draft, point]);
      return;
    }
    if (tool === 'split') {
      if (!draft.length) {
        setDraft([point]);
        return;
      }
      // The room being split is the smallest room/zone containing the cut's midpoint.
      const mid: Point = [(draft[0][0] + point[0]) / 2, (draft[0][1] + point[1]) / 2];
      const target = project.objects
        .filter(
          o =>
            o.floorId === floorId &&
            (o.kind === 'room' || o.kind === 'zone') &&
            o.rings &&
            pointInRing(mid, o.rings[0]),
        )
        .sort((a, b) => objectArea(a) - objectArea(b))[0];
      if (!target) {
        notify('Draw the cut across a room — you can start and end past the walls.');
        return;
      }
      if (
        commit(p => {
          const twin = splitRoom(p, target.id, draft[0], point);
          setSelected(twin);
        })
      ) {
        setDraft([]);
        setTool('select');
      }
      return;
    }
    if (tool === 'route') {
      // Route authoring chains nav nodes: lifts/stairs thread all served floors (chainVertical),
      // doors/POIs/rooms get a bound node at the object, anywhere else a free node at the snap
      // point. A kept anchor links each new node to the previous one — 'door' edges when either
      // end binds a door/gate/turnstile — and every mutation runs through commit() for undo.
      const hit = id ? project.objects.find(o => o.id === id) : undefined;
      let targetId: string | null = null;
      const ok = commit(p => {
        const obj = hit ? p.objects.find(o => o.id === hit.id) : undefined;
        let target: NavNode | undefined;
        if (obj && (obj.kind === 'elevator' || obj.kind === 'stairs')) {
          const chain = chainVertical(p, obj);
          target = chain.find(n => n.floorId === floorId);
          if (!target)
            throw new Error(`${obj.name} does not serve this floor — set its served floors in the properties panel.`);
        } else if (obj && ['door', 'gate', 'turnstile', 'poi', 'room'].includes(obj.kind))
          target = addNavNode(p, obj.floorId, objectPosition(p, obj), obj.id);
        else target = addNavNode(p, floorId, point);
        const anchor = routeAnchor ? (p.navNodes ?? []).find(n => n.id === routeAnchor) : undefined;
        if (anchor && anchor.id !== target.id) {
          const doorOf = (n: NavNode) => {
            const o = n.objectId ? p.objects.find(x => x.id === n.objectId) : undefined;
            return o && ['door', 'gate', 'turnstile'].includes(o.kind) ? o : undefined;
          };
          const doorObj = doorOf(anchor) ?? doorOf(target);
          addNavEdge(p, doorObj ? 'door' : 'walk', anchor, target, doorObj?.id);
        }
        targetId = target.id;
      });
      if (ok) setRouteAnchor(targetId);
      return;
    }
    if (PLACE_TOOLS.includes(tool)) {
      // One click, one object, and the tool is done. These tools place a single thing and leave it
      // selected, so staying armed means the next click — on the thing you just placed, to move it
      // or read it — drops another one on top instead. Drawing tools are different: a wall or a zone
      // takes several clicks, so they stay until the shape is finished.
      const placed = commit(p => {
        const o = createObject(tool as ObjectKind, point, floorId);
        if (isOpening(o.kind)) {
          // The very fit the preview drew. Two copies of this rule would drift apart, and a preview
          // that disagrees with the click is worse than no preview at all.
          const fit = fitOpening(p, floorId, o.kind as 'door', raw, o.width, openingReach());
          if (!fit) throw new Error(`Place this ${o.kind} on a ${o.kind === 'gate' ? 'fence' : 'wall'}.`);
          o.barrierId = fit.barrierId;
          o.offset = fit.offset;
          o.position = fit.position;
        }
        if (isDevice(o.kind)) o.feedId = `device-${o.id}`;
        if (isArea(o.kind)) o.rings = [rectangle(o.position, o.width, o.depth)];
        p.objects.push(o);
        setSelected(o.id);
      });
      if (placed) setTool('select');
    }
  }
  // A basemap building becomes a first-class model: its own building entry (carrying the basemap
  // source id), estimated storeys with facade walls and a zone per floor — ready to edit further.
  function adoptBuilding({
    rings,
    sourceId,
    storeys,
    name,
  }: {
    rings: Point[][];
    sourceId: string | number;
    storeys: number;
    name: string;
  }) {
    let groundFloor = '';
    const success = commit(p => {
      if (p.buildings.some(b => b.sourceId === sourceId))
        throw new Error('That building is already part of this project.');
      const bid = uid();
      p.buildings.push({ id: bid, name, sourceId });
      const outline = rings[0];
      const xs = outline.map(pt => pt[0]),
        ys = outline.map(pt => pt[1]);
      const copyRings = () => rings.map(r => closeRing(r.map(pt => [...pt] as Point)));
      const footprint = createObject('building', centroid(outline), null, name);
      footprint.rings = copyRings();
      footprint.width = Math.max(...xs) - Math.min(...xs);
      footprint.depth = Math.max(...ys) - Math.min(...ys);
      p.objects.push(footprint);
      for (let i = 0; i < storeys; i++) {
        const fid = uid();
        if (!i) groundFloor = fid;
        p.floors.push({
          id: fid,
          buildingId: bid,
          name: `${name} · ${i ? `floor ${i}` : 'ground'}`,
          elevation: i * 3.5,
          height: 3.5,
        });
        const zone = createObject('zone', centroid(outline), fid, name);
        zone.rings = copyRings();
        zone.width = footprint.width;
        zone.depth = footprint.depth;
        zone.color = '#f7f8f6';
        p.objects.push(zone);
        const from = p.barriers.length;
        const closed = closeRing(outline.map(pt => [...pt] as Point));
        for (let k = 1; k < closed.length; k++) addBarrier(p, closed[k - 1], closed[k], fid, 'wall');
        p.barriers.slice(from).forEach(b => {
          b.name = 'Facade wall';
          b.thickness = 0.45;
          b.color = '#a6acb8';
        });
      }
    });
    if (success) {
      setTool('select');
      if (groundFloor) onFloorChange(groundFloor);
      notify(
        `Adopted “${name}” from the basemap · ${storeys} floor${storeys > 1 ? 's' : ''} created from MML attributes.`,
      );
    }
  }
  /** How far an opening looks for a wall. Shared, so a preview cannot promise a fit the click refuses. */
  const openingReach = () => Math.max(2, toleranceRef.current * 2);
  const isOpeningTool = (t: string) => t === 'door' || t === 'window' || t === 'gate';
  const onHover = (point: Point, tolerance: number) => {
    toleranceRef.current = tolerance;
    if (tool === 'select' || tool === 'pan' || threeD || !editing) return;
    if (isOpeningTool(tool)) {
      // Show the leaf on the wall it would land on, before the click rather than after it. Placing an
      // opening used to be blind: you clicked and either it took or you got an error telling you to
      // aim at a wall you could not see the edge of.
      setHover(point);
      setOpeningFit(fitOpening(project, floorId, tool as 'door', point, OPENING_WIDTH[tool] ?? 0.9, openingReach()));
      return;
    }
    if (tool === 'partition') {
      // Deliberately not gated on `snapping`: that toggle governs pulling a point onto a junction or
      // the grid, whereas inferring the wall is the entire tool. Off, it would just do nothing.
      setHover(point);
      setProposal(proposeWall(project, floorId, point));
      return;
    }
    const anchor = draft.at(-1);
    // The floor defines the angular grid throughout the stroke. A pointer crossing a nearby
    // angled wall must not rotate that grid halfway through drawing; junctions still snap exactly.
    const axis = snapping && anchor ? mainAxis(project, floorId) : null;
    const snap = snapping
      ? snapPoint(project, floorId, point, tolerance, anchor, true, axis ?? 0)
      : { point, label: '' };
    const holding = axis !== null && HELD.has(snap.label);
    setHover(snap.point);
    setHeld(holding);
    setSnapLabel(holding ? `${snap.label} to floor axis` : snap.label);
  };
  /** What the map draws to explain the wall about to exist: the axis a wall is being held to — run
   *  past both ends so it reads as a line the wall lies on rather than as the wall — or the whole
   *  segment the partition tool is offering. */
  const guides = useMemo<{ line: [Point, Point]; role: 'guide' | 'proposal' }[]>(() => {
    if (!editing || threeD) return [];
    if (isOpeningTool(tool)) return openingFit ? [{ line: openingFit.span, role: 'proposal' }] : [];
    if (tool === 'partition') return proposal ? [{ line: proposal.segment, role: 'proposal' }] : [];
    const anchor = draft.at(-1);
    if (!held || !anchor || !hover) return [];
    const length = distance(anchor, hover);
    if (length < 0.01) return [];
    const ux = (hover[0] - anchor[0]) / length,
      uy = (hover[1] - anchor[1]) / length,
      tail = 8;
    return [
      {
        line: [
          [anchor[0] - ux * tail, anchor[1] - uy * tail],
          [hover[0] + ux * tail, hover[1] + uy * tail],
        ],
        role: 'guide',
      },
    ];
  }, [editing, threeD, tool, proposal, openingFit, draft, hover, held]);
  const geometryPreview = (
    kind: GeometryDrag['kind'],
    id: string,
    raw: Point,
    free = false,
    ringIndex = 0,
    index = 0,
  ) => snapDragPoint(project, floorId, kind, id, raw, snapping && !free, toleranceRef.current, ringIndex, index);
  function vertexMove(
    kind: 'junction' | 'ring' | 'object' | 'barrier' | 'node' | 'opening' | 'rotate' | 'coverage',
    id: string,
    raw: Point,
    ringIndex = 0,
    index = 0,
    free = false,
  ) {
    // Shift releases the drop from the grid — the escape hatch for a camera that has to point at a
    // particular corner, or a wall that genuinely runs at 3°.
    const grid = snapping && !free;
    const point: Point = grid ? [Math.round(raw[0] * 2) / 2, Math.round(raw[1] * 2) / 2] : raw;
    if (kind === 'object') {
      updateObject(id, { position: point });
      return;
    }
    // An opening lives on its wall, so a drag slides it along that wall rather than moving it to
    // where the pointer went. Offset is clamped so the leaf stays wholly on the segment — the same
    // rule validation enforces, applied while dragging instead of refused afterwards.
    if (kind === 'opening') {
      const opening = project.objects.find(o => o.id === id);
      const barrier = project.barriers.find(b => b.id === opening?.barrierId);
      if (!opening || !barrier) return;
      const fit = fitOpening(
        { ...project, barriers: [barrier] },
        opening.floorId,
        opening.kind as 'door' | 'window' | 'gate' | 'turnstile',
        raw,
        opening.width,
        Infinity,
        id,
      );
      if (fit)
        updateObject(id, {
          offset: fit.offset,
          position: fit.position,
          ...(opening.kind === 'door' ? { doorSwing: draggedDoorSwing(project, opening, raw) } : {}),
        });
      return;
    }
    if (kind === 'rotate') {
      const object = project.objects.find(o => o.id === id);
      if (!object) return;
      const degrees = (Math.atan2(raw[1] - object.position[1], raw[0] - object.position[0]) * 180) / Math.PI;
      // Snapping holds a turned object to 15° detents; Shift lets it point anywhere.
      updateObject(id, { rotation: grid ? Math.round(degrees / 15) * 15 : Math.round(degrees * 10) / 10 });
      return;
    }
    // One handle carries both halves of a camera's cone: its distance is the reach, its bearing off
    // the camera's facing is half the field of view.
    if (kind === 'coverage') {
      const object = project.objects.find(o => o.id === id);
      if (!object) return;
      const dx = raw[0] - object.position[0],
        dy = raw[1] - object.position[1];
      const range = Math.max(1, Math.min(120, Math.hypot(dx, dy)));
      const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
      const half = Math.abs(((((bearing - (object.rotation ?? 0)) % 360) + 540) % 360) - 180);
      const spread = Math.max(10, Math.min(350, half * 2));
      updateObject(id, {
        coverageRange: Math.round(range * 10) / 10,
        coverageAngle: grid ? Math.round(spread / 5) * 5 : Math.round(spread),
      });
      return;
    }
    if (kind === 'node') {
      commit(p => {
        const n = (p.navNodes ?? []).find(n => n.id === id);
        if (n) n.position = point;
      });
      return;
    }
    if (!editing) return;
    const drop = geometryPreview(kind, id, raw, free, ringIndex, index);
    commit(p =>
      applyGeometryDrag(p, kind === 'ring' ? { kind, id, point: drop, ringIndex, index } : { kind, id, point: drop }),
    );
  }
  return {
    tool,
    setTool,
    draft,
    setDraft,
    hover,
    proposal,
    snapLabel,
    snapping,
    setSnapping,
    routeAnchor,
    setRouteAnchor,
    chooseTool,
    finish,
    mapClick,
    adoptBuilding,
    onHover,
    guides,
    geometryPreview,
    vertexMove,
    updateObject,
  };
}
