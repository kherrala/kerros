import {
  Hand,
  Landmark,
  MousePointer2,
  Plus,
  Redo2,
  Rows2,
  Ruler,
  Scissors,
  SquareDashedBottom,
  Undo2,
  Waypoints,
  X,
} from 'lucide-react';
import { EntityIcon } from '../components/Icons';
import { distance } from '../model/geometry';
import type { ObjectKind, Tool } from '../model/types';
import { isOpening } from '../model/types';
import { useStrings } from '../theme';
import type { useDrawingTools } from './useDrawingTools';

interface DrawingDockProps {
  drawing: Pick<
    ReturnType<typeof useDrawingTools>,
    'tool' | 'routeAnchor' | 'proposal' | 'draft' | 'setDraft' | 'snapLabel' | 'finish' | 'chooseTool'
  >;
  projectHasGraph: boolean;
  showKeys: boolean;
  palette: boolean;
  setPalette: (open: boolean) => void;
  canAdopt: boolean;
  adoptDerivedGraph: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const DRAW_TOOLS: Tool[] = ['wall', 'boundary', 'fence', 'zone', 'room', 'rectangle', 'hole', 'measure', 'evacuation'];

export function DrawingDock({
  drawing,
  projectHasGraph,
  showKeys,
  palette,
  setPalette,
  canAdopt,
  adoptDerivedGraph,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: DrawingDockProps) {
  const en = useStrings();
  const { tool, routeAnchor, proposal, draft, setDraft, snapLabel, finish, chooseTool } = drawing;
  return (
    <div className="drawing-dock-wrap">
      {tool === 'route' && !projectHasGraph && (
        <button className="button secondary adopt-graph" onClick={adoptDerivedGraph}>
          <Waypoints size={14} />
          Adopt inferred graph
        </button>
      )}
      {tool !== 'select' && tool !== 'pan' && (
        <div className="tool-instruction">
          <span className="tool-instruction-dot" />
          <strong>{en.tools[tool]}</strong>
          <span>
            {tool === 'route'
              ? routeAnchor
                ? 'Click to chain the next route node · Esc ends the chain'
                : projectHasGraph
                  ? 'Click to place route nodes · lifts, stairs, doors and POIs link automatically'
                  : 'Showing the graph the plan implies — spaces joined by their portals. Adopt it to edit it.'
              : tool === 'partition'
                ? proposal
                  ? 'Click to build the wall shown · it squares to what it is nearest'
                  : 'Hover inside a space to be offered the wall it is missing'
                : tool === 'enclose'
                  ? 'Click inside a closed boundary to create or select its space'
                  : tool === 'split'
                    ? draft.length
                      ? 'Now click the opposite wall to cut the room in two'
                      : 'Click one wall of a room to start the cut'
                    : tool === 'adopt'
                      ? 'Click a building on the basemap to bring it into the project'
                      : tool === 'measure' && draft.length === 2
                        ? `${distance(draft[0], draft[1]).toFixed(2)} m`
                        : DRAW_TOOLS.includes(tool)
                          ? draft.length
                            ? `${draft.length} point${draft.length > 1 ? 's' : ''} · ${snapLabel}`
                            : 'Click on the map to start'
                          : isOpening(tool as ObjectKind)
                            ? 'Click a supporting wall or fence'
                            : 'Click on the map to place'}{' '}
          </span>
          {draft.length > 0 && tool !== 'rectangle' && (
            <button onClick={finish}>
              Finish <kbd>↵</kbd>
            </button>
          )}
          {draft.length > 0 && (
            <button aria-label="Undo last point" onClick={() => setDraft(draft.slice(0, -1))}>
              Undo point <kbd>⌫</kbd>
            </button>
          )}
          <button aria-label="Cancel drawing" onClick={() => chooseTool('select')}>
            <X size={14} />
          </button>
        </div>
      )}
      {palette && (
        <div className="tool-palette">
          <div>
            <h3>Draw your space</h3>
            {(['wall', 'boundary', 'fence', 'room', 'enclose', 'zone', 'rectangle', 'hole'] as Tool[]).map(t => (
              <button key={t} onClick={() => chooseTool(t)}>
                <EntityIcon kind={t} />
                {en.tools[t]}
              </button>
            ))}
          </div>
          <div>
            <h3>Openings &amp; devices</h3>
            {(['door', 'window', 'gate', 'turnstile', 'reader', 'camera', 'alarm'] as Tool[]).map(t => (
              <button key={t} onClick={() => chooseTool(t)}>
                <EntityIcon kind={t} />
                {en.tools[t]}
              </button>
            ))}
          </div>
          <div>
            <h3>Site objects</h3>
            {(['elevator', 'stairs', 'office', 'container', 'storage', 'poi'] as Tool[]).map(t => (
              <button key={t} onClick={() => chooseTool(t)}>
                <EntityIcon kind={t} />
                {en.tools[t]}
              </button>
            ))}
            <button onClick={() => chooseTool('route')}>
              <Waypoints size={17} strokeWidth={1.75} />
              {en.tools.route}
            </button>
          </div>
          <div>
            <h3>Sensors &amp; areas</h3>
            {(['light', 'sensor', 'equipment', 'evacuation'] as Tool[]).map(t => (
              <button key={t} onClick={() => chooseTool(t)}>
                <EntityIcon kind={t} />
                {en.tools[t]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="drawing-dock">
        {(() => {
          const KEYS: Partial<Record<Tool, string>> = {
            select: 'V',
            pan: 'H',
            wall: 'W',
            zone: 'Z',
            door: 'D',
            camera: 'C',
            measure: 'M',
            split: 'S',
            enclose: 'E',
          };
          const hint = (t: Tool) => (showKeys && KEYS[t] ? <kbd className="key-hint">{KEYS[t]}</kbd> : null);
          return (
            <>
              <button
                className={tool === 'select' ? 'active' : ''}
                aria-label="Select tool"
                title="Select (V)"
                onClick={() => chooseTool('select')}
              >
                <MousePointer2 size={20} />
                {hint('select')}
              </button>
              <button
                className={tool === 'pan' ? 'active' : ''}
                aria-label="Pan tool"
                title="Pan (H)"
                onClick={() => chooseTool('pan')}
              >
                <Hand size={19} />
                {hint('pan')}
              </button>
              <i />
              {(['wall', 'zone', 'door', 'camera', 'poi'] as Tool[]).map(t => (
                <button
                  key={t}
                  className={tool === t ? 'active' : ''}
                  aria-label={`${en.tools[t]} tool`}
                  title={KEYS[t] ? `${en.tools[t]} (${KEYS[t]})` : en.tools[t]}
                  onClick={() => chooseTool(t)}
                >
                  <EntityIcon kind={t} size={20} />
                  {hint(t)}
                </button>
              ))}
              <button
                className={tool === 'partition' ? 'active' : ''}
                aria-label="Partition tool"
                title="Partition (P)"
                onClick={() => chooseTool('partition')}
              >
                <Rows2 size={19} />
                {hint('partition')}
              </button>
              <button
                className={tool === 'enclose' ? 'active' : ''}
                aria-label="Space from walls tool"
                title="Space from walls (E)"
                onClick={() => chooseTool('enclose')}
              >
                <SquareDashedBottom size={19} />
                {hint('enclose')}
              </button>
              <button
                className={tool === 'split' ? 'active' : ''}
                aria-label="Split room tool"
                title="Split room (S)"
                onClick={() => chooseTool('split')}
              >
                <Scissors size={19} />
                {hint('split')}
              </button>
              <button
                className={tool === 'route' ? 'active' : ''}
                aria-label="Route path tool"
                title="Route path"
                onClick={() => chooseTool('route')}
              >
                <Waypoints size={19} />
              </button>
              <button
                className={palette ? 'active' : ''}
                aria-label="All drawing tools"
                title="All drawing tools"
                onClick={() => setPalette(!palette)}
              >
                <Plus size={20} />
              </button>
              <i />
              <button
                className={tool === 'measure' ? 'active' : ''}
                aria-label="Measure tool"
                title="Measure (M)"
                onClick={() => chooseTool('measure')}
              >
                <Ruler size={19} />
                {hint('measure')}
              </button>
            </>
          );
        })()}
        {canAdopt && (
          <button
            className={tool === 'adopt' ? 'active' : ''}
            aria-label="Adopt building from map"
            title="Adopt building from map"
            onClick={() => chooseTool('adopt')}
          >
            <Landmark size={19} />
          </button>
        )}
        <i />
        <button aria-label="Undo" title="Undo (⌘Z)" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={18} />
        </button>
        <button aria-label="Redo" title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={18} />
        </button>
      </div>
      <div className="dock-caption">
        {tool === 'select' ? 'Click to select · drag handles to edit' : 'Escape to cancel'}
        <span>⌘ Z to undo</span>
      </div>
    </div>
  );
}
