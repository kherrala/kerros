/** An original, quiet score for the tiled baths: suspended chords and a sparse glass-bell melody.
 * Synthesised locally, with a repeating forty-second phrase and a long stereo room tail. */
const BEAT = 60 / 48;
const CHORD_SECONDS = BEAT * 8;
const SCORE = [
  { chord: [50, 57, 60, 65], melody: [76, 74, 69] }, // Dm7, with a ninth in the melody
  { chord: [53, 60, 64, 69], melody: [72, 76, 69] }, // Fmaj7
  { chord: [48, 55, 62, 67], melody: [74, 79, 76] }, // Csus2
  { chord: [43, 57, 62, 65], melody: [77, 74, 69] }, // Gm9, open voicing
];
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const impulses = new WeakMap<BaseAudioContext, AudioBuffer>();

function roomImpulse(ctx: BaseAudioContext) {
  const cached = impulses.get(ctx);
  if (cached) return cached;
  const seconds = 6;
  const buffer = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  let seed = 0x706f6f6c;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      const t = i / ctx.sampleRate;
      // A small pre-delay leaves the notes legible before the diffuse tiled-room reflections.
      data[i] = t < 0.045 ? 0 : (((seed >>> 0) / 0xffffffff) * 2 - 1) * Math.exp(-t / 1.25) * (1 - t / seconds) ** 2;
    }
  }
  impulses.set(ctx, buffer);
  return buffer;
}

export function bathMusic(ctx: BaseAudioContext, out: AudioNode) {
  const nodes: AudioNode[] = [];
  const oscillators: OscillatorNode[] = [];
  const bus = ctx.createGain();
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 3200;
  low.Q.value = 0.5;
  const dry = ctx.createGain();
  dry.gain.value = 0.72;
  const reverb = ctx.createConvolver();
  reverb.buffer = roomImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.48;
  bus.connect(low);
  low.connect(dry).connect(out);
  low.connect(reverb).connect(wet).connect(out);
  nodes.push(bus, low, dry, reverb, wet);

  const voice = (pan: number, bell: boolean) => {
    const envelope = ctx.createGain();
    envelope.gain.value = 0;
    const stereo = ctx.createStereoPanner();
    stereo.pan.value = pan;
    envelope.connect(stereo).connect(bus);
    nodes.push(envelope, stereo);
    const tones = [1, bell ? 2.002 : 1].map((ratio, i) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = !bell && i === 1 ? 'triangle' : 'sine';
      oscillator.detune.value = bell ? 0 : i ? 3 : -3;
      const gain = ctx.createGain();
      gain.gain.value = i ? (bell ? 0.22 : 0.3) : 1;
      oscillator.connect(gain).connect(envelope);
      oscillator.start();
      nodes.push(gain);
      oscillators.push(oscillator);
      return { oscillator, ratio };
    });
    const note = (midi: number, at: number, level: number, attack: number, hold: number, duration: number) => {
      for (const { oscillator, ratio } of tones) oscillator.frequency.setValueAtTime(hz(midi) * ratio, at);
      const gain = envelope.gain;
      gain.setValueAtTime(0, at);
      gain.linearRampToValueAtTime(level, at + attack);
      gain.setValueAtTime(level, at + attack + hold);
      gain.exponentialRampToValueAtTime(0.00001, at + duration - 0.05);
      gain.linearRampToValueAtTime(0, at + duration);
    };
    return { note };
  };
  const pads = [-0.55, 0.25, -0.2, 0.6].map(pan => voice(pan, false));
  const bells = [-0.4, 0.3, 0.5, -0.25].map(pan => voice(pan, true));
  let next = ctx.currentTime + 0.05;
  let bar = 0;
  let bell = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    // Skip elapsed bars after a background-tab stall instead of firing a backlog of notes.
    while (next < ctx.currentTime) {
      next += CHORD_SECONDS;
      bar++;
    }
    while (next < ctx.currentTime + CHORD_SECONDS * 2) {
      const phrase = SCORE[bar % SCORE.length];
      phrase.chord.forEach((midi, i) => pads[i].note(midi, next, i ? 0.045 : 0.055, 2, 3, CHORD_SECONDS));
      phrase.melody.forEach((midi, i) => {
        bells[bell++ % bells.length].note(midi, next + [1, 3.5, 6][i] * BEAT, 0.065, 0.025, 0, 3.8);
      });
      next += CHORD_SECONDS;
      bar++;
    }
    timer = setTimeout(schedule, 1000);
  };
  schedule();
  // A fixed voice bank bounds memory for an indefinitely long walk. No new nodes per note.
  return {
    nodes,
    sources: [
      ...oscillators,
      {
        stop() {
          stopped = true;
          clearTimeout(timer);
        },
      },
    ],
  };
}
