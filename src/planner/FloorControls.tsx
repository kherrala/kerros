import { Box, ChevronDown, ChevronUp, Footprints, Layers3 } from 'lucide-react';
import { FloorSelect } from '../components/controls';
import type { PlannerMode } from '../model/host';
import type { ProjectDocument } from '../model/types';
import { floorBand, floorCode } from './floors';

interface FloorControlsProps {
  project: ProjectDocument;
  floorId: string | null;
  mode: PlannerMode;
  viewMode: '2d' | '3d' | 'walk';
  stack: boolean;
  alarmFloors: Set<string | null>;
  showKeys: boolean;
  changeFloor: (id: string | null) => void;
  chooseMode: (mode: '2d' | '3d' | 'walk') => void;
  setStack: (enabled: boolean) => void;
  stepFloor: (direction: 1 | -1) => void;
}

export function FloorControls({
  project,
  floorId,
  mode,
  viewMode,
  stack,
  alarmFloors,
  showKeys,
  changeFloor,
  chooseMode,
  setStack,
  stepFloor,
}: FloorControlsProps) {
  const floor = project.floors.find(f => f.id === floorId);
  const nextView = viewMode === '2d' ? '3d' : viewMode === '3d' ? 'walk' : '2d';
  const threeD = viewMode !== '2d';
  const walk = viewMode === 'walk';
  const keyHint = (label: string) => (showKeys ? <kbd className="key-hint">{label}</kbd> : null);
  return (
    <>
      <div className="canvas-top-left">
        <div className="floor-chip">
          <Layers3 size={17} />
          <FloorSelect
            ariaLabel="Active floor"
            value={floorId ?? 'outdoors'}
            onPick={id => changeFloor(id === 'outdoors' ? null : id)}
            entries={[
              { id: 'outdoors', code: 'OUT', name: 'Outdoor site' },
              ...project.buildings.flatMap(b =>
                project.floors
                  .filter(f => f.buildingId === b.id)
                  .sort((a, c) => c.elevation - a.elevation)
                  .map(f => ({
                    id: f.id,
                    code: floorCode(project, f),
                    name: mode !== 'view' && alarmFloors.has(f.id) ? `⚠ ${f.name}` : f.name,
                    hint: project.buildings.length > 1 ? b.name : undefined,
                  })),
              ),
            ]}
          />
          {keyHint('⇧↑↓')}
        </div>
        <div className="view-switch">
          <button className={viewMode === '2d' ? 'active' : ''} onClick={() => chooseMode('2d')}>
            2D{nextView === '2d' && keyHint('T')}
          </button>
          <button className={viewMode === '3d' ? 'active' : ''} onClick={() => chooseMode('3d')}>
            <Box size={14} />
            3D{nextView === '3d' && keyHint('T')}
          </button>
          <button
            className={viewMode === 'walk' ? 'active' : ''}
            title="Walk through the building at eye level"
            onClick={() => chooseMode('walk')}
          >
            <Footprints size={14} />
            Walk{viewMode !== 'walk' && keyHint('3')}
          </button>
        </div>
        {threeD && !walk && (
          <button className={`stack-button ${stack ? 'active' : ''}`} onClick={() => setStack(!stack)}>
            <Layers3 size={15} />
            {stack ? 'All floors' : 'Cutaway'}
            {keyHint('X')}
          </button>
        )}
      </div>
      {(() => {
        const band = floorBand(project, floorId);
        const index = band.findIndex(f => f.id === floorId);
        const above = index < 0 ? band[0] : band[index + 1],
          below = index < 0 ? undefined : band[index - 1];
        return (
          <div className="floor-step">
            <button aria-label="Floor up" title="Floor up (⇧↑)" disabled={!above} onClick={() => stepFloor(1)}>
              <ChevronUp size={14} />
              {above && <b>{floorCode(project, above)}</b>}
            </button>
            <span className="floor-step-current">{floor ? floorCode(project, floor) : 'OUT'}</span>
            <button aria-label="Floor down" title="Floor down (⇧↓)" disabled={!below} onClick={() => stepFloor(-1)}>
              {below && <b>{floorCode(project, below)}</b>}
              <ChevronDown size={14} />
            </button>
          </div>
        );
      })()}
    </>
  );
}
