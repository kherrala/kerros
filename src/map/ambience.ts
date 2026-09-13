// The sound of a building, heard from inside it. Nothing is recorded or fetched: every preset is a
// small Web Audio graph — oscillators for the ballasts and the compressor, filtered noise for the air
// handling — because a hum is a hum and a file of one would be a hundred kilobytes of the same second.
//
// Two halves. ambienceAt() is the document's opinion of what a point on a floor sounds like, pure and
// testable; AmbienceEngine plays it, cross-fading as the walker crosses from one space into the next.
import type { Ambience, AmbiencePreset, Point, ProjectDocument } from '../model/types';
import { spaceAt } from '../model/spaces';
import { bathMusic } from './bathMusic';

export const AMBIENCES: { id: AmbiencePreset; label: string; description: string }[] = [
  { id: 'silent', label: 'Silent', description: 'Nothing but the walk' },
  { id: 'office', label: 'Office', description: 'Ventilation and a faint ballast hum' },
  { id: 'backrooms', label: 'Backrooms', description: 'Ballasts, breathing air handling, a compressor somewhere' },
  { id: 'plant', label: 'Plant room', description: 'Machinery, close and loud' },
  { id: 'baths', label: 'Bath music', description: 'Slow suspended chords, soft glass bells and a spacious echo' },
];

/** What a point on a floor sounds like: the space's own ambience, else the floor's, else nothing.
 *  `silent` resolves to null too, so a room can be the quiet one on a humming floor. */
export function ambienceAt(project: ProjectDocument, floorId: string | null, at: Point): Ambience | null {
  const space = spaceAt(project, floorId, at);
  const floor = project.floors.find(f => f.id === floorId);
  const chosen = space?.ambience ?? floor?.ambience ?? null;
  return chosen && chosen.preset !== 'silent' ? chosen : null;
}

/** How long a room takes to fade into the next. A door is not a switch. */
const CROSSFADE = 1.6;

/* ------------------------------------------------------------------ the sounds */

/** Looping pink-ish noise, four seconds of it: a Voss–McCartney sum of white noise at octave rates,
 *  which is what air moving through ducting sounds like before the filters shape it. Made once per
 *  context: it is a few hundred thousand samples, and a preset is built inside the walk's own frame,
 *  on the step that crosses a threshold. */
const noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx);
  if (cached) return cached;
  const buffer = makeNoise(ctx);
  noiseBuffers.set(ctx, buffer);
  return buffer;
}
function makeNoise(ctx: AudioContext): AudioBuffer {
  const seconds = 4,
    buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate),
    data = buffer.getChannelData(0);
  const rows = new Float32Array(8);
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x2c1b3c6d) | 0;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    for (let r = 0; r < rows.length; r++) {
      if (i % (1 << r) === 0) rows[r] = random();
      sum += rows[r];
    }
    data[i] = sum / rows.length;
  }
  return buffer;
}

interface Layer {
  nodes: AudioNode[];
  sources: (AudioScheduledSourceNode | { stop(): void })[];
}

function hum(ctx: AudioContext, out: AudioNode, hz: number, gain: number, harmonics: number[]): Layer {
  const nodes: AudioNode[] = [],
    sources: AudioScheduledSourceNode[] = [];
  harmonics.forEach((weight, i) => {
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? 'sine' : 'triangle';
    osc.frequency.value = hz * (i + 1);
    const g = ctx.createGain();
    g.gain.value = gain * weight;
    osc.connect(g).connect(out);
    osc.start();
    nodes.push(g);
    sources.push(osc);
  });
  return { nodes, sources };
}

/** A fluorescent ballast: mains at twice the line frequency with a comb of harmonics, and a thin
 *  whine up where the ballast itself sings. Slightly unsteady — a real one is. */
function ballast(ctx: AudioContext, out: AudioNode, level: number): Layer {
  // Voiced for the speakers people actually have. A ballast's fundamental is 100 Hz, which a laptop
  // cannot reproduce at all; what you hear of one is its harmonics up through the midrange, so the
  // comb runs well past a kilohertz and the band that shapes it sits there too.
  const g = ctx.createGain();
  g.gain.value = level;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 650;
  band.Q.value = 0.45;
  band.connect(g).connect(out);
  const tone = hum(ctx, band, 100, 0.7, [1, 0.7, 0.55, 0.5, 0.4, 0.32, 0.26, 0.2, 0.16, 0.13, 0.1, 0.08]);
  const whine = ctx.createOscillator();
  whine.type = 'sine';
  whine.frequency.value = 7900;
  const wg = ctx.createGain();
  wg.gain.value = level * 0.03;
  whine.connect(wg).connect(out);
  whine.start();
  // Flutter: a slow wobble on the level so it never settles into a pure tone.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.37;
  const depth = ctx.createGain();
  depth.gain.value = level * 0.12;
  lfo.connect(depth).connect(g.gain);
  lfo.start();
  return { nodes: [g, band, wg, depth, ...tone.nodes], sources: [...tone.sources, whine, lfo] };
}

/** Air handling: pink noise through a low shelf, with a resonance where the duct sings and a slow
 *  breath on the level as the plant modulates. */
function airHandling(ctx: AudioContext, out: AudioNode, level: number, breath = 0.05): Layer {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 1100;
  low.Q.value = 0.6;
  const duct = ctx.createBiquadFilter();
  duct.type = 'peaking';
  duct.frequency.value = 170;
  duct.Q.value = 2.5;
  duct.gain.value = 6;
  const g = ctx.createGain();
  g.gain.value = level;
  src.connect(low).connect(duct).connect(g).connect(out);
  // The diffusers: the same noise, only its top, quiet. This is the part a laptop can play.
  const rush = ctx.createBiquadFilter();
  rush.type = 'highpass';
  rush.frequency.value = 2400;
  const rg = ctx.createGain();
  rg.gain.value = level * 0.22;
  src.connect(rush).connect(rg).connect(out);
  src.start();
  const lfo = ctx.createOscillator();
  lfo.frequency.value = breath;
  const depth = ctx.createGain();
  depth.gain.value = level * 0.3;
  lfo.connect(depth).connect(g.gain);
  lfo.start();
  return { nodes: [low, duct, g, depth, rush, rg], sources: [src, lfo] };
}

