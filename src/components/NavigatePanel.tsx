import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  DoorOpen,
  Flag,
  Footprints,
  MapPin,
  MoveUpRight,
  Pause,
  Play,
  Search,
  Waypoints,
  X,
} from 'lucide-react';
import type { ProjectDocument, SiteObject } from '../model/types';
import type { Route, RouteStep } from '../model/navigation';
import { floorPhrase } from '../model/navigation';
import { EntityIcon } from './Icons';
import { useStrings } from '../theme';

/** Object kinds offered as route endpoints — everything routeAnchors can resolve meaningfully. */
const NAV_KINDS = ['room', 'zone', 'door', 'gate', 'poi', 'elevator', 'stairs', 'turnstile'];
const STEP_ICONS: Record<RouteStep['kind'], typeof MapPin> = {
  depart: MapPin,
  walk: Footprints,
  door: DoorOpen,
  stairs: MoveUpRight,
  elevator: ArrowUpRight,
  arrive: Flag,
};

interface Props {
  project: ProjectDocument;
  from: string | null;
  to: string | null;
  route: Route | null;
  playing: boolean;
  activeStep: number | null;
  editing: boolean;
  onFrom: (id: string | null) => void;
  onTo: (id: string | null) => void;
  onSwap: () => void;
  onClear: () => void;
  onPlay: () => void;
  onPause: () => void;
  onStep: (delta: 1 | -1) => void;
  onSeek: (index: number) => void;
  onClose: () => void;
}
export function NavigatePanel({
  project,
  from,
  to,
  route,
  playing,
  activeStep,
  editing,
  onFrom,
  onTo,
  onSwap,
  onClear,
  onPlay,
  onPause,
  onStep,
  onSeek,
  onClose,
}: Props) {
  const en = useStrings();
  const t = en.navigate;
  const options = project.objects.filter(o => NAV_KINDS.includes(o.kind));
  const groups = [
    { id: null as string | null, items: options.filter(o => o.floorId === null) },
    ...project.floors.map(f => ({ id: f.id as string | null, items: options.filter(o => o.floorId === f.id) })),
  ]
    .filter(g => g.items.length)
    .map(g => ({ ...g, items: [...g.items].sort((a, b) => a.name.localeCompare(b.name)) }));
  const hasGraph = (project.navNodes?.length ?? 0) > 0;
  const floorsCrossed = route ? new Set(route.steps.map(s => s.floorId)).size : 0;
  // Hundreds of places in the bigger demos: the pickers are searchable comboboxes, not selects.
  const places = useMemo(
    () =>
      groups.flatMap(g =>
        g.items.map((o: SiteObject) => ({ o, floor: g.id === null ? en.outdoors : floorPhrase(project, g.id) })),
      ),
    [groups, project],
  );
  const picker = (label: string, value: string | null, other: string | null, set: (id: string | null) => void) => (
    <PlacePicker label={label} places={places} value={value} other={other} onPick={set} placeholder={t.choose} />
  );
  return (
    <aside className="inspector navigate-panel">
      <div className="inspector-top">
        <span>{t.title}</span>
        <button className="icon-button" aria-label="Close navigation" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="inspector-scroll">
        <div className="nav-endpoints">
          <div className="nav-endpoint-fields">
            {picker(t.from, from, to, onFrom)}
            {picker(t.to, to, from, onTo)}
          </div>
          <div className="nav-endpoint-actions">
            <button className="icon-button" aria-label={t.swap} title={t.swap} disabled={!from && !to} onClick={onSwap}>
              <ArrowUpDown size={16} />
            </button>
            {(from || to) && (
              <button className="text-button" onClick={onClear}>
                {t.clear}
              </button>
            )}
          </div>
        </div>
        {!hasGraph ? (
          <div className="nav-empty">
            <Waypoints size={22} />
            <strong>{t.noGraph}</strong>
            <p>{editing ? t.noGraphHintEdit : t.noGraphHintView}</p>
          </div>
        ) : from && to && !route ? (
          <div className="nav-empty">
            <Waypoints size={22} />
            <strong>{t.unreachable}</strong>
            <p>{t.unreachableHint}</p>
          </div>
        ) : route ? (
          <>
            <div className="nav-summary">
              <div>
                <strong>{Math.max(1, Math.round(route.distance))} m</strong>
                <span>{t.walking}</span>
              </div>
              <div>
                <strong>{floorsCrossed}</strong>
                <span>{t.floors}</span>
              </div>
              <div>
                <strong>{route.steps.length}</strong>
                <span>{t.steps}</span>
              </div>
            </div>
            <ol className="nav-steps">
              {route.steps.map((s, i) => {
                const Icon = STEP_ICONS[s.kind];
                return (
                  <li key={i}>
                    <button className={`nav-step ${i === activeStep ? 'active' : ''}`} onClick={() => onSeek(i)}>
                      <span className="nav-step-num">{i + 1}</span>
                      <Icon size={15} />
                      <span className="nav-step-text">
                        {s.text}
                        <small>
                          {floorPhrase(project, s.floorId)}
                          {s.distance !== undefined ? ` · ${Math.max(1, Math.round(s.distance))} m` : ''}
                        </small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <p className="helper">{t.pick}</p>
        )}
      </div>
      {route && (
        <div className="nav-controls">
          <button
            className="icon-button"
            aria-label={t.prev}
            title={t.prev}
            disabled={(activeStep ?? 0) <= 0}
            onClick={() => onStep(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button className="button primary nav-play" onClick={playing ? onPause : onPlay}>
            {playing ? (
              <>
                <Pause size={15} />
                {t.pause}
              </>
            ) : (
              <>
                <Play size={15} />
                {t.play}
              </>
            )}
          </button>
          <button
            className="icon-button"
            aria-label={t.next}
            title={t.next}
            disabled={(activeStep ?? -1) >= route.steps.length - 1}
            onClick={() => onStep(1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </aside>
  );
}

interface Place {
  o: SiteObject;
  floor: string;
}
function PlacePicker({
  label,
  places,
  value,
  other,
  onPick,
  placeholder,
}: {
  label: string;
  places: Place[];
  value: string | null;
  other: string | null;
  onPick: (id: string | null) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(false),
    [cursor, setCursor] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const selected = value ? places.find(p => p.o.id === value) : undefined;
  const q = query.trim().toLowerCase();
  const matches = open
    ? places
        .filter(
          p => p.o.id !== other && (!q || p.o.name.toLowerCase().includes(q) || p.floor.toLowerCase().includes(q)),
        )
        .slice(0, 40)
    : [];
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, []);
  useEffect(() => setCursor(0), [q, open]);
  const pick = (p: Place) => {
    onPick(p.o.id);
    setOpen(false);
    setQuery('');
  };
  return (
    <label className="field place-picker" ref={wrap as never}>
      <span>{label}</span>
      <div className="place-input">
        <Search size={13} />
        <input
          aria-label={label}
          placeholder={selected ? selected.o.name : placeholder}
          value={open ? query : (selected?.o.name ?? '')}
          onFocus={() => {
            setOpen(true);
            setQuery('');
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={e => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor(c => Math.min(c + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor(c => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (matches[cursor]) pick(matches[cursor]);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {value && !open && (
          <button
            className="icon-button place-clear"
            aria-label={`Clear ${label}`}
            onClick={e => {
              e.preventDefault();
              onPick(null);
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {open && (
        <div className="place-options" role="listbox">
          {matches.length ? (
            matches.map((p, i) => (
              <button
                key={p.o.id}
                role="option"
                aria-selected={i === cursor}
                className={`place-option ${i === cursor ? 'cursor' : ''} ${p.o.id === value ? 'chosen' : ''}`}
                onPointerDown={e => {
                  e.preventDefault();
                  pick(p);
                }}
                onMouseEnter={() => setCursor(i)}
              >
                <EntityIcon kind={p.o.kind} size={14} symbol={p.o.symbol} />
                <span>
                  {p.o.name}
                  <small>{p.floor}</small>
                </span>
              </button>
            ))
          ) : (
            <p className="place-none">No places match “{query}”.</p>
          )}
          {matches.length === 40 && <p className="place-none">Keep typing to narrow down…</p>}
        </div>
      )}
    </label>
  );
}
