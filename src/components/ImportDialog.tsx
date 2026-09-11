import { useEffect, useRef, useState } from 'react';
import { FileImage, FileJson, UploadCloud, ArrowRight, Check } from 'lucide-react';
import type { AssetRepository, Drawing, Point, ProjectDocument } from '../model/types';
import type { ImportProjection } from '../model/host';
import { uid } from '../model/types';
import { blobDataUrl, importProject } from '../adapters/persistence';
import { importFootprints } from '../model/imports';
import type { PlanEntity } from '../import/planImport';
import { Modal } from './controls';

export interface PreparedDrawing {
  blob: Blob;
  name: string;
  width: number;
  height: number;
}
export function ImportDialog({
  project,
  floorId,
  assets,
  onClose,
  onProject,
  onFootprints,
  onDrawing,
  onPlan,
  onOrigin,
  importProjections = [],
}: {
  project: ProjectDocument;
  floorId: string | null;
  assets: AssetRepository;
  onClose: () => void;
  onProject: (p: ProjectDocument) => void | Promise<void>;
  onFootprints: (objects: ProjectDocument['objects']) => void;
  onDrawing: (drawing: PreparedDrawing) => void | Promise<void>;
  /** CAD plan entities (metres, extracted host-side — see scripts/plan-import). The handler builds
   *  walls, rooms and openings on the chosen floor through the editor's transactional commit. */
  onPlan?: (entities: PlanEntity[], floorId: string | null) => void;
  /** Turn the site to a new bearing (degrees clockwise from north) before the plan is applied. */
  onOrigin?: (bearing: number) => void;
  importProjections?: ImportProjection[];
}) {
  const [kind, setKind] = useState<'drawing' | 'footprint' | 'plan' | 'project'>('drawing'),
    [file, setFile] = useState<File | null>(null),
    [crsIndex, setCrsIndex] = useState(0), // 0 = WGS84 lng/lat; 1..N = importProjections[i-1]
    [type, setType] = useState<'building' | 'parcel'>('building'),
    [planFloor, setPlanFloor] = useState(floorId),
    [bearing, setBearing] = useState(String(project.origin[2] ?? 0)),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function proceed() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Choose a file smaller than 50 MB.');
      if (kind === 'project') await onProject(await importProject(await file.text(), assets));
      else if (kind === 'plan') {
        const parsed: unknown = JSON.parse(await file.text());
        const entities = Array.isArray(parsed) ? parsed : ((parsed as { entities?: PlanEntity[] }).entities ?? null);
        if (!Array.isArray(entities))
          throw new Error('Expected plan-entity JSON (see scripts/plan-import/extract.mjs).');
        // The heading is a property of the site, not of this sheet — apply it before the plan lands,
        // so the walls are built into a frame already facing the right way.
        const heading = Number(bearing);
        if (Number.isFinite(heading) && heading !== (project.origin[2] ?? 0)) onOrigin?.(heading);
        onPlan?.(entities as PlanEntity[], planFloor);
      } else if (kind === 'footprint')
        onFootprints(
          importFootprints(JSON.parse(await file.text()), project, type, importProjections[crsIndex - 1]?.toLngLat),
        );
      else {
        let blob: Blob = file;
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const pdfjs = await import('pdfjs-dist');
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            'pdfjs-dist/build/pdf.worker.min.mjs',
            import.meta.url,
          ).toString();
          const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
          const pdf = await task.promise;
          try {
            if (!Number.isInteger(page) || page < 1 || page > pdf.numPages)
              throw new Error(`Choose a page between 1 and ${pdf.numPages}.`);
            const pdfPage = await pdf.getPage(page);
            const natural = pdfPage.getViewport({ scale: 1 });
            const scale = Math.min(2, 4096 / Math.max(natural.width, natural.height));
            const viewport = pdfPage.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            await pdfPage.render({ canvas, viewport }).promise;
            blob = await new Promise<Blob>((resolve, reject) =>
              canvas.toBlob(
                result => (result ? resolve(result) : reject(new Error('Could not render this PDF page.'))),
                'image/png',
              ),
            );
          } finally {
            await task.destroy();
          }
        }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type))
          throw new Error('Use a PNG, JPEG, WebP, or PDF drawing.');
        const bitmap = await createImageBitmap(blob);
        const width = bitmap.width,
          height = bitmap.height;
        bitmap.close();
        await onDrawing({
          blob,
          name: file.name + (file.name.endsWith('.pdf') ? ` · page ${page}` : ''),
          width,
          height,
        });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Bring your site into focus"
      subtitle="Start with the drawings and geometry you already have."
      onClose={onClose}
    >
      <div className="import-tabs">
        {(['drawing', 'footprint', 'plan', 'project'] as const).map(k => (
          <button
            key={k}
            className={kind === k ? 'active' : ''}
            onClick={() => {
              setKind(k);
              setFile(null);
              setError('');
            }}
          >
            {k === 'drawing' ? <FileImage size={19} /> : <FileJson size={19} />}
            {k === 'drawing' ? 'Floor drawing' : k === 'footprint' ? 'GeoJSON' : k === 'plan' ? 'CAD plan' : 'Project'}
          </button>
        ))}
      </div>
      <button
        className="dropzone"
        onClick={() => input.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          setFile(e.dataTransfer.files[0] ?? null);
        }}
      >
        {file ? <Check size={30} /> : <UploadCloud size={32} />}
        <strong>{file?.name ?? 'Drop a file here, or browse'}</strong>
        <span>{kind === 'drawing' ? 'PNG, JPEG, WebP or PDF · up to 50 MB' : 'JSON or GeoJSON · up to 50 MB'}</span>
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept={kind === 'drawing' ? '.png,.jpg,.jpeg,.webp,.pdf' : '.json,.geojson'}
        onChange={e => setFile(e.target.files?.[0] ?? null)}
      />
      {kind === 'drawing' && (
        <p className="helper">
          Your drawing will be added to {project.floors.find(f => f.id === floorId)?.name ?? 'Outdoor site'}. Match two
          points to position it on the map, or calibrate a known distance.
        </p>
      )}
      {kind === 'plan' && (
        <>
          <label className="field">
            <span>Target floor</span>
            <select value={planFloor ?? ''} onChange={e => setPlanFloor(e.target.value || null)}>
              {project.floors.map(f => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
              <option value="">Outdoor site</option>
            </select>
          </label>
          <p className="helper">
            Walls, rooms, doors and windows will be built on the chosen floor — repeat per floor for a multi-storey
            building. Produce the JSON from a DWG with <code>scripts/plan-import/extract.mjs --expand --units m</code>.
          </p>
          <label className="field">
            <span>Site bearing</span>
            <input
              type="number"
              aria-label="Site bearing"
              step={0.1}
              min={-360}
              max={360}
              value={bearing}
              onChange={e => setBearing(e.target.value)}
            />
          </label>
          <p className="helper">
            A drawing is square to its sheet, not to the world, so an imported plan lands on the site's current heading.
            Degrees clockwise from north; adjustable afterwards under Site anchor.
          </p>
        </>
      )}
      {kind === 'drawing' && file?.name.toLowerCase().endsWith('.pdf') && (
        <label className="field">
          <span>PDF page</span>
          <input
            type="number"
            aria-label="PDF page"
            min={1}
            value={page}
            onChange={e => setPage(Number(e.target.value))}
          />
        </label>
      )}
      {kind === 'footprint' && (
        <div className="field-grid">
          <label className="field">
            <span>Source coordinates</span>
            <select value={crsIndex} onChange={e => setCrsIndex(Number(e.target.value))}>
              <option value={0}>WGS84 · longitude / latitude</option>
              {importProjections.map((p, i) => (
                <option key={p.label} value={i + 1}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Import as</span>
            <select value={type} onChange={e => setType(e.target.value as typeof type)}>
              <option value="building">Building footprint</option>
              <option value="parcel">Parcel boundary</option>
            </select>
          </label>
        </div>
      )}
      {kind === 'project' && (
        <p className="helper">Open a portable Kerros JSON export as a new project, including its reference images.</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={!file || busy} onClick={proceed}>
          {busy ? 'Preparing…' : kind === 'drawing' ? 'Align drawing' : 'Import'}
          <ArrowRight size={16} />
        </button>
      </footer>
    </Modal>
  );
}
export function AlignmentPanel({
  drawing,
  mapPoints,
  imagePoints,
  setImagePoints,
  onCancel,
  onPreview,
  onConfirm,
  onKnownDistance,
  preview,
}: {
  drawing: PreparedDrawing;
  mapPoints: Point[];
  imagePoints: Point[];
  setImagePoints: (points: Point[]) => void;
  onCancel: () => void;
  onPreview: () => void;
  onConfirm: () => void;
  onKnownDistance: (metres: number) => void;
  preview: boolean;
}) {
  const [url, setUrl] = useState(''),
    [metres, setMetres] = useState(10);
  useEffect(() => {
    let active = true;
    blobDataUrl(drawing.blob).then(data => {
      if (active) setUrl(data);
    });
    return () => {
      active = false;
    };
  }, [drawing.blob]);
  return (
    <aside className="alignment-panel">
      <div className="panel-heading">
        <span className="eyebrow">REFERENCE DRAWING</span>
        <h2>Align your drawing</h2>
        <p>
          {imagePoints.length < 2
            ? '1. Pick two recognizable points in this drawing.'
            : mapPoints.length < 2
              ? '2. Click the same points on the map, in the same order.'
              : preview
                ? '3. Check the overlay on the map, then confirm.'
                : '3. Preview the alignment before saving.'}
        </p>
      </div>
      <div
        className="alignment-image"
        onClick={e => {
          if (imagePoints.length >= 2 || preview) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setImagePoints([
            ...imagePoints,
            [
              ((e.clientX - rect.left) / rect.width) * drawing.width,
              ((e.clientY - rect.top) / rect.height) * drawing.height,
            ],
          ]);
        }}
      >
        {url && <img src={url} alt="Architectural drawing to align" />}
        {imagePoints.map((p, i) => (
          <b key={i} style={{ left: `${(p[0] / drawing.width) * 100}%`, top: `${(p[1] / drawing.height) * 100}%` }}>
            {i + 1}
          </b>
        ))}
      </div>
      <div className="alignment-progress">
        {[0, 1].map(i => (
          <span key={i} className={mapPoints[i] ? 'done' : ''}>
            {mapPoints[i] ? <Check size={14} /> : i + 1} Reference point {i + 1}
          </span>
        ))}
      </div>
      <button className="text-button" onClick={() => setImagePoints([])}>
        Reset reference points
      </button>
      <div className="known-distance">
        <strong>Have a dimension instead?</strong>
        <p>
          Select two image points and enter their real distance. Place and rotate the overlay using its properties
          afterward.
        </p>
        <label className="field">
          <span>Known distance (m)</span>
          <input type="number" min={0.01} value={metres} onChange={e => setMetres(Number(e.target.value))} />
        </label>
        <button
          className="button secondary"
          disabled={imagePoints.length !== 2 || metres <= 0}
          onClick={() => onKnownDistance(metres)}
        >
          Calibrate distance
        </button>
      </div>
      <div className="alignment-actions">
        <button className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={imagePoints.length !== 2 || mapPoints.length !== 2}
          onClick={preview ? onConfirm : onPreview}
        >
          {preview ? 'Confirm alignment' : 'Preview'}
        </button>
      </div>
    </aside>
  );
}
export const makeDrawing = (prepared: PreparedDrawing, floorId: string | null): Drawing => ({
  id: uid(),
  floorId,
  assetId: uid(),
  name: prepared.name,
  width: prepared.width,
  height: prepared.height,
  origin: [-29, 18],
  scale: 58 / prepared.width,
  rotation: 0,
  opacity: 0.65,
  visible: true,
  locked: false,
});