/** A compressor that cycles: mains hum and a low rattle for half a minute, then off for a while,
 *  with the thump of the relay at each end. Scheduled ahead on the audio clock, so it keeps time
 *  whatever the main thread is doing. */
function compressor(ctx: AudioContext, out: AudioNode, level: number): Layer {
  const g = ctx.createGain();
  g.gain.value = 0;
  g.connect(out);
  // Harmonics up to 300 Hz: the fundamental is felt, the harmonics are what is heard.
  const tone = hum(ctx, g, 50, level, [0.6, 1, 0.7, 0.5, 0.35, 0.25]);
  const rattle = ctx.createBufferSource();
  rattle.buffer = noiseBuffer(ctx);
  rattle.loop = true;
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 260;
  const rg = ctx.createGain();
  rg.gain.value = level * 0.35;
  rattle.connect(low).connect(rg).connect(g);
  rattle.start();
  // The duty cycle, scheduled a cycle at a time.
  const ON = 34,
    OFF = 18,
    RISE = 0.4;
  let at = ctx.currentTime + 3;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    g.gain.setTargetAtTime(1, at, RISE);
    g.gain.setTargetAtTime(0, at + ON, RISE * 0.6);
    at += ON + OFF;
    timer = setTimeout(schedule, (at - ctx.currentTime - 5) * 1000);
  };
  schedule();
  return {
    nodes: [g, low, rg, ...tone.nodes],
    sources: [...tone.sources, rattle, { stop: () => clearTimeout(timer) }],
  };
}

const RECIPES: Record<Exclude<AmbiencePreset, 'silent'>, (ctx: AudioContext, out: AudioNode) => Layer[]> = {
  baths: (ctx, out) => [bathMusic(ctx, out)],
  office: (ctx, out) => [airHandling(ctx, out, 0.24, 0.04), ballast(ctx, out, 0.07)],
  backrooms: (ctx, out) => [airHandling(ctx, out, 0.34, 0.06), ballast(ctx, out, 0.2), compressor(ctx, out, 0.22)],
  plant: (ctx, out) => [
    airHandling(ctx, out, 0.6, 0.1),
    hum(ctx, out, 50, 0.3, [0.6, 1, 0.7, 0.5, 0.3]),
    compressor(ctx, out, 0.35),
  ],
};

/* ------------------------------------------------------------------ the player */

interface Playing {
  key: string;
  gain: GainNode;
  layers: Layer[];
}

/** Plays one ambience at a time and cross-fades between them. Owns its AudioContext, which the
 *  browser will only let run after the person has clicked or pressed something — resume() is for
 *  the host to call from such a gesture, and everything else copes with a context that is not yet
 *  running by starting silently and coming up when it is. */
export class AmbienceEngine {
  private ctx?: AudioContext;
  private master?: GainNode;
  private playing?: Playing;
  private fading: Playing[] = [];
  private muted = false;

  get isMuted() {
    return this.muted;
  }

  /** Let the context run. Safe to call on every gesture; a running context ignores it. */
  resume() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    const master = this.master;
    if (master && this.ctx) master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.15);
  }

  /** Play this — or nothing, for null — fading out whatever was playing. Same thing again is a no-op. */
  set(ambience: Ambience | null) {
    const key = ambience ? `${ambience.preset}@${ambience.level ?? 1}` : '';
    if ((this.playing?.key ?? '') === key) return;
    const ctx = this.context();
    if (!ctx || !this.master) return;
    if (this.playing) this.fadeOut(this.playing);
    this.playing = undefined;
    if (!ambience) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    const layers = RECIPES[ambience.preset as Exclude<AmbiencePreset, 'silent'>](ctx, gain);
    gain.gain.setTargetAtTime(ambience.level ?? 1, ctx.currentTime, CROSSFADE / 3);
    this.playing = { key, gain, layers };
  }

  dispose() {
    if (this.playing) this.fadeOut(this.playing);
    this.playing = undefined;
    const ctx = this.ctx;
    this.ctx = undefined;
    this.master = undefined;
    // Let the fade be heard, then close. Closing releases the hardware; a page that leaves a
    // context open per visit runs out of them.
    setTimeout(() => void ctx?.close().catch(() => undefined), CROSSFADE * 1000 + 200);
  }

  private context(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) return undefined;
    try {
      this.ctx = new Ctor();
    } catch {
      return undefined;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    // A limiter on the way out. The layers are levelled to sit well under full scale together, but
    // a compressor coming on over a ballast on a loud floor is exactly the sum nobody has listened
    // to on every device; this turns "might clip" into "will not".
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.2;
    this.master.connect(limiter).connect(this.ctx.destination);
    return this.ctx;
  }

  private fadeOut(playing: Playing) {
    const ctx = this.ctx;
    if (!ctx) return;
    playing.gain.gain.setTargetAtTime(0, ctx.currentTime, CROSSFADE / 3);
    this.fading.push(playing);
    setTimeout(() => {
      this.fading = this.fading.filter(p => p !== playing);
      for (const layer of playing.layers) {
        for (const s of layer.sources) s.stop();
        for (const n of layer.nodes) n.disconnect();
      }
      playing.gain.disconnect();
    }, CROSSFADE * 1000);
  }
}
