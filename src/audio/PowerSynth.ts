/**
 * Procedural sounds of the elemental powers (no clips needed): beam hums, crackling bolts and
 * thunder, frost, whooshing flames, water jets, wind, comedic shrink sweeps and squeaks.
 * Built from oscillators and one shared noise buffer, positioned with panners, routed into
 * the game's effects bus.
 */
export type SynthShot = 'thunder' | 'zap' | 'frost' | 'fire' | 'shrink' | 'squeak' | 'quake' | 'sizzle' | 'splash' | 'pop' | 'crackle' | 'phase' | 'beam' | 'orb';
/** 'charge': a rising hum (param 0..1: how far it has gathered); the focus beam and the seeker orb. */
export type SynthLoop = 'laser' | 'water' | 'wind' | 'run' | 'burn' | 'charge';

export interface SynthHandle {
  set(x: number, y: number, z: number, gain: number, param?: number): void;
  stop(): void;
}

type Out = { ctx: AudioContext; out: AudioNode; listener?: { x: number; y: number; z: number } };

export class PowerSynth {
  private noise: AudioBuffer | null = null;
  private voices = 0;

  constructor(private out: () => Out | null) {}

  private noiseBuf(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return (this.noise = b);
  }

  private panner(ctx: AudioContext, x: number, y: number, z: number, ref: number): PannerNode {
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1;
    p.maxDistance = 5000;
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    return p;
  }

  private noiseSrc(ctx: AudioContext, loop = false): AudioBufferSourceNode {
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf(ctx);
    s.loop = loop;
    return s;
  }

