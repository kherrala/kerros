import { useEffect, useMemo, useRef, useState } from 'react';
import { LocateFixed } from 'lucide-react';
import { navEdges, navNodes } from '../model/navigation';
import type { ProjectDocument } from '../model/types';
import type { StructureTarget } from './StructureView';
import { balanceGraph, type GraphPoint } from './graphLayout';

const COLORS = { walk: '#8393a9', door: '#c28332', stairs: '#2eaaa0', elevator: '#9777f1' };
const FLOORS = ['#7367e6', '#2aabb3', '#d9a54b', '#ce6f91', '#5d9d6e', '#a67fc4'];
export interface NavigationGraphProps {
  project: ProjectDocument;
  initialFloor?: string | null;
  dark: boolean;
  onLocate: (target: StructureTarget) => void;
  onClose: () => void;
}
export function NavigationGraph({ project, initialFloor, dark, onLocate, onClose }: NavigationGraphProps) {
  const [floor, setFloor] = useState(initialFloor === undefined ? 'all' : (initialFloor ?? 'outdoors'));
  const [auto, setAuto] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [settled, setSettled] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, scale: 1 });
  const redraw = useRef<() => void>(() => {});
  const fit = useRef<() => void>(() => {});
  const tick = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const autoFit = useRef(true);
  const graph = useMemo(() => {
    const nodes = navNodes(project).filter(node => floor === 'all' || (node.floorId ?? 'outdoors') === floor);
    const byId = new Map(nodes.map((node, i) => [node.id, i]));
    const edges = navEdges(project).filter(edge => byId.has(edge.aId) && byId.has(edge.bId));
    const points: GraphPoint[] = nodes.map((_node, i) => {
      const angle = i * 2.399963,
        radius = 15 * Math.sqrt(i + 1);
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
    });
    const objects = new Map(project.objects.map(object => [object.id, object]));
    return {
      nodes,
      edges,
      points,
      links: edges.map(edge => [byId.get(edge.aId)!, byId.get(edge.bId)!] as [number, number]),
      objects,
    };
  }, [project, floor]);
  const chosen = graph.nodes.find(node => node.id === selected);
  const nodeName = (index: number) => {
    const node = graph.nodes[index];
    return graph.objects.get(node.objectId ?? '')?.name || node.id;
  };
  const floorName = (id: string | null) =>
    id === null ? 'Outdoor site' : (project.floors.find(f => f.id === id)?.name ?? id);
  const locate = () => {
    if (chosen)
      onLocate({
        objectIds: chosen.objectId ? [chosen.objectId] : [],
        floorId: chosen.floorId,
        position: chosen.position,
      });
  };
  useEffect(() => {
    tick.current = 0;
    setSettled(false);
    setSelected('');
    autoFit.current = true;
  }, [graph]);
  useEffect(() => {
    const element = canvas.current,
      context = element?.getContext('2d');
    if (!element || !context) return;
    let width = 1,
      height = 1,
      frame = 0,
      lastFrame = 0,
      disposed = false;
    const colors = new Map(project.floors.map((f, i) => [f.id, FLOORS[i % FLOORS.length]]));
    const draw = () => {
      const selected = selectedRef.current;
      const { x, y, scale } = view.current;
      context.clearRect(0, 0, width, height);
      context.save();
      context.translate(width / 2 + x, height / 2 + y);
      context.scale(scale, scale);
      graph.edges.forEach((edge, i) => {
        const [a, b] = graph.links[i],
          p = graph.points[a],
          q = graph.points[b];
        const highlight = edge.aId === selected || edge.bId === selected;
        context.globalAlpha = selected && !highlight ? 0.18 : 0.65;
        context.strokeStyle = COLORS[edge.kind];
        context.lineWidth = (highlight ? 2.5 : 1) / scale;
        context.beginPath();
        context.moveTo(p.x, p.y);
        context.lineTo(q.x, q.y);
        context.stroke();
        if (edge.directed) {
          const angle = Math.atan2(q.y - p.y, q.x - p.x),
            length = 7 / scale;
          const ax = q.x - (Math.cos(angle) * 7) / scale,
            ay = q.y - (Math.sin(angle) * 7) / scale;
          context.fillStyle = COLORS[edge.kind];
          context.beginPath();
          context.moveTo(ax, ay);
          context.lineTo(ax - Math.cos(angle - 0.5) * length, ay - Math.sin(angle - 0.5) * length);
          context.lineTo(ax - Math.cos(angle + 0.5) * length, ay - Math.sin(angle + 0.5) * length);
          context.closePath();
          context.fill();
        }
      });
      context.globalAlpha = 1;
      graph.nodes.forEach((node, i) => {
        const p = graph.points[i],
          active = node.id === selected;
        context.beginPath();
        context.arc(p.x, p.y, (active ? 7 : 4) / scale, 0, Math.PI * 2);
        context.fillStyle = colors.get(node.floorId ?? '') ?? '#8b94a4';
        context.fill();
        if (active) {
          context.strokeStyle = dark ? '#fff' : '#191c32';
          context.lineWidth = 2 / scale;
          context.stroke();
        }
        if (active || (graph.nodes.length < 65 && scale > 0.45)) {
          context.font = `${12 / scale}px system-ui`;
          context.fillStyle = dark ? '#eeeefa' : '#24263a';
          context.fillText(nodeName(i).slice(0, 38), p.x + 9 / scale, p.y - 7 / scale);
        }
      });
      context.restore();
    };
    const fitGraph = () => {
      if (!graph.points.length) return;
      let left = Infinity,
        right = -Infinity,
        top = Infinity,
        bottom = -Infinity;
      for (const p of graph.points) {
        left = Math.min(left, p.x);
        right = Math.max(right, p.x);
        top = Math.min(top, p.y);
        bottom = Math.max(bottom, p.y);
      }
      const scale = Math.max(
        0.05,
        Math.min(3, (width - 90) / Math.max(1, right - left), (height - 90) / Math.max(1, bottom - top)),
      );
      view.current = { x: (-(left + right) * scale) / 2, y: (-(top + bottom) * scale) / 2, scale };
      draw();
    };
    const animate = (time: number) => {
      frame = 0;
      if (disposed) return;
      if (autoRef.current && tick.current < 360) {
        if (time - lastFrame > 30) {
          balanceGraph(graph.points, graph.links, tick.current++);
          if (autoFit.current && tick.current % 20 === 0) fitGraph();
          else draw();
          lastFrame = time;
        }
        frame = requestAnimationFrame(animate);
      } else {
        draw();
        if (tick.current >= 360) setSettled(true);
      }
    };
    const wake = () => {
      draw();
      if (!frame && !disposed) frame = requestAnimationFrame(animate);
    };
    redraw.current = wake;
    fit.current = fitGraph;
    const resize = new ResizeObserver(() => {
      const box = element.getBoundingClientRect();
      width = box.width;
      height = box.height;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      fitGraph();
      wake();
    });
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      autoFit.current = false;
      const box = element.getBoundingClientRect(),
        px = event.clientX - box.left - box.width / 2,
        py = event.clientY - box.top - box.height / 2;
      const old = view.current.scale,
        scale = Math.max(0.03, Math.min(8, old * Math.exp(-event.deltaY * 0.001)));
      view.current = {
        scale,
        x: px - ((px - view.current.x) * scale) / old,
        y: py - ((py - view.current.y) * scale) / old,
      };
      wake();
    };
    element.addEventListener('wheel', wheel, { passive: false });
    resize.observe(element);
    frame = requestAnimationFrame(animate);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      element.removeEventListener('wheel', wheel);
    };
  }, [graph, dark, project]);
  useEffect(() => redraw.current(), [auto, selected]);
  const drag = useRef<{ x: number; y: number; startX: number; startY: number; node: number; moved: boolean } | null>(
    null,
  );
  const controls = graph.nodes
    .map((node, i) => ({ node, i, label: `${nodeName(i)} · ${floorName(node.floorId)}` }))
    .filter(row => row.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 100);
  return (
    <section className="navigation-graph" aria-label="Navigation graph view">
      <div className="navigation-graph-toolbar">
        <strong>Navigation graph</strong>
        <select aria-label="Graph floor" value={floor} onChange={event => setFloor(event.target.value)}>
          <option value="all">All floors</option>
          <option value="outdoors">Outdoor site</option>
          {project.floors.map(f => (
            <option key={f.id} value={f.id}>
              {floorName(f.id)}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} />
          Auto balance
        </label>
        <button
          className="button secondary small"
          onClick={() => {
            tick.current = 0;
            setSettled(false);
            setAuto(true);
            redraw.current();
          }}
        >
          Rebalance
        </button>
        <button className="button secondary small" onClick={() => fit.current()}>
          Fit graph
        </button>
        <button className="button secondary small" onClick={onClose}>
          Back to map
        </button>
      </div>
      <div className="navigation-graph-search">
        <input
          type="search"
          aria-label="Search graph nodes"
          placeholder="Find a room or transport node…"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <select
          aria-label="Graph node"
          value={selected}
          onChange={event => {
            autoFit.current = false;
            const i = graph.nodes.findIndex(n => n.id === event.target.value);
            setSelected(event.target.value);
            if (i >= 0) {
              const p = graph.points[i];
              view.current.x = -p.x * view.current.scale;
              view.current.y = -p.y * view.current.scale;
              redraw.current();
            }
          }}
        >
          <option value="">Select a node ({graph.nodes.length})</option>
          {chosen && !controls.some(row => row.node.id === chosen.id) && <option value={chosen.id}>{chosen.id}</option>}
          {controls.map(row => (
            <option value={row.node.id} key={row.node.id}>
              {row.label}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label="Find node on map"
          title="Find on map"
          disabled={!chosen}
          onClick={locate}
        >
          <LocateFixed size={16} />
        </button>
      </div>
      <div className="navigation-graph-stage">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`Navigation graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`}
          tabIndex={0}
          onPointerDown={event => {
            autoFit.current = false;
            event.currentTarget.setPointerCapture(event.pointerId);
            const box = event.currentTarget.getBoundingClientRect(),
              x = event.clientX - box.left,
              y = event.clientY - box.top;
            const gx = (x - box.width / 2 - view.current.x) / view.current.scale,
              gy = (y - box.height / 2 - view.current.y) / view.current.scale;
            const node = graph.points.findIndex(p => Math.hypot(p.x - gx, p.y - gy) < 10 / view.current.scale);
            drag.current = { x, y, startX: x, startY: y, node, moved: false };
            if (node >= 0) graph.points[node].pinned = true;
          }}
          onPointerMove={event => {
            const current = drag.current;
            if (!current) return;
            const box = event.currentTarget.getBoundingClientRect(),
              x = event.clientX - box.left,
              y = event.clientY - box.top;
            current.moved ||= Math.hypot(x - current.startX, y - current.startY) > 3;
            if (current.node >= 0) {
              const p = graph.points[current.node];
              p.x += (x - current.x) / view.current.scale;
              p.y += (y - current.y) / view.current.scale;
            } else {
              view.current.x += x - current.x;
              view.current.y += y - current.y;
            }
            current.x = x;
            current.y = y;
            redraw.current();
          }}
          onPointerUp={() => {
            const current = drag.current;
            drag.current = null;
            if (current && current.node >= 0) {
              graph.points[current.node].pinned = false;
              if (!current.moved) setSelected(graph.nodes[current.node].id);
              else {
                tick.current = 0;
                setSettled(false);
                redraw.current();
              }
            }
          }}
          onPointerCancel={() => {
            if (drag.current && drag.current.node >= 0) graph.points[drag.current.node].pinned = false;
            drag.current = null;
          }}
          onKeyDown={event => {
            event.stopPropagation();
            autoFit.current = false;
            if (event.key === '+' || event.key === '=') view.current.scale = Math.min(8, view.current.scale * 1.2);
            else if (event.key === '-') view.current.scale = Math.max(0.03, view.current.scale / 1.2);
            else if (event.key === 'ArrowLeft') view.current.x += 40;
            else if (event.key === 'ArrowRight') view.current.x -= 40;
            else if (event.key === 'ArrowUp') view.current.y += 40;
            else if (event.key === 'ArrowDown') view.current.y -= 40;
            else if (event.key === 'Escape') onClose();
            else return;
            event.preventDefault();
            redraw.current();
          }}
        />
        {!graph.nodes.length && <p className="navigation-graph-empty">No navigation nodes on this floor.</p>}
      </div>
      <div className="navigation-graph-legend">
        {Object.entries(COLORS).map(([kind, color]) => (
          <span key={kind}>
            <i style={{ background: color }} />
            {kind === 'stairs' ? 'stairs / escalators' : kind}
          </span>
        ))}
        <span>Arrows: one-way travel</span>
        <span>
          {graph.nodes.length} nodes · {graph.edges.length} edges ·{' '}
          {auto ? (settled ? 'Balanced' : 'Balancing…') : 'Layout paused'}
        </span>
      </div>
      <p className="navigation-graph-help">
        Drag nodes to arrange · drag background to pan · scroll to zoom. Layout changes only this view.
      </p>
    </section>
  );
}
