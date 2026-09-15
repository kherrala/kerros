import { X } from 'lucide-react';
import { Choice, Toggle } from '../components/controls';
import type { BasemapConfig } from '../model/host';
import { EXTERIOR_PRESETS, type ExteriorPreset } from '../model/materials';
import type { ProjectDocument } from '../model/types';
import type { CommitProject } from './types';
import type { useMapDisplay } from './useMapDisplay';

interface MapSettingsProps {
  display: ReturnType<typeof useMapDisplay>;
  project: ProjectDocument;
  floorId: string | null;
  editing: boolean;
  hostBasemap?: BasemapConfig;
  commit: CommitProject;
  snapping: boolean;
  setSnapping: (enabled: boolean) => void;
}

export function MapSettings({
  display,
  project,
  floorId,
  editing,
  hostBasemap,
  commit,
  snapping,
  setSnapping,
}: MapSettingsProps) {
  const {
    coverage,
    setCoverage,
    showLabels,
    setShowLabels,
    basemapMode,
    setBasemapMode,
    setSettings,
    showPlan,
    setShowPlan,
    lighting,
    setLighting,
    sunNote,
    excavation,
    setExcavation,
    cityBuildings,
    setCityBuildings,
    cadastre,
    setCadastre,
    hasCadastre,
    surveyed,
  } = display;
  return (
    <div className="map-settings">
      <h3>
        Map display
        <button className="icon-button" aria-label="Close map settings" onClick={() => setSettings(false)}>
          <X size={15} />
        </button>
      </h3>
      <label className="field">
        <span>Basemap</span>
        <select
          aria-label="Basemap"
          value={basemapMode}
          onChange={e => setBasemapMode(e.target.value as typeof basemapMode)}
        >
          <option value="plan">Plan background · offline</option>
          {hostBasemap && <option value="host">{hostBasemap.label ?? 'Map background'}</option>}
        </select>
      </label>
      {editing &&
        (() => {
          const building =
            project.buildings.find(b => b.id === project.floors.find(f => f.id === floorId)?.buildingId) ??
            project.buildings[0];
          return (
            <label className="field">
              <span>Exterior finish · {building.name}</span>
              <select
                aria-label="Exterior finish"
                value={building.exteriorPreset ?? ''}
                onChange={e =>
                  commit(p => {
                    p.buildings.find(b => b.id === building.id)!.exteriorPreset = (e.target.value || undefined) as
                      | ExteriorPreset
                      | undefined;
                  })
                }
              >
                <option value="">Original materials</option>
                {Object.entries(EXTERIOR_PRESETS).map(([id, preset]) => (
                  <option key={id} value={id}>
                    {preset.name}
                  </option>
                ))}
              </select>
              <small>Applies to the exterior on every floor.</small>
            </label>
          );
        })()}
      <Toggle
        label="Architecture plan"
        description="Hide to see the basemap under this floor"
        value={showPlan}
        onChange={() => setShowPlan(!showPlan)}
      />
      <Toggle label="Space labels" value={showLabels} onChange={() => setShowLabels(!showLabels)} />
      <Toggle label="Camera coverage" value={coverage} onChange={() => setCoverage(!coverage)} />
      <Choice
        label="Sunlight"
        description={
          lighting === 'auto'
            ? `Following the sun over this site — ${sunNote}`
            : 'Pinned; switch to Auto to follow the clock'
        }
        value={lighting}
        options={[
          { value: 'auto', label: 'Auto', title: 'Sun position from this site and the time of day' },
          { value: 'day', label: 'Day', title: 'A fixed afternoon sun' },
          { value: 'evening', label: 'Dusk', title: 'A fixed dusk, with lamps lit' },
        ]}
        onChange={setLighting}
      />
      <Toggle
        label="Ground section"
        description="Cut the earth away around below-grade floors"
        value={excavation}
        onChange={() => setExcavation(!excavation)}
      />
      <Toggle
        label="3D city buildings"
        description="Raise surrounding basemap buildings by their MML attributes"
        value={cityBuildings}
        onChange={() => setCityBuildings(!cityBuildings)}
      />
      {hasCadastre && (
        <Toggle
          label="Property boundaries"
          description="MML cadastral parcel overlay"
          value={cadastre}
          onChange={() => setCadastre(!cadastre)}
        />
      )}
      {editing && <Toggle label="Snap to geometry & grid" value={snapping} onChange={() => setSnapping(!snapping)} />}
      <p className="helper">
        {surveyed
          ? 'Vector map background; attribution is shown on the map.'
          : 'A quiet background for detailed floor planning.'}
      </p>
    </div>
  );
}
