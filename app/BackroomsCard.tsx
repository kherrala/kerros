import { useMemo, useState } from 'react';
import { ArrowRight, Shuffle } from 'lucide-react';
import { BACKROOMS_SEED, type BackroomsOptions } from './demo/backrooms';
import { generateOfficeLayout } from './demo/officeLayout';

export function BackroomsCard({ onOpen }: { onOpen: (options: BackroomsOptions) => Promise<void> }) {
  const [seed, setSeed] = useState(BACKROOMS_SEED),
    [size, setSize] = useState(28),
    [busy, setBusy] = useState(false);
  const layout = useMemo(() => generateOfficeLayout(`${seed.trim() || BACKROOMS_SEED}/office/0`, size), [seed, size]);
  const walls = layout.boundaries
    .map(e => {
      const [x, y] = e.start,
        [xx, yy] = e.end;
      if (!e.passage) return `M${x},${y}L${xx},${yy}`;
      return `M${x},${y}l${(xx - x) * 0.3},${(yy - y) * 0.3}M${x + (xx - x) * 0.7},${y + (yy - y) * 0.7}L${xx},${yy}`;
    })
    .join('');
  return (
    <form
      className="home-card backrooms-card"
      onSubmit={async e => {
        e.preventDefault();
        setBusy(true);
        try {
          await onOpen({ seed, size });
        } finally {
          setBusy(false);
        }
      }}
    >
      <svg
        className="backrooms-preview"
        viewBox={`-0.5 -0.5 ${size + 1} ${size + 1}`}
        role="img"
        aria-label={`Generated office plan with ${layout.rooms.length} connected rooms`}
      >
        <rect width={size} height={size} fill="#aea16d" />
        {layout.rooms.map((room, i) => (
          <rect
            key={i}
            x={room.x}
            y={room.y}
            width={room.width}
            height={room.depth}
            fill="#e3d59b"
            opacity={0.2 + room.noise * 0.6}
          />
        ))}
        <path d={walls} fill="none" stroke="#665b35" strokeWidth="0.085" />
      </svg>
      <strong>The Backrooms · Offices</strong>
      <p>Three vast office levels. Yellow wallpaper, worn carpet, fluorescent light, and a maze of connected rooms.</p>
      <label className="backrooms-field">
        Layout seed
        <span className="backrooms-seed">
          <input value={seed} maxLength={80} onChange={e => setSeed(e.target.value)} aria-label="Office layout seed" />
          <button
            type="button"
            className="icon-button"
            aria-label="Randomize office seed"
            onClick={() => setSeed(crypto.randomUUID().slice(0, 8))}
          >
            <Shuffle size={16} />
          </button>
        </span>
      </label>
      <label className="backrooms-field">
        Floor size
        <select value={size} onChange={e => setSize(Number(e.target.value))} aria-label="Office floor size">
          <option value={24}>144 × 144 m</option>
          <option value={28}>168 × 168 m</option>
          <option value={36}>216 × 216 m</option>
        </select>
      </label>
      <span className="backrooms-count">{layout.rooms.length} rooms on Level 0 · 3 office levels</span>
      <button className="button primary" type="submit" disabled={busy}>
        {busy ? 'Generating…' : 'Open offices'}
        <ArrowRight size={15} />
      </button>
    </form>
  );
}
