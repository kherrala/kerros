// Synthetic "last capture" frames for camera hover popups. Nothing is a real feed: each camera
// gets a stable, seeded interior scene (CCTV-style grayscale with a green cast) whose people
// blobs shuffle every few seconds, so hovering reads as a live monitor without any imagery deps.
import type { SiteObject } from '../model/types';

const cache = new Map<string, string>();
const mulberry = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hash = (s: string) => {
  let h = 9;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 387420489);
  return h >>> 0;
};

export function cameraPeek(o: SiteObject): string {
  const bucket = Math.floor(Date.now() / 5000);
  const key = `${o.id}:${bucket}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size > 60) cache.clear();
  const W = 232,
    H = 130,
    canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) return '';
  const rand = mulberry(hash(o.id)),
    jitter = mulberry(hash(key));
  // Room shell: back wall, perspective floor, side shadowing.
  const horizon = H * (0.38 + rand() * 0.1);
  const wall = g.createLinearGradient(0, 0, 0, horizon);
  wall.addColorStop(0, '#3d423f');
  wall.addColorStop(1, '#565c56');
  g.fillStyle = wall;
  g.fillRect(0, 0, W, horizon);
  const floor = g.createLinearGradient(0, horizon, 0, H);
  floor.addColorStop(0, '#6d7269');
  floor.addColorStop(1, '#494e48');
  g.fillStyle = floor;
  g.fillRect(0, horizon, W, H - horizon);
  // Fixed furniture silhouettes seeded per camera.
  for (let i = 0; i < 4; i++) {
    const x = rand() * W,
      w = 22 + rand() * 40,
      h = 10 + rand() * 22,
      y = horizon - h + rand() * 6;
    g.fillStyle = `rgba(28,32,30,${0.35 + rand() * 0.3})`;
    g.fillRect(x, y, w, h);
  }
  for (let i = 0; i < 3; i++) {
    const y = horizon + 8 + rand() * (H - horizon - 18);
    const x = rand() * W;
    g.fillStyle = 'rgba(24,27,25,.28)';
    g.fillRect(x, y, 26 + rand() * 34, 7 + rand() * 10);
  }
  // People: soft blobs that move between refreshes.
  const people = Math.floor(jitter() * 3.4);
  for (let i = 0; i < people; i++) {
    const x = 15 + jitter() * (W - 30),
      y = horizon + 4 + jitter() * (H - horizon - 22),
      s = 5 + jitter() * 3;
    g.fillStyle = 'rgba(210,214,205,.85)';
    g.beginPath();
    g.ellipse(x, y, s * 0.55, s, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(x, y - s * 1.25, s * 0.42, 0, Math.PI * 2);
    g.fill();
  }
  // CCTV finish: green cast, scanlines, noise, vignette.
  g.fillStyle = 'rgba(112,150,110,.10)';
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,.10)';
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(255,255,255,${jitter() * 0.09})`;
    g.fillRect(jitter() * W, jitter() * H, 1, 1);
  }
  const vin = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.75);
  vin.addColorStop(0, 'rgba(0,0,0,0)');
  vin.addColorStop(1, 'rgba(0,0,0,.42)');
  g.fillStyle = vin;
  g.fillRect(0, 0, W, H);
  // OSD: REC pip, camera id, timestamp.
  g.fillStyle = '#ff5148';
  g.beginPath();
  g.arc(11, 11, 3.2, 0, Math.PI * 2);
  g.fill();
  g.font = '700 9px ui-monospace, monospace';
  g.fillStyle = 'rgba(240,244,238,.92)';
  g.fillText('REC', 19, 14);
  g.fillText(o.feedId?.toUpperCase().slice(0, 18) ?? 'CAM', 8, H - 8);
  const now = new Date();
  g.fillText(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), W - 62, H - 8);
  const url = canvas.toDataURL('image/jpeg', 0.8);
  cache.set(key, url);
  return url;
}
