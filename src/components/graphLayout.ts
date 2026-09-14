export interface GraphPoint {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned?: boolean;
}
/** Bounded sampled repulsion keeps large navigation graphs out of quadratic per-frame work. */
export function balanceGraph(points: GraphPoint[], links: [number, number][], tick: number): void {
  const stride = Math.max(1, Math.ceil(points.length / 80));
  const alpha = Math.max(0.08, 1 - tick / 360);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    p.vx -= p.x * 0.001 * alpha;
    p.vy -= p.y * 0.001 * alpha;
    for (let j = (i + tick) % stride; j < points.length; j += stride) {
      if (j === i) continue;
      const q = points[j];
      let dx = p.x - q.x,
        dy = p.y - q.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.01) {
        dx = i < j ? -0.1 : 0.1;
        dy = 0.1;
      }
      const force = (90 * stride * alpha) / Math.max(25, dx * dx + dy * dy);
      p.vx += dx * force;
      p.vy += dy * force;
    }
  }
  for (const [a, b] of links) {
    const p = points[a],
      q = points[b];
    if (!p || !q || a === b) continue;
    const dx = q.x - p.x,
      dy = q.y - p.y,
      length = Math.hypot(dx, dy) || 1;
    const force = ((length - 50) / length) * 0.018 * alpha;
    p.vx += dx * force;
    p.vy += dy * force;
    q.vx -= dx * force;
    q.vy -= dy * force;
  }
  for (const p of points) {
    if (!p.pinned) {
      p.x += Math.max(-6, Math.min(6, p.vx));
      p.y += Math.max(-6, Math.min(6, p.vy));
    }
    p.vx *= 0.7;
    p.vy *= 0.7;
  }
}
