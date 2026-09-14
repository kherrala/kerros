import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  DoorOpen,
  Flag,
  Footprints,
  Layers3,
  MapPin,
  MoveUpRight,
  Pause,
  PersonStanding,
  Play,
  Search,
  Waypoints,
  X,
} from 'lucide-react';
import type { Point, ProjectDocument, SiteObject } from '../model/types';
import type { Route, RouteStep } from '../model/navigation';
import { floorPhrase, HERE, navNodes } from '../model/navigation';
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

export interface NavigatePanelProps {
  project: ProjectDocument;
  /** Where the person is — the walk's avatar — offered as "Where you are" and proposed as the
   *  start whenever nothing else has been chosen. Null when nobody has walked yet. */
  here?: { floorId: string | null; position: Point } | null;
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
  here,
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
}: NavigatePanelProps) {
  const en = useStrings();
  const t = en.navigate;
  // Every place a route can start or end, in level order and alphabetical within a level, each
  // knowing its level's name and the space it sits in (a door in a room, a room in a zone), which
  // is what the browse view groups by.
  const { places, levels } = useMemo(() => {
    const options = project.objects.filter(o => NAV_KINDS.includes(o.kind));
    const byId = new Map(project.objects.map(o => [o.id, o]));
    const levels: Level[] = [
      { id: null, name: en.outdoors, count: 0 },
      ...project.floors.map(f => ({ id: f.id as string | null, name: floorPhrase(project, f.id), count: 0 })),
    ];
    const places: Place[] = [];
    for (const level of levels) {
      const items = options.filter(o => o.floorId === level.id).sort((a, b) => a.name.localeCompare(b.name));
      level.count = items.length;
      for (const o of items) {
        const parent = o.parentId ? byId.get(o.parentId) : undefined;
        places.push({ id: o.id, o, floorId: level.id, floor: level.name, group: parent?.name ?? '' });
      }
    }
    return { places, levels: levels.filter(l => l.count) };
  }, [project, en.outdoors]);
  const hereLabel = here
    ? `${t.here} · ${here.floorId === null ? en.outdoors : floorPhrase(project, here.floorId)}`
    : '';
  const herePlace: Place | null = here
    ? {
        id: HERE,
        o: { id: HERE, kind: 'poi', name: t.here, floorId: here.floorId, position: here.position } as SiteObject,
        floorId: here.floorId,
        floor: hereLabel,
        group: '',
      }
    : null;
  // Propose where the person is as the start. Once, when there is one and nothing was chosen —
  // not on every render, or clearing the start would be undone at the next frame.
  const proposed = useRef(false);
  useEffect(() => {
    if (here && !from && !to && !proposed.current) {
      proposed.current = true;
      onFrom(HERE);
    }
  }, [here, from, to, onFrom]);
  const hasGraph = useMemo(() => navNodes(project).length > 0, [project]);
  const floorsCrossed = route ? new Set(route.steps.map(s => s.floorId)).size : 0;
  const picker = (
    label: string,
    value: string | null,
    other: string | null,
    set: (id: string | null) => void,
    first: Place | null,
  ) => (
    <PlacePicker
      label={label}
      places={places}
      levels={levels}
      first={first}
      value={value}
      other={other}
      onPick={set}
      placeholder={t.choose}
      strings={t}
    />
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
            {picker(t.from, from, to, onFrom, herePlace)}
            {picker(t.to, to, from, onTo, null)}
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
  id: string;
  o: SiteObject;
  floorId: string | null;
  floor: string;
  /** The space this place sits in, when the document says so. */
  group: string;
}
interface Level {
  id: string | null;
  name: string;
  count: number;
}
/** How many rows a list shows before it asks to be scrolled, and how many more each scroll adds.
 *  A big floor has hundreds of rooms, and all of them are one list — laid out a page at a time so
 *  the first paint is instant and the last row is still reachable. */
const PAGE = 60;

/** A searchable place picker with two ways in. Type, and it searches every place on every level;
 *  leave it empty, and it browses — the levels first, then the places on the one you open, grouped
 *  by the space they sit in. Both lists scroll to the end rather than stopping at a count. */
function PlacePicker({
  label,
  places,
  levels,
  first,
  value,
  other,
  onPick,
  placeholder,
  strings,
}: {
  label: string;
  places: Place[];
  levels: Level[];
  /** A place offered ahead of everything — "Where you are" — or null. */
  first: Place | null;
  value: string | null;
  other: string | null;
  onPick: (id: string | null) => void;
  placeholder: string;
  strings: { here: string; hereHint: string; levels: string; allLevels: string; places: string; more: string };
}) {
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(false),
    [cursor, setCursor] = useState(0),
    // The level being browsed; undefined is the list of levels.
    [level, setLevel] = useState<string | null | undefined>(undefined),
    [limit, setLimit] = useState(PAGE);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const selected = value === HERE ? first : value ? places.find(p => p.id === value) : undefined;
  const q = query.trim().toLowerCase();
  const browsing = open && !q;
  // Search mode: every place whose name or level matches. Browse mode on a level: that level's
  // places. Neither is cut off; the page limit only decides how many are laid out so far.
  const matches: Place[] = !open
    ? []
    : q
      ? places.filter(p => p.id !== other && (p.o.name.toLowerCase().includes(q) || p.floor.toLowerCase().includes(q)))
      : level !== undefined
        ? places.filter(p => p.id !== other && p.floorId === level)
        : [];
  const shown = matches.slice(0, limit);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, []);
  useEffect(() => {
    setCursor(0);
    setLimit(PAGE);
    if (list.current) list.current.scrollTop = 0;
  }, [q, open, level]);
  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
    setQuery('');
    setLevel(undefined);
  };
  const more = () => {
    const el = list.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 80 && limit < matches.length) setLimit(n => n + PAGE);
  };
  const option = (p: Place, i: number) => (
    <button
      key={p.id}
      role="option"
      aria-selected={i === cursor}
      className={`place-option ${i === cursor ? 'cursor' : ''} ${p.id === value ? 'chosen' : ''} ${p.id === HERE ? 'here' : ''}`}
      onPointerDown={e => {
        e.preventDefault();
        pick(p.id);
      }}
      onMouseEnter={() => setCursor(i)}
    >
      {p.id === HERE ? <PersonStanding size={14} /> : <EntityIcon kind={p.o.kind} size={14} symbol={p.o.symbol} />}
      <span>
        {p.o.name}
        <small>{p.id === HERE ? `${strings.hereHint} · ${p.floor.split(' · ')[1] ?? ''}` : p.floor}</small>
      </span>
    </button>
  );
  // Rows of a browsed level, with a heading wherever the space changes: a room's doors under the
  // room, the rooms of a zone under the zone.
  const grouped = (rows: Place[]) => {
    const out: ReactNode[] = [];
    let group: string | undefined;
    rows.forEach((p, i) => {
      if (p.group !== group) {
        group = p.group;
        if (group)
          out.push(
            <p key={`g-${group}-${i}`} className="place-group">
              {group}
            </p>,
          );
      }
      out.push(option(p, i));
    });
    return out;
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
              setCursor(c => Math.min(c + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor(c => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (shown[cursor]) pick(shown[cursor].id);
            } else if (e.key === 'Backspace' && !query && level !== undefined) {
              setLevel(undefined);
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
        <div className="place-options" role="listbox" ref={list} onScroll={more}>
          {browsing && level === undefined ? (
            <>
              {first && first.id !== other && option(first, -1)}
              <p className="place-group">{strings.levels}</p>
              {levels.map(l => (
                <button
                  key={l.id ?? 'out'}
                  className="place-level"
                  onPointerDown={e => {
                    e.preventDefault();
                    setLevel(l.id);
                  }}
                >
                  <Layers3 size={14} />
                  {l.name}
                  <small>
                    {l.count} {strings.places}
                  </small>
                </button>
              ))}
            </>
          ) : (
            <>
              {browsing && (
                <button
                  className="place-back"
                  onPointerDown={e => {
                    e.preventDefault();
                    setLevel(undefined);
                  }}
                >
                  <ChevronLeft size={14} />
                  {strings.allLevels}
                </button>
              )}
              {!browsing && first && first.id !== other && first.o.name.toLowerCase().includes(q) && option(first, -1)}
              {shown.length ? (
                browsing ? (
                  grouped(shown)
                ) : (
                  shown.map(option)
                )
              ) : (
                <p className="place-none">No places match “{query}”.</p>
              )}
              {limit < matches.length && <p className="place-none">{strings.more}</p>}
            </>
          )}
        </div>
      )}
    </label>
  );
}