  /** One-shot at a point (ref: distance of full loudness). */
  play(kind: SynthShot, x: number, y: number, z: number, gain = 1, ref = 6, pitch = 1): void {
    const o = this.out();
    if (!o || this.voices > 24) return;
    const { ctx } = o;
    const t = ctx.currentTime + 0.005;
    const pan = this.panner(ctx, x, y, z, ref);
    const master = ctx.createGain();
    master.gain.value = gain;
    master.connect(pan).connect(o.out);
    let end = t + 1;
    const env = (node: AudioNode, peak: number, a: number, d: number, at = t) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + a);
      g.gain.exponentialRampToValueAtTime(0.0001, at + a + d);
      node.connect(g).connect(master);
      end = Math.max(end, at + a + d + 0.05);
      return g;
    };
    const noise = (type: BiquadFilterType, f0: number, f1: number, q: number, peak: number, a: number, d: number, at = t) => {
      const n = this.noiseSrc(ctx);
      const f = ctx.createBiquadFilter();
      f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(f0 * pitch, at);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * pitch), at + a + d);
      n.connect(f);
      env(f, peak, a, d, at);
      n.start(at, Math.random() * 1.5);
      n.stop(at + a + d + 0.05);
    };
    const tone = (type: OscillatorType, f0: number, f1: number, peak: number, a: number, d: number, at = t) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0 * pitch, at);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * pitch), at + a + d);
      env(osc, peak, a, d, at);
      osc.start(at);
      osc.stop(at + a + d + 0.05);
    };
    switch (kind) {
      case 'thunder':
        noise('highpass', 3000, 1500, 0.7, 0.9, 0.003, 0.12);
        for (let i = 0; i < 4; i++) noise('bandpass', 2500 + Math.random() * 2500, 1200, 2, 0.5, 0.002, 0.05, t + 0.03 + i * (0.02 + Math.random() * 0.03));
        noise('lowpass', 900, 120, 0.8, 0.8, 0.02, 1.6, t + 0.05);
        tone('sine', 70, 38, 0.5, 0.03, 1.2, t + 0.04);
        break;
      case 'zap':
        noise('bandpass', 4000, 2500, 3, 0.5, 0.002, 0.08);
        tone('sawtooth', 900, 300, 0.12, 0.002, 0.09);
        break;
      case 'frost':
        noise('highpass', 6000, 1800, 0.6, 0.55, 0.01, 0.7);
        for (let i = 0; i < 7; i++) tone('sine', 2200 + Math.random() * 2600, 1800 + Math.random() * 2400, 0.07, 0.002, 0.25 + Math.random() * 0.3, t + 0.05 + Math.random() * 0.4);
        tone('sine', 140, 60, 0.35, 0.01, 0.5);
        break;
      case 'fire':
        noise('lowpass', 600, 2400, 0.7, 0.9, 0.08, 0.35);
        noise('bandpass', 1200, 500, 0.8, 0.5, 0.15, 0.6, t + 0.1);
        for (let i = 0; i < 6; i++) noise('highpass', 5000, 4000, 1, 0.15, 0.001, 0.02, t + Math.random() * 0.7);
        break;
      case 'shrink': {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400 * pitch, t);
        osc.frequency.exponentialRampToValueAtTime(180 * pitch, t + 0.55);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 22;
        const lg = ctx.createGain();
        lg.gain.value = 120;
        lfo.connect(lg).connect(osc.frequency);
        env(osc, 0.3, 0.01, 0.55);
        osc.start(t); lfo.start(t); osc.stop(t + 0.62); lfo.stop(t + 0.62);
        tone('triangle', 2400, 3200, 0.08, 0.002, 0.12, t + 0.55);
        break;
      }
      case 'squeak':
        tone('sine', 2200, 3400, 0.18, 0.01, 0.09);
        tone('sine', 3000, 2400, 0.12, 0.01, 0.08, t + 0.1);
        break;
      case 'quake':
        noise('lowpass', 300, 60, 0.9, 1, 0.04, 1.4);
        tone('sine', 48, 28, 0.8, 0.05, 1.3);
        noise('bandpass', 1400, 400, 1.2, 0.4, 0.01, 0.5, t + 0.05);
        break;
      case 'sizzle':
        noise('highpass', 7000, 5000, 0.8, 0.25, 0.01, 0.35);
        break;
      case 'splash':
        noise('bandpass', 1800, 700, 0.9, 0.5, 0.01, 0.35);
        break;
      case 'pop':
        noise('bandpass', 2200, 900, 1.5, 0.6, 0.001, 0.06);
        tone('square', 1800, 600, 0.08, 0.001, 0.05);
        for (let i = 0; i < 4; i++) noise('highpass', 6000, 4500, 1, 0.2, 0.001, 0.02, t + 0.04 + Math.random() * 0.25);
        break;
      case 'crackle':
        for (let i = 0; i < 5; i++) noise('highpass', 4500, 3500, 1, 0.25, 0.001, 0.025, t + Math.random() * 0.3);
        break;
      case 'phase':
        // A hollow, ghostly whoop: two detuned sines sweeping down, a breath of air.
        tone('sine', 1300, 420, 0.22, 0.004, 0.22);
        tone('sine', 1340, 400, 0.16, 0.004, 0.26);
        noise('bandpass', 2400, 900, 2, 0.12, 0.01, 0.2);
        break;
      case 'beam':
        // The focus beam's release: a sharp crack and a deep, bright thrum.
        noise('highpass', 5000, 2500, 0.7, 0.7, 0.002, 0.08);
        tone('sawtooth', 220, 90, 0.22, 0.005, 0.35);
        tone('sine', 880, 330, 0.18, 0.003, 0.25);
        noise('lowpass', 1200, 200, 0.8, 0.45, 0.01, 0.5, t + 0.02);
        break;
      case 'orb':
        // A soft, round "whum".
        tone('sine', 300, 520, 0.28, 0.02, 0.2);
        tone('triangle', 900, 1500, 0.07, 0.02, 0.18);
        noise('bandpass', 800, 1400, 1.5, 0.12, 0.02, 0.15);
        break;
    }
    this.voices++;
    const done = Math.max(0.05, end - ctx.currentTime);
    setTimeout(() => { this.voices--; master.disconnect(); pan.disconnect(); }, done * 1000 + 50);
  }

  /** A positioned loop its owner moves and fades every frame; null before audio started. */
  loop(kind: SynthLoop, ref = 6): SynthHandle | null {
    const o = this.out();
    if (!o) return null;
    const { ctx } = o;
    const pan = this.panner(ctx, 0, 0, 0, ref);
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(pan).connect(o.out);
    const nodes: AudioScheduledSourceNode[] = [];
    const filters: BiquadFilterNode[] = [];
    const add = (src: AudioScheduledSourceNode, chain: AudioNode, g: number) => {
      const gn = ctx.createGain();
      gn.gain.value = g;
      chain.connect(gn).connect(master);
      nodes.push(src);
    };
    const band = (type: BiquadFilterType, f: number, q: number, g: number) => {
      const n = this.noiseSrc(ctx, true);
      const fl = ctx.createBiquadFilter();
      fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      n.connect(fl);
      add(n, fl, g);
      filters.push(fl);
      n.start(0, Math.random() * 1.5);
    };
    const osc = (type: OscillatorType, f: number, g: number) => {
      const s = ctx.createOscillator();
      s.type = type; s.frequency.value = f;
      add(s, s, g);
      s.start();
      return s;
    };
    let tuned: OscillatorNode[] = [];
    switch (kind) {
      case 'laser': {
        const a = osc('sawtooth', 110, 0.08), b = osc('square', 220.7, 0.05), c = osc('sine', 1760, 0.05);
        tuned = [a, b, c];
        band('bandpass', 3200, 1.5, 0.25);
        break;
      }
      case 'water': band('bandpass', 1500, 0.7, 0.9); band('lowpass', 400, 0.7, 0.5); break;
      case 'wind': band('bandpass', 500, 2.5, 1.2); band('lowpass', 200, 0.7, 0.6); break;
      case 'run': band('bandpass', 800, 1.2, 1); break;
      case 'burn': band('lowpass', 500, 0.7, 0.8); band('highpass', 6000, 0.7, 0.12); break;
      case 'charge': {
        const a = osc('sine', 180, 0.12), b = osc('triangle', 362, 0.05), c = osc('sine', 1440, 0.02);
        tuned = [a, b, c];
        break;
      }
    }
    let stopped = false;
    return {
      set: (x, y, z, gain, param = 1) => {
        if (stopped) return;
        const t = ctx.currentTime;
        pan.positionX.setTargetAtTime(x, t, 0.03); pan.positionY.setTargetAtTime(y, t, 0.03); pan.positionZ.setTargetAtTime(z, t, 0.03);
        master.gain.setTargetAtTime(gain, t, 0.06);
        if (kind === 'wind' || kind === 'run') for (const f of filters) f.frequency.setTargetAtTime((kind === 'run' ? 500 : 350) + 900 * param, t, 0.1);
        if (kind === 'laser') tuned.forEach((s, i) => s.frequency.setTargetAtTime([110, 220.7, 1760][i] * param, t, 0.05));
        if (kind === 'charge') tuned.forEach((s, i) => s.frequency.setTargetAtTime([180, 362, 1440][i] * (1 + 1.6 * param), t, 0.05));
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        master.gain.setTargetAtTime(0, t, 0.05);
        setTimeout(() => { for (const n of nodes) { try { n.stop(); } catch { /* */ } } master.disconnect(); pan.disconnect(); }, 400);
      },
    };
  }
}
