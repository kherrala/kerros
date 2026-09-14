import { useEffect, useRef, useState, useId } from 'react';
import type { AiImportAdapter } from '../model/host';
import type { AssetRepository, ProjectDocument } from '../model/types';
import { addTokenUsage, emptyTokenUsage } from '../import/usage';
import { loadAiImportSession, saveAiImportSession, type AiImportSession } from '../import/session';
import { readImportBrief } from '../import/brief';
import { DEFAULT_IMPORT_BUDGET, readImportBudget, type ImportBudget } from '../import/checkpoint';
import { mergeImportInstructions, readImportInstruction } from '../import/instructions';
import { AnalysisPreview } from './AnalysisPreview';
import {
  loadAnalysisPreview,
  saveAnalysisPreview,
  deleteAnalysisPreview,
  type ImportAnalysisPreview,
} from '../import/analysisPreview';

export function AiImportPanel({
  adapter,
  assets,
  onProject,
  onRunningChange,
  currentProject,
}: {
  adapter: AiImportAdapter;
  assets: AssetRepository;
  onProject: (project: ProjectDocument) => void | Promise<void>;
  onRunningChange: (running: boolean) => void;
  currentProject: ProjectDocument;
}) {
  const [loading, setLoading] = useState(true);
  type ImportTab = 'setup' | 'analysis' | 'activity' | 'usage';
  const [tab, setTab] = useState<ImportTab>('setup');
  const tabId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [instructions, setInstructions] = useState('');
  const [widthMetres, setWidthMetres] = useState('');
  const [depthMetres, setDepthMetres] = useState('');
  const [buildingType, setBuildingType] = useState('');
  const [floorCount, setFloorCount] = useState('');
  const [footprintArea, setFootprintArea] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [budget, setBudget] = useState<ImportBudget>(DEFAULT_IMPORT_BUDGET);
  const [analysisPreview, setAnalysisPreview] = useState<ImportAnalysisPreview>();
  const [session, setSession] = useState<AiImportSession | null>(null);
  const latest = useRef(session);
  const projectRef = useRef(currentProject);
  const acceptProject = useRef(onProject);
  projectRef.current = currentProject;
  acceptProject.current = onProject;
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeJob, setActiveJob] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const chat = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const running = session?.phase === 'running';
  const phase = session?.phase ?? 'ready';
  const messages = session?.messages ?? [];
  const usage = session?.usage ?? emptyTokenUsage();
  const hasUsage = session?.hasUsage ?? false;
  const edits = session?.edits ?? 0;
  const activity = session?.activity ?? '';

  // Capture each state before yielding. Ordered writes prevent slow saves from restoring an
  // older transcript or phase over a newer one. Geometry is persisted by onProject first.
  const persist = (next: AiImportSession) => {
    latest.current = next;
    setSession(next);
    const write = queue.current.catch(() => {}).then(() => saveAiImportSession(assets, next));
    queue.current = write;
    return write;
  };
  useEffect(() => {
    let active = true;
    void loadAiImportSession(assets, currentProject.id)
      .then(async saved => {
        if (!active) return;
        latest.current = saved;
        setSession(saved);
        setInstructions(saved?.instructions ?? '');
        setFollowUp(saved?.followUp ?? '');
        setWidthMetres(saved?.brief?.widthMetres?.toString() ?? '');
        setDepthMetres(saved?.brief?.depthMetres?.toString() ?? '');
        setBuildingType(saved?.brief?.buildingType ?? '');
        setFloorCount(saved?.brief?.floorCount?.toString() ?? '');
        setFootprintArea(saved?.brief?.footprintAreaM2?.toString() ?? '');
        setError(saved?.error ?? '');
        setBudget(saved?.budget ?? DEFAULT_IMPORT_BUDGET);
        setTab(saved?.tab ?? (saved ? 'activity' : 'setup'));
        if (saved) {
          const preview = await loadAnalysisPreview(assets, saved.sourceId);
          if (active) setAnalysisPreview(preview);
        }
      })
      .catch(e => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.current?.abort();
      controller.current = null;
    };
  }, [assets, currentProject.id]);
  useEffect(() => {
    if (follow.current && chat.current) chat.current.scrollTop = 0;
  }, [session?.messages]);
  useEffect(() => {
    onRunningChange(running);
    return () => onRunningChange(false);
  }, [running, onRunningChange]);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const start = async (continuing = false) => {
    if (controller.current || loading) return;
    const request = new AbortController();
    controller.current = request;
    setSaving(true);
    setError('');
    let previousUsage = emptyTokenUsage();
    try {
      const previous = latest.current;
      const runBudget = readImportBudget(budget);
      const brief = readImportBrief({
        buildingType: buildingType || undefined,
        floorCount: floorCount ? Number(floorCount) : undefined,
        widthMetres: widthMetres ? Number(widthMetres) : undefined,
        depthMetres: depthMetres ? Number(depthMetres) : undefined,
        footprintAreaM2: footprintArea ? Number(footprintArea) : undefined,
      });
      let selected = file;
      if (continuing && previous) {
        const blob = await assets.get(previous.sourceId);
        if (!blob) throw new Error('The saved source drawing is missing. Choose it again to continue.');
        selected = new File([blob], previous.sourceName, { type: previous.sourceType });
      }
      if (
        !selected ||
        !/\.(dwg|pdf|png|jpe?g|webp)$/i.test(selected.name) ||
        !selected.size ||
        selected.size > 25 * 1024 * 1024
      )
        throw new Error('Choose a non-empty DWG, PDF, PNG, JPEG or WebP file under 25 MB.');
      const sourceId = continuing && previous ? previous.sourceId : `ai-import:source:${crypto.randomUUID()}`;
      if (!continuing) await assets.put(sourceId, selected);
      if (!continuing) setAnalysisPreview(undefined);
      request.signal.throwIfAborted();
      const next: AiImportSession =
        continuing && previous
          ? {
              ...previous,
              brief,
              phase: 'running',
              tab: 'activity',
              budget: runBudget,
              pause: undefined,
              error: '',
              followUp: '',
              activity: 'Preparing import',
              messages: previous.messages,
            }
          : {
              version: 1,
              projectId: projectRef.current.id,
              sourceId,
              sourceName: selected.name,
              sourceType: selected.type,
              instructions,
              brief,
              followUp: '',
              messages: [
                {
                  type: 'user',
                  detail: [
                    instructions.trim(),
                    [
                      brief?.buildingType,
                      brief?.floorCount && `${brief.floorCount} floors`,
                      brief?.widthMetres && `Width ${brief.widthMetres} m`,
                      brief?.depthMetres && `Depth ${brief.depthMetres} m`,
                      brief?.footprintAreaM2 && `Footprint ${brief.footprintAreaM2} m² per floor`,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  ]
                    .filter(Boolean)
                    .join('\n'),
                },
              ].filter(m => m.detail) as AiImportSession['messages'],
              phase: 'running',
              tab: 'activity',
              budget: runBudget,
              pause: undefined,
              activity: 'Preparing import',
              edits: 0,
              usage: emptyTokenUsage(),
              hasUsage: false,
              error: '',
            };
      if (continuing) {
        if (followUp.trim()) {
          const instruction = readImportInstruction({ id: crypto.randomUUID(), text: followUp });
          next.pendingInstructions = [...(next.pendingInstructions ?? []), instruction];
          next.messages = [...next.messages, { type: 'user', detail: instruction.text, instructionId: instruction.id }];
        }
        if (next.pendingInstructions?.length)
          next.checkpoint = {
            version: 1,
            projectId: projectRef.current.id,
            brief: next.brief,
            phase: 'inspect',
            notes: '',
            sourcePlan: '',
            mutationKinds: [],
            analysis: [],
            lastAssistantText: '',
            lastToolReport: '',
            ...next.checkpoint,
            steering: mergeImportInstructions(next.checkpoint?.steering ?? [], next.pendingInstructions),
          };
      }
      previousUsage = continuing && previous ? previous.usage : emptyTokenUsage();
      await persist(next);
      setFollowUp('');
      if (!continuing && previous && previous.sourceId !== sourceId)
        await Promise.all([assets.delete(previous.sourceId), deleteAnalysisPreview(assets, previous.sourceId)]).catch(
          () => {},
        );
      request.signal.throwIfAborted();
      setTab('activity');
      setFile(null);
      setSaving(false);
      follow.current = true;
      let lastDocument: ProjectDocument | undefined;
      const result = await adapter.run(selected, {
        origin: projectRef.current.origin,
        brief: next.brief,
        instructions: next.instructions,
        // The live document includes manual corrections made between runs. Never restore an
        // earlier import snapshot over them or switch to a newly generated project ID.
        base: projectRef.current,
        checkpoint: next.checkpoint,
        budget: runBudget,
        onSession: jobId => {
          if (!request.signal.aborted) setActiveJob(jobId);
        },
        onAnalysis: async preview => {
          if (request.signal.aborted) return;
          await saveAnalysisPreview(assets, sourceId, preview);
          if (!request.signal.aborted) setAnalysisPreview(preview);
        },
        onCheckpoint: async checkpoint => {
          if (!request.signal.aborted) {
            const acknowledged = new Set(checkpoint.steering?.map(m => m.id));
            await persist({
              ...latest.current!,
              checkpoint,
              pendingInstructions: latest.current!.pendingInstructions?.filter(m => !acknowledged.has(m.id)),
            });
          }
        },
        onPause: async pause => {
          if (!request.signal.aborted) await persist({ ...latest.current!, pause, activity: pause.message });
        },
        signal: request.signal,
        onUsage: async snapshot => {
          if (!request.signal.aborted)
            await persist({ ...latest.current!, usage: addTokenUsage(previousUsage, snapshot), hasUsage: true });
        },
        onDocument: async document => {
          if (request.signal.aborted) return;
          await acceptProject.current(document);
          lastDocument = document;
          await persist({ ...latest.current!, edits: latest.current!.edits + 1 });
        },
        onProgress: async event => {
          if (request.signal.aborted) return;
          const state = latest.current!;
          if (event.type === 'status') return persist({ ...state, activity: event.detail });
          const last = state.messages.at(-1);
          const messages: AiImportSession['messages'] =
            event.type === 'text' && last?.type === 'text'
              ? [...state.messages.slice(0, -1), { type: 'text', detail: last.detail + event.detail }]
              : [...state.messages, { type: event.type, detail: event.detail }];
          await persist({ ...state, messages });
        },
      });
      if (!request.signal.aborted) {
        if (!lastDocument || JSON.stringify(result) !== JSON.stringify(lastDocument))
          await acceptProject.current(result);
        await persist({ ...latest.current!, phase: latest.current!.pause ? 'paused' : 'done' });
      }
    } catch (e) {
      if (controller.current !== request) return;
      const message = request.signal.aborted ? '' : (e as Error).message;
      setError(message);
      if (latest.current) {
        try {
          await persist({ ...latest.current, phase: request.signal.aborted ? 'paused' : 'failed', error: message });
        } catch {
          setError('Could not save the import session. Keep this page open and retry when storage is available.');
        }
      }
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setActiveJob(undefined);
      }
      setSaving(false);
    }
  };
  const sendInstruction = async () => {
    if (!followUp.trim() || sending || saving || !latest.current) return;
    if (!running) return start(true);
    if (!activeJob || !adapter.sendInstruction) return;
    setSending(true);
    setError('');
    try {
      const instruction = readImportInstruction({ id: crypto.randomUUID(), text: followUp });
      const pending = [...(latest.current.pendingInstructions ?? []), instruction];
      if (pending.length > 20 || JSON.stringify(pending).length > 8000)
        throw new Error('Wait for Claude to receive the queued instructions before sending more.');
      await persist({
        ...latest.current,
        followUp: '',
        pendingInstructions: pending,
        messages: [
          ...latest.current.messages,
          { type: 'user', detail: instruction.text, instructionId: instruction.id },
        ],
      });
      setFollowUp('');
      await adapter.sendInstruction(activeJob, instruction);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const changeBrief = (
    patch: Partial<{
      widthMetres: string;
      depthMetres: string;
      footprintArea: string;
      buildingType: string;
      floorCount: string;
    }>,
  ) => {
    const next = { widthMetres, depthMetres, footprintArea, buildingType, floorCount, ...patch };
    setWidthMetres(next.widthMetres);
    setDepthMetres(next.depthMetres);
    setFootprintArea(next.footprintArea);
    setBuildingType(next.buildingType);
    setFloorCount(next.floorCount);
    if (!latest.current) return;
    try {
      const brief = readImportBrief({
        buildingType: next.buildingType || undefined,
        floorCount: next.floorCount ? Number(next.floorCount) : undefined,
        widthMetres: next.widthMetres ? Number(next.widthMetres) : undefined,
        depthMetres: next.depthMetres ? Number(next.depthMetres) : undefined,
        footprintAreaM2: next.footprintArea ? Number(next.footprintArea) : undefined,
      });
      void persist({ ...latest.current, brief }).catch(() => setError('Could not save the import template.'));
    } catch {
      /* Keep partial input editable; Start/Continue validates it. */
    }
  };
  const scaleFields = (
    <fieldset className="ai-import-scale">
      <legend>Import template · optional</legend>
      <div className="field-grid">
        <label className="field">
          <span>Building type</span>
          <select
            aria-label="Import building type"
            value={buildingType}
            disabled={saving || running}
            onChange={e => changeBrief({ buildingType: e.target.value })}
          >
            <option value="">Use the drawing</option>
            <option value="apartment">Apartment</option>
            <option value="house">Detached house</option>
            <option value="office">Office</option>
            <option value="retail">Shop / retail</option>
            <option value="other">Other building</option>
          </select>
        </label>
        <label className="field">
          <span>Floor count</span>
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            aria-label="Import floor count"
            value={floorCount}
            placeholder="e.g. 1"
            disabled={saving || running}
            onChange={e => changeBrief({ floorCount: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Overall width (m)</span>
          <input
            type="number"
            min="0.01"
            step="any"
            aria-label="Overall width (m)"
            value={widthMetres}
            placeholder="e.g. 20"
            disabled={saving || running}
            onChange={e => changeBrief({ widthMetres: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Overall depth (m)</span>
          <input
            type="number"
            min="0.01"
            step="any"
            aria-label="Overall depth (m)"
            value={depthMetres}
            placeholder="Optional"
            disabled={saving || running}
            onChange={e => changeBrief({ depthMetres: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Footprint per floor (m²)</span>
          <input
            type="number"
            min="0.01"
            step="any"
            aria-label="Floor footprint (m²)"
            value={footprintArea}
            placeholder="Whole floor area"
            disabled={saving || running}
            onChange={e => changeBrief({ footprintArea: e.target.value })}
          />
        </label>
      </div>
      <small>
        Dimensions follow the plan’s main axes, to the outside of the walls. Footprint includes wall area and applies
        per floor, not to the sum of all floors. One known value can establish scale; others cross-check it. Leave
        measurements blank only when the drawing has readable dimensions. Different floor footprints can be described in
        the instructions.
      </small>
    </fieldset>
  );
  const budgetFields = (
    <details className="ai-import-budget">
      <summary>
        Budget per run · {budget.maxTurns ?? 40} turns · {budget.inputTokens.toLocaleString()} input /{' '}
        {budget.outputTokens.toLocaleString()} output
      </summary>
      <p className="helper">
        Input includes cached tokens. Output includes model thinking. Continue starts another paid run using the saved
        working state. Limits are checked between responses.
      </p>
      <div className="field-grid">
        <label className="field">
          <span>Turn limit</span>
          <input
            type="number"
            aria-label="Turn limit"
            min="1"
            max="100"
            step="1"
            value={budget.maxTurns ?? 40}
            disabled={running || saving}
            onChange={e => {
              const next = { ...budget, maxTurns: Number(e.target.value) };
              setBudget(next);
              try {
                const valid = readImportBudget(next);
                if (latest.current)
                  void persist({ ...latest.current, budget: valid }).catch(() =>
                    setError('Could not save import budget.'),
                  );
              } catch {
                /* Start validates completed values. */
              }
            }}
          />
        </label>
        {(['inputTokens', 'outputTokens'] as const).map(key => (
          <label className="field" key={key}>
            <span>{key === 'inputTokens' ? 'Input token limit' : 'Output token limit'}</span>
            <input
              type="number"
              aria-label={key === 'inputTokens' ? 'Input token limit' : 'Output token limit'}
              min={key === 'inputTokens' ? 10000 : 1000}
              max={key === 'inputTokens' ? 2000000 : 100000}
              step="1000"
              value={budget[key]}
              disabled={running || saving}
              onChange={e => {
                const next = { ...budget, [key]: Number(e.target.value) };
                setBudget(next);
                try {
                  const valid = readImportBudget(next);
                  if (latest.current)
                    void persist({ ...latest.current, budget: valid }).catch(() =>
                      setError('Could not save import budget.'),
                    );
                } catch {
                  /* Start validates completed values. */
                }
              }}
            />
          </label>
        ))}
      </div>
    </details>
  );
  const tabs = [
    ['setup', 'Setup'],
    ['analysis', 'Analysis'],
    ['activity', 'Activity'],
    ['usage', 'Usage'],
  ] as const;
  const chooseTab = (next: ImportTab) => {
    setTab(next);
    if (latest.current)
      void persist({ ...latest.current, tab: next }).catch(() => setError('Could not save the import view.'));
  };
  if (loading) return <p role="status">Restoring import session…</p>;
  const newSource = !!file || !session;
  return (
    <section className="ai-import-panel ai-import-organized">
      <header className="ai-import-sticky">
        <strong className="ai-import-source" title={file?.name ?? session?.sourceName}>
          {file?.name ?? session?.sourceName ?? 'Choose a source drawing'}
        </strong>
        <div className="ai-import-toolbar">
          <span role="status">
            {running
              ? `Importing · ${edits} accepted edits · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
              : phase === 'done'
                ? `Saved to project · ${edits} accepted edits`
                : phase === 'paused'
                  ? 'Paused · accepted changes saved'
                  : phase === 'failed'
                    ? 'Import interrupted'
                    : 'Ready to import'}
          </span>
          {running ? (
            <button className="button secondary" onClick={() => controller.current?.abort()}>
              Stop import
            </button>
          ) : (
            <button
              className="button primary"
              disabled={saving || (newSource && !file)}
              onClick={() => start(!newSource)}
            >
              {saving ? 'Preparing…' : newSource ? 'Start AI import' : 'Continue import'}
            </button>
          )}
        </div>
        {running && <p className="ai-import-activity">{activity || 'Claude is working…'}</p>}
        {!running && session?.pause && (
          <p className="ai-import-pause" aria-live="polite">
            {session.pause.message}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </header>
      <div className="ai-import-tablist" role="tablist" aria-label="AI import sections">
        {tabs.map(([key, label], index) => (
          <button
            key={key}
            id={`${tabId}-${key}`}
            data-tab={key}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`${tabId}-${key}-panel`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => chooseTab(key)}
            onKeyDown={e => {
              const next =
                e.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : e.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? tabs.length - 1
                        : -1;
              if (next < 0) return;
              e.preventDefault();
              chooseTab(tabs[next][0]);
              (
                e.currentTarget.parentElement?.querySelector(`[data-tab="${tabs[next][0]}"]`) as HTMLButtonElement
              )?.focus();
            }}
          >
            {label}
            {key === 'analysis' && analysisPreview && <i aria-hidden="true" title="Preview available" />}
          </button>
        ))}
      </div>
      <div
        className="ai-import-tab-scroll"
        role="tabpanel"
        id={`${tabId}-setup-panel`}
        aria-labelledby={`${tabId}-setup`}
        hidden={tab !== 'setup'}
      >
        <p className="helper">
          Claude edits the live project and saves accepted changes. Starting or continuing uses your backend API key and
          incurs API usage.
        </p>
        <div className="ai-import-inputs">
          <label className="field">
            <span>{session ? 'Replace source drawing' : 'Source drawing'}</span>
            <input
              type="file"
              aria-label="AI source drawing"
              accept=".dwg,.pdf,.png,.jpg,.jpeg,.webp"
              disabled={running || saving}
              onChange={e => {
                setFile(e.target.files?.[0] ?? null);
                e.currentTarget.value = '';
              }}
            />
            <small>Images, PDF (up to 20 pages), or DWG · up to 25 MB</small>
          </label>
          {file && session && (
            <button className="text-button" onClick={() => setFile(null)}>
              Keep current source
            </button>
          )}
          <label className="field">
            <span>Import instructions</span>
            <textarea
              aria-label="Import instructions"
              maxLength={8000}
              rows={3}
              disabled={running || saving}
              value={instructions}
              onChange={e => {
                setInstructions(e.target.value);
                if (latest.current)
                  void persist({ ...latest.current, instructions: e.target.value }).catch(() =>
                    setError('Could not save instructions.'),
                  );
              }}
              placeholder="For example: page 2 is the ground floor, exterior width 18.4 m. Include room names and openings."
            />
          </label>
        </div>
        {scaleFields}
        {budgetFields}
        <p className="helper">
          Stop before making manual edits. Continue uses the current project and saved working notes. Closing this
          sidebar keeps an active import running.
        </p>
      </div>
      <div
        className="ai-import-tab-scroll"
        role="tabpanel"
        id={`${tabId}-analysis-panel`}
        aria-labelledby={`${tabId}-analysis`}
        hidden={tab !== 'analysis'}
      >
        {analysisPreview ? (
          <AnalysisPreview preview={analysisPreview} />
        ) : (
          <p className="ai-import-empty">
            The source SVG will appear here when Claude analyses the drawing. It shows detected evidence; accepted
            geometry appears on the main map.
          </p>
        )}
      </div>
      <div
        className="ai-import-activity-panel"
        role="tabpanel"
        id={`${tabId}-activity-panel`}
        aria-labelledby={`${tabId}-activity`}
        hidden={tab !== 'activity'}
      >
        <div
          className="ai-import-tab-scroll"
          ref={chat}
          onScroll={e => {
            follow.current = e.currentTarget.scrollTop < 60;
          }}
        >
          <section className="ai-import-conversation" aria-label="AI conversation">
            {!messages.length && (
              <p className="ai-import-empty">Claude’s latest message and tool activity will appear at the top.</p>
            )}
            {[...messages].reverse().map((message, i) => (
              <div key={messages.length - 1 - i} className={`ai-import-message ${message.type}`}>
                <small>
                  {message.type === 'text'
                    ? 'Claude'
                    : message.type === 'user'
                      ? session?.pendingInstructions?.some(m => m.id === message.instructionId)
                        ? 'You · queued'
                        : 'You'
                      : 'Tool'}
                </small>
                <p>{message.detail}</p>
              </div>
            ))}
          </section>
        </div>
        <form
          className="ai-import-composer"
          onSubmit={e => {
            e.preventDefault();
            void sendInstruction();
          }}
        >
          <label className="field">
            <span>Message to AI</span>
            <textarea
              aria-label="Message to AI"
              rows={3}
              maxLength={2000}
              value={followUp}
              disabled={!session || saving || sending || !!file}
              onChange={e => {
                setFollowUp(e.target.value);
                if (latest.current)
                  void persist({ ...latest.current, followUp: e.target.value }).catch(() =>
                    setError('Could not save your draft.'),
                  );
              }}
              placeholder="Give a correction or describe what to do next…"
            />
          </label>
          <div>
            <small>
              {running
                ? 'Queued for Claude’s next turn.'
                : session
                  ? 'Resumes with the saved project. Uses API tokens.'
                  : 'Start an import in Setup to chat.'}
            </small>
            <button
              className="button primary"
              type="submit"
              disabled={
                !session ||
                !followUp.trim() ||
                saving ||
                sending ||
                !!file ||
                (running && (!activeJob || !adapter.sendInstruction))
              }
            >
              {sending ? 'Sending…' : running ? 'Send' : 'Send & continue'}
            </button>
          </div>
        </form>
      </div>
      <div
        className="ai-import-tab-scroll"
        role="tabpanel"
        id={`${tabId}-usage-panel`}
        aria-labelledby={`${tabId}-usage`}
        hidden={tab !== 'usage'}
      >
        <section className="ai-import-usage" aria-label="Token usage">
          <strong>
            Tokens reported ·{' '}
            {Object.values(usage)
              .reduce((sum, n) => sum + n, 0)
              .toLocaleString()}
          </strong>
          <dl>
            {(
              [
                ['Input', usage.inputTokens],
                ['Output', usage.outputTokens],
                ['Cache read', usage.cacheReadTokens],
                ['Cache write', usage.cacheWriteTokens],
              ] as const
            ).map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{count.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          <small>
            {!hasUsage
              ? 'Waiting for Claude to report usage.'
              : 'Includes continuations in this session. Saved with this project; interrupted runs may report incomplete usage.'}
          </small>
        </section>
        <p className="helper">
          Per run: {budget.maxTurns ?? 40} turns, {budget.inputTokens.toLocaleString()} input (including cache),{' '}
          {budget.outputTokens.toLocaleString()} output tokens. Adjust limits in Setup. Reaching a limit pauses the
          import; Continue starts the next paid run from the saved checkpoint.
        </p>
      </div>
    </section>
  );
}
