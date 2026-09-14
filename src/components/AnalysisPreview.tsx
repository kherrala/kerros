import { useEffect, useState, useRef } from 'react';
import { Maximize2 } from 'lucide-react';
import { Modal } from './controls';
import { analysisPreviewSvg, type ImportAnalysisPreview } from '../import/analysisPreview';

const layers = [
  ['wall', 'Walls'],
  ['outline', 'Outlines'],
  ['label', 'Labels'],
  ['symbol', 'Symbols'],
  ['path', 'Source strokes'],
] as const;
export function AnalysisPreview({ preview }: { preview: ImportAnalysisPreview }) {
  const [expanded, setExpanded] = useState(true);
  const [hidden, setHidden] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [url, setUrl] = useState('');
  const [showSource, setShowSource] = useState(true);
  const [opacity, setOpacity] = useState(0.85);
  const [fullscreen, setFullscreen] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState<number>();
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => {
      const box = preview.svg
        .match(/viewBox="([^"]+)"/)?.[1]
        .split(/[ ,]+/)
        .map(Number);
      const aspect = box && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : 1;
      setFitWidth(
        fullscreen ? Math.min(el.clientWidth, Math.max(1, el.clientHeight - 16) * aspect + 16) : el.clientWidth,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [fullscreen, preview.svg]);
  const closeFullscreen = () => {
    setFullscreen(false);
    requestAnimationFrame(() => expandButton.current?.focus());
  };
  useEffect(() => {
    const svg = analysisPreviewSvg(preview, hidden, showSource, opacity);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview, hidden, showSource, opacity]);
  useEffect(() => {
    setZoom(1);
  }, [preview.artifactId]);
  const contents = (
    <>
      <p className="helper">
        Detected source geometry ·{' '}
        {preview.transformId
          ? `calibrated in metres (${preview.metresPerUnit!.toPrecision(4)} m/source unit)`
          : `uncalibrated ${preview.units === 'px' ? 'pixels' : preview.units === 'pt' ? 'PDF points' : 'metres'}`}
        . Accepted edits appear on the main map.
      </p>
      <div className="ai-analysis-layers" aria-label="Analysis layers">
        {layers
          .filter(([kind]) => preview.counts[kind])
          .map(([kind, label]) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={!hidden.includes(kind)}
                onChange={e =>
                  setHidden(previous => (e.target.checked ? previous.filter(k => k !== kind) : [...previous, kind]))
                }
              />
              {label} <small>{preview.counts[kind]}</small>
            </label>
          ))}
      </div>
      {preview.background && (
        <div className="ai-analysis-overlay-controls">
          <label>
            <input type="checkbox" checked={showSource} onChange={e => setShowSource(e.target.checked)} />
            Original drawing
          </label>
          <label>
            SVG opacity{' '}
            <input
              type="range"
              aria-label="SVG opacity"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={e => setOpacity(Number(e.target.value))}
            />
            <output>{Math.round(opacity * 100)}%</output>
          </label>
        </div>
      )}
      <div className="ai-analysis-toolbar">
        <label>
          Zoom{' '}
          <input
            type="range"
            aria-label="Analysis zoom"
            min="1"
            max="4"
            step="0.25"
            value={zoom}
            onChange={e => setZoom(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setZoom(1);
            canvas.current?.scrollTo(0, 0);
          }}
        >
          Fit
        </button>
        {!fullscreen && (
          <button
            ref={expandButton}
            type="button"
            className="icon-button"
            aria-label="Fullscreen SVG preview"
            title="Fullscreen SVG preview"
            onClick={() => setFullscreen(true)}
          >
            <Maximize2 size={16} />
          </button>
        )}
        {url && (
          <a href={url} download={`source-page-${preview.page}.svg`}>
            Save SVG
          </a>
        )}
      </div>
      <div ref={canvas} className="ai-analysis-canvas" tabIndex={0} aria-label="Source vector preview">
        {url && (
          <img
            src={url}
            alt={`Source analysis SVG, page ${preview.page}`}
            style={{ width: fitWidth ? fitWidth * zoom : `${zoom * 100}%` }}
          />
        )}
      </div>
      <p className="helper">
        Blue: walls · amber: outlines · purple: symbols · red: latest selection. {preview.shown} of {preview.total}{' '}
        candidates shown{preview.shown < preview.total ? '; preview capped for large sheets' : ''}.
      </p>
      {preview.calibration && <p className="helper">{preview.calibration}</p>}
      {!!preview.warnings.length && (
        <details>
          <summary>Detection uncertainties ({preview.warnings.length})</summary>
          <ul>
            {preview.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
  return (
    <>
      <details
        className="ai-analysis-preview"
        open={expanded}
        hidden={fullscreen}
        onToggle={e => setExpanded(e.currentTarget.open)}
      >
        <summary>Source analysis · SVG · page {preview.page}</summary>
        {!fullscreen && contents}
      </details>
      {fullscreen && (
        <Modal fullscreen title={`Source analysis · page ${preview.page}`} onClose={closeFullscreen}>
          <div className="ai-analysis-fullscreen">{contents}</div>
        </Modal>
      )}
    </>
  );
}
