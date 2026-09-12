import { useEffect, useRef, useState } from 'react';
import { FileImage, FileJson, UploadCloud, ArrowRight, Check } from 'lucide-react';
import type { AssetRepository, Drawing, Point, ProjectDocument } from '../model/types';
import type { ImportProjection } from '../model/host';
import { uid } from '../model/types';
import { blobDataUrl, importProject } from '../adapters/persistence';
import { importFootprints } from '../model/imports';
import type { PlanEntity } from '../import/planImport';
import type { PlanLayerMap } from '../import/types';
import { detectLayers, layerPattern, LAYER_ROLES, type LayerDetection, type LayerRole } from '../import/detect';
import { Modal } from './controls';

export interface PreparedDrawing {
  blob: Blob;
  name: string;
  width: number;
  height: number;
}
const ROLE_LABELS: Record<LayerRole, string> = {
  exteriorFace: 'Outer wall face',
  interiorFace: 'Inner wall face',
  partitionFaces: 'Partition faces',
  doors: 'Doors',
  windows: 'Windows',
  labels: 'Room labels',
  stairs: '',
};
/** What a layer looks like, for the line under a role's name. */
const described = (detection: LayerDetection, layer: string) => {
  const r = detection.layers.find(x => x.layer === layer);
  if (!r) return layer;
  return `${r.entities} entities · ${Object.keys(r.types).join(' ')}${r.width > 0 ? ` · ${r.width.toFixed(1)}×${r.height.toFixed(1)} m` : ''}`;
};
const PROFILES_KEY = 'kerros:layer-profiles';
type Profiles = Record<string, Partial<Record<LayerRole, string>>>;
const readProfiles = (): Profiles => {
  try {
    return JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') as Profiles;
  } catch {
    return {}; // storage blocked or corrupt — an unsaved mapping still imports fine
  }
};

/** The layer census, with the role each layer was read as and a way to correct it.
 *
 *  Detection is good at doors, windows, labels and partitions and can be wrong about which pair of
 *  lines is the wall — and on a drawing that has no separate face layers at all it finds no pair and
 *  says so. Either way the drawing is right here to be looked at, so the fix is a dropdown rather
 *  than a failed import and a puzzled reread of the manual. */
function LayerPicker({
  detection,
  roles,
  onRole,
}: {
  detection: LayerDetection;
  roles: Partial<Record<LayerRole, string>>;
  onRole: (role: LayerRole, layer: string | null) => void;
}) {
  const [open, setOpen] = useState(detection.missing.length > 0);
  const [profiles, setProfiles] = useState<Profiles>(readProfiles);
  const [profileName, setProfileName] = useState('');
  const save = () => {
    const name = profileName.trim();
    if (!name) return;
    const next = { ...profiles, [name]: roles };
    setProfiles(next);
    try {
      localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    } catch {
      /* nothing to do: the mapping still applies to this import */
    }
    setProfileName('');
  };
  const apply = (name: string) => {
    for (const role of LAYER_ROLES) onRole(role, profiles[name]?.[role] ?? null);
  };
  const missing = LAYER_ROLES.filter(r => !roles[r]);
  return (
    <section className="layer-picker">
      <button className="layer-picker-head" onClick={() => setOpen(!open)}>
        <span>
          <strong>{detection.layers.length} layers</strong>
          {missing.length ? (
            <small className="warn">{missing.map(r => ROLE_LABELS[r]).join(', ')} not found</small>
          ) : (
            <small>every role matched a layer</small>
          )}
        </span>
        <ArrowRight size={15} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
      </button>
      {open && (
        <>
          <p className="helper">
            Read from the geometry, not the layer names — a door swing is an arc whatever the layer is called. Correct
            anything it got wrong. One layer may hold both wall faces, which is how some offices draw them; pick it for
            both.
          </p>
          <div className="layer-rows">
            {LAYER_ROLES.map(role => (
              <div className={`layer-row ${roles[role] ? 'assigned' : 'unset'}`} key={role}>
                <span className="layer-name">
                  {ROLE_LABELS[role]}
                  <small>{roles[role] ? described(detection, roles[role]!) : 'not found'}</small>
                </span>
                <select
                  aria-label={ROLE_LABELS[role]}
                  value={roles[role] ?? ''}
                  onChange={e => onRole(role, e.target.value || null)}
                >
                  <option value="">—</option>
                  {detection.layers.map(r => (
                    <option key={r.layer} value={r.layer}>
                      {r.layer}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="layer-profiles">
            <input
              aria-label="Profile name"
              placeholder="Save as… (e.g. the office's name)"
              value={profileName}
              onChange={e => setProfileName(e.target.value)}
            />
            <button className="button secondary small" onClick={save} disabled={!profileName.trim()}>
              Save
            </button>
            {Object.keys(profiles).map(name => (
              <button className="button secondary small" key={name} onClick={() => apply(name)}>
                {name}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
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
  onPlan?: (entities: PlanEntity[], floorId: string | null, layers?: PlanLayerMap) => void;
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
  // The layer census, read as soon as a CAD file is chosen — the roles are what the import turns on,
  // so they have to be reviewable before it runs, not explained afterwards by a bad result.
  const [detection, setDetection] = useState<LayerDetection | null>(null);
  const [roles, setRoles] = useState<Partial<Record<LayerRole, string>>>({});
  useEffect(() => {
    if (kind !== 'plan' || !file) return setDetection(null);
    let live = true;
    void (async () => {
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const list = Array.isArray(parsed) ? parsed : ((parsed as { entities?: PlanEntity[] }).entities ?? []);
        if (!live || !Array.isArray(list)) return;
        const found = detectLayers(list as PlanEntity[]);
        setDetection(found);
        setRoles(
          Object.fromEntries(found.layers.filter(r => r.role).map(r => [r.role!, r.layer])) as Partial<
            Record<LayerRole, string>
          >,
        );
      } catch {
        if (live) setDetection(null); // not plan-entity JSON; proceed() will say so properly
      }
    })();
    return () => {
      live = false;
    };
  }, [file, kind]);
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
        const named = Object.entries(roles).filter(([, layer]) => layer);
        const layers = named.length
          ? ({
              ...detection?.suggested,
              ...Object.fromEntries(named.map(([role, layer]) => [role, layerPattern(layer!)])),
            } as PlanLayerMap)
          : detection?.suggested;
        onPlan?.(entities as PlanEntity[], planFloor, layers);
      } else if (kind === 'footprint')
        onFootprints(
          importFootprints(JSON.parse(await file.text()), project, type, importProjections[crsIndex - 1]?.toLngLat),
        );
      else {
        let blob: Blob = file;
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('../import/pdfWorker')]);
          pdfjs.GlobalWorkerOptions.workerSrc = worker.pdfWorkerUrl();
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
          {detection && (
            <LayerPicker
              detection={detection}
              roles={roles}
              onRole={(role, layer) =>
                setRoles(current => {
                  const next = { ...current };
                  if (layer) next[role] = layer;
                  else delete next[role];
                  return next;
                })
              }
            />
          )}
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
