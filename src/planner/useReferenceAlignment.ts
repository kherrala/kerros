import { useState } from 'react';
import { makeDrawing, type PreparedDrawing } from '../components/ImportDialog';
import { alignDrawing, distance } from '../model/geometry';
import type { AssetRepository, Drawing, Point, ProjectDocument } from '../model/types';
import type { CommitProject } from './types';

interface Alignment {
  prepared: PreparedDrawing;
  imagePoints: Point[];
  mapPoints: Point[];
  drawing: Drawing;
  preview: boolean;
}

interface ReferenceAlignmentOptions {
  project: ProjectDocument;
  floorId: string | null;
  assets: AssetRepository;
  commit: CommitProject;
  notify: (message: string) => void;
  setSelected: (id: string | null) => void;
  onStart: () => void;
}

/** A reference drawing stays provisional until its alignment or scale is accepted. */
export function useReferenceAlignment({
  project,
  floorId,
  assets,
  commit,
  notify,
  setSelected,
  onStart,
}: ReferenceAlignmentOptions) {
  const [alignment, setAlignment] = useState<Alignment | null>(null);
  async function startAlignment(prepared: PreparedDrawing) {
    const drawing = makeDrawing(prepared, floorId);
    try {
      await assets.put(drawing.assetId, prepared.blob);
      setAlignment({ prepared, drawing, imagePoints: [], mapPoints: [], preview: false });
      onStart();
    } catch (e) {
      notify(`Could not store drawing: ${(e as Error).message}`);
    }
  }
  function previewAlignment() {
    if (!alignment) return;
    try {
      const transform = alignDrawing(alignment.imagePoints as [Point, Point], alignment.mapPoints as [Point, Point]);
      setAlignment({ ...alignment, drawing: { ...alignment.drawing, ...transform }, preview: true });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function confirmAlignment() {
    if (!alignment) return;
    if (commit(p => p.drawings.push(alignment.drawing))) {
      setSelected(alignment.drawing.id);
      setAlignment(null);
      notify('Drawing aligned. Trace walls and rooms over the reference.');
    }
  }
  function calibrate(metres: number) {
    if (!alignment || alignment.imagePoints.length !== 2 || !Number.isFinite(metres) || metres <= 0) return;
    const pixels = distance(alignment.imagePoints[0], alignment.imagePoints[1]);
    if (pixels < 1) {
      notify('Choose two distinct image points.');
      return;
    }
    const drawing = { ...alignment.drawing, scale: metres / pixels };
    if (commit(p => p.drawings.push(drawing))) {
      setSelected(drawing.id);
      setAlignment(null);
    }
  }
  const displayProject = alignment?.preview
    ? { ...project, drawings: [...project.drawings, alignment.drawing] }
    : project;
  return { alignment, setAlignment, startAlignment, previewAlignment, confirmAlignment, calibrate, displayProject };
}
