import { ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      className={`modal ${wide ? 'wide' : ''}`}
      ref={dialog}
      onCancel={onClose}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  value,
  onChange,
  type = 'text',
  suffix,
  min,
  max,
  step,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-wrap">
        <input
          key={String(value)}
          aria-label={label}
          type={type}
          defaultValue={value}
          min={min}
          max={max}
          step={step ?? (type === 'number' ? 0.1 : undefined)}
          onBlur={e => {
            if (String(value) !== e.currentTarget.value) onChange(e.currentTarget.value);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        {suffix && <em>{suffix}</em>}
      </div>
    </label>
  );
}
export function Toggle({
  label,
  value,
  onChange,
  description,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
  description?: string;
}) {
  return (
    <button className="toggle-row" role="switch" aria-checked={value} onClick={onChange}>
      <span>
        {label}
        {description && <small>{description}</small>}
      </span>
      <i className={`toggle ${value ? 'on' : ''}`} />
    </button>
  );
}

/** Searchable dropdown for level selection: projects like the Silo carry a hundred floors. */
export interface FloorEntry {
  id: string;
  code: string;
  name: string;
  hint?: string;
}
export function FloorSelect({
  entries,
  value,
  onPick,
  ariaLabel,
}: {
  entries: FloorEntry[];
  value: string;
  onPick: (id: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = entries.find(e => e.id === value);
  const q = query.trim().toLowerCase();
  const matches = open
    ? entries
        .filter(
          e =>
            !q ||
            e.name.toLowerCase().includes(q) ||
            e.code.toLowerCase().includes(q) ||
            (e.hint ?? '').toLowerCase().includes(q),
        )
        .slice(0, 60)
    : [];
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, []);
  useEffect(() => {
    setCursor(0);
  }, [q, open]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
    setQuery('');
  };
  return (
    <div className="floor-select" ref={wrap}>
      <button
        aria-label={ariaLabel}
        data-value={value}
        className="floor-select-value"
        onClick={() => {
          setOpen(!open);
          setQuery('');
        }}
      >
        {current ? (
          <>
            <b>{current.code}</b>
            <span>{current.name}</span>
          </>
        ) : (
          ariaLabel
        )}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="place-options floor-select-options" role="listbox">
          <div className="place-input">
            <Search size={13} />
            <input
              ref={input}
              aria-label="Search floors"
              placeholder="Search floors…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCursor(v => Math.min(v + 1, matches.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCursor(v => Math.max(v - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (matches[cursor]) pick(matches[cursor].id);
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
            />
          </div>
          {matches.map((e, i) => (
            <button
              key={e.id}
              role="option"
              aria-selected={e.id === value}
              className={`place-option ${i === cursor ? 'cursor' : ''} ${e.id === value ? 'chosen' : ''}`}
              onPointerDown={ev => {
                ev.preventDefault();
                pick(e.id);
              }}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="floor-number">{e.code}</span>
              <span>
                {e.name}
                {e.hint && <small>{e.hint}</small>}
              </span>
            </button>
          ))}
          {!matches.length && <p className="place-none">No floors match.</p>}
        </div>
      )}
    </div>
  );
}
