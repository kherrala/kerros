import { useEffect, useMemo, useState } from 'react';
import { neutralBasemap } from '../adapters/basemap';
import { FIXED, sunAt } from '../map/lighting';
import type { BasemapConfig, ViewState } from '../model/host';
import type { ProjectDocument } from '../model/types';

/** Display preferences survive switching between the map, graph, viewer and editor. */
export function useMapDisplay(project: ProjectDocument, hostBasemap?: BasemapConfig, initialView?: ViewState) {
  const [coverage, setCoverage] = useState(false),
    [showLabels, setShowLabels] = useState(true),
    [basemapMode, setBasemapMode] = useState<'plan' | 'host'>(
      hostBasemap && initialView?.basemap !== 'plan' ? 'host' : 'plan',
    ),
    [settings, setSettings] = useState(false),
    [showPlan, setShowPlan] = useState(true),
    // The sun follows the clock and the place by default; 'day' and 'evening' pin it, for a
    // screenshot or for looking at a building under a light it will not see for six months.
    [lighting, setLighting] = useState<'auto' | 'day' | 'evening'>('auto'),
    // Re-read every ten minutes. The sun turns 15° an hour, so that is a couple of degrees — under
    // the width of the sun itself — and it means a plan left open through the afternoon dims and
    // reddens and eventually lights its own windows, without a frame of work spent on it.
    [clock, setClock] = useState(() => Date.now()),
    // A soil section explains a basement, and a single cellar does not need explaining: the floor
    // selector already says how far down it is, and the block is bigger than the house. Below two
    // storeys of depth it is scenery in the way; below twenty it is the whole story.
    [excavation, setExcavation] = useState(() => project.floors.filter(f => f.elevation < 0).length > 1),
    [cityBuildings, setCityBuildings] = useState(true),
    [cadastre, setCadastre] = useState(true);
  // Where the sun stands over THIS building, now. The origin is a lng/lat, so the model knows the
  // latitude it is drawn at and the longitude that sets its clock — a Helsinki plan is lit by a
  // Helsinki sun, low and from the south, rather than by a fixed studio lamp.
  const sun = useMemo(
    () => (lighting === 'auto' ? sunAt([project.origin[0], project.origin[1]], clock) : FIXED[lighting]),
    [lighting, clock, project.origin],
  );
  useEffect(() => {
    if (lighting !== 'auto') return;
    const tick = window.setInterval(() => setClock(Date.now()), 600000);
    return () => window.clearInterval(tick);
  }, [lighting]);
  // "Why has it gone dark?" is the next question otherwise. Say the time being drawn and how high
  // the sun is, so a dusk view reads as half past three in December rather than as a bug.
  const sunNote = useMemo(() => {
    const clockTime = new Date(clock).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const angle = Math.round(Math.abs(sun.altitude));
    return `${clockTime}, ${angle}° ${sun.altitude < 0 ? 'below' : 'above'} the horizon`;
  }, [clock, sun.altitude]);
  const basemap = basemapMode === 'host' && hostBasemap ? hostBasemap : neutralBasemap;
  // A host basemap that declares a vectorSchema unlocks the schema-driven features; each is gated on
  // the specific part it needs (footprints → adopt/3D-city, cadastre → the parcel overlay).
  const surveyed = basemapMode === 'host' && !!hostBasemap?.vectorSchema;
  const canAdopt = surveyed && !!hostBasemap?.vectorSchema?.footprints;
  const hasCadastre = surveyed && !!hostBasemap?.vectorSchema?.cadastre;
  return {
    coverage,
    setCoverage,
    showLabels,
    setShowLabels,
    basemapMode,
    setBasemapMode,
    settings,
    setSettings,
    showPlan,
    setShowPlan,
    lighting,
    setLighting,
    excavation,
    setExcavation,
    cityBuildings,
    setCityBuildings,
    cadastre,
    setCadastre,
    sun,
    sunNote,
    basemap,
    surveyed,
    canAdopt,
    hasCadastre,
  };
}
