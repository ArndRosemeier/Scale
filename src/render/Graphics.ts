/**
 * Graphics quality: presets (Low … Ultra), a render-scale override, and — when nothing is set
 * by hand — automatic adaptation to the GPU.
 *
 * Auto starts from a guess (the GPU's name from WEBGL_debug_renderer_info, or the level learned
 * on this GPU last time) and then watches the frames: steps down when the frame rate stays low
 * and the time goes to rendering (not to the simulation), steps back up when the GPU timer
 * (EXT_disjoint_timer_query_webgl2) shows plenty of headroom. A level it had to leave is not
 * tried again in this session, so it does not flip back and forth.
 *
 * Steps are ordered cheapest-to-switch first: pixel ratio, shadow map size, bloom and the
 * facade LOD distance change without recompiling anything. Shadows off at runtime moves the
 * shadow frustum away instead of disabling the shadow map (that would recompile every shader);
 * only a start-up level without shadows turns the shadow map off for real.
 */
import type * as THREE from 'three';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type QualitySetting = 'auto' | Quality;

export interface GraphicsLevel {
  name: string;
  /** devicePixelRatio is capped at this before `scale` applies. */
  maxPixelRatio: number;
  /** Render scale (fraction of the capped pixel ratio). */
  scale: number;
  shadows: boolean;
  shadowMap: number;
  bloom: boolean;
  smaa: boolean;
  /** Facade LOD switch distance multiplier. */
  lod: number;
}

/** The auto ladder, best first. The manual presets are rungs of it (PRESET). */
export const LADDER: GraphicsLevel[] = [
  { name: 'Ultra', maxPixelRatio: 1.5, scale: 1, shadows: true, shadowMap: 4096, bloom: true, smaa: true, lod: 1 },
  { name: 'High', maxPixelRatio: 1.25, scale: 1, shadows: true, shadowMap: 2048, bloom: true, smaa: true, lod: 1 },
  { name: 'Medium', maxPixelRatio: 1, scale: 0.85, shadows: true, shadowMap: 2048, bloom: true, smaa: true, lod: 0.8 },
  { name: 'Medium−', maxPixelRatio: 1, scale: 0.75, shadows: true, shadowMap: 1024, bloom: false, smaa: true, lod: 0.7 },
  { name: 'Low', maxPixelRatio: 1, scale: 0.7, shadows: false, shadowMap: 1024, bloom: false, smaa: true, lod: 0.6 },
  { name: 'Low−', maxPixelRatio: 1, scale: 0.6, shadows: false, shadowMap: 1024, bloom: false, smaa: true, lod: 0.6 },
  { name: 'Lowest', maxPixelRatio: 1, scale: 0.5, shadows: false, shadowMap: 1024, bloom: false, smaa: true, lod: 0.5 },
];
export const PRESET: Record<Quality, number> = { ultra: 0, high: 1, medium: 2, low: 4 };

/** What the levels are applied to (Game wires it). */
export interface GraphicsTargets {
  setPixelRatio(pr: number): void;
  setPost(bloom: boolean, smaa: boolean): void;
  setShadows(on: boolean, size: number): void;
  setLod(k: number): void;
}

const SETTING_KEY = 'scale.graphics', SCALE_KEY = 'scale.renderScale', LEARNED_KEY = 'scale.graphics.learned';

// Auto thresholds (ms). Below ~45 fps is too slow; GPU work under ~7 ms leaves room for a step up.
const SLOW_MS = 1000 / 45;
const UP_GPU_MS = 7;
const UP_FRAME_MS = 1000 / 55;
const WINDOW_S = 2;
const SETTLE_S = 4;

const median = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

export class Graphics {
  setting: QualitySetting;
  /** Render scale override (null: the level's own). */
  scaleOverride: number | null;
  /** The ladder rung in use. */
  step: number;
  readonly gpu: string;
  readonly timer: GpuTimer | null;
  private targets: GraphicsTargets | null = null;
  private shadowsApplied: boolean | null = null;
  /** Rungs auto had to leave this session (never tried again). */
  private failed = new Set<number>();
  private frames: number[] = [];
  private sims: number[] = [];
  private gpus: number[] = [];
  private winT = 0;
  private settle = SETTLE_S;
  private slowWins = 0;
  private fastWins = 0;
  /** Called after auto changed the level (the pause menu shows it). */
  onChange: ((level: GraphicsLevel, why: string) => void) | null = null;

  constructor(gl: THREE.WebGLRenderer, webgpu = false) {
    // (WebGPU: no WebGL context; the GPU timer comes later, see docs/WEBGPU_PLAN.md.)
    const ctx = webgpu ? null : gl.getContext();
    this.gpu = ctx ? gpuName(ctx) : 'WebGPU';
    this.timer = ctx ? GpuTimer.create(ctx) : null;
    this.setting = loadSetting();
    this.scaleOverride = loadScale();
    this.step = this.setting === 'auto' ? this.autoStart() : PRESET[this.setting];
    console.log(`[graphics] ${this.gpu || 'unknown GPU'} · ${this.setting === 'auto' ? `auto → ${this.level.name}` : this.level.name}${this.timer ? ' · GPU timer' : ''}`);
  }

  get level(): GraphicsLevel { return LADDER[this.step]; }
  get auto(): boolean { return this.setting === 'auto'; }

  /** Shadows the start-up level wants (before the warm-up compiles the shaders). */
  get startShadows(): boolean { return this.level.shadows; }

  attach(t: GraphicsTargets): void {
    this.targets = t;
    this.apply();
  }

  set(s: QualitySetting): void {
    this.setting = s;
    try { localStorage.setItem(SETTING_KEY, s); } catch { /* storage unavailable */ }
    this.failed.clear();
    this.step = s === 'auto' ? this.autoStart() : PRESET[s];
    this.apply();
  }

  setScale(v: number | null): void {
    this.scaleOverride = v;
    try { localStorage.setItem(SCALE_KEY, v === null ? 'auto' : String(v)); } catch { /* storage unavailable */ }
    this.apply();
  }

  /** Re-apply the pixel ratio (window resize, moved to another screen). */
  apply(): void {
    const t = this.targets;
    if (!t) return;
    const L = this.level;
    const dpr = window.devicePixelRatio || 1;
    t.setPixelRatio(this.scaleOverride !== null ? Math.min(dpr, 1.5) * this.scaleOverride : Math.min(dpr, L.maxPixelRatio) * L.scale);
    t.setPost(L.bloom, L.smaa);
    t.setShadows(L.shadows, L.shadowMap);
    t.setLod(L.lod);
    this.settle = SETTLE_S;
    this.frames.length = this.sims.length = this.gpus.length = 0;
    this.slowWins = this.fastWins = 0;
  }

  /** Wrap the scene render (GPU time when the timer extension is there). */
  render(fn: () => void): void {
    if (this.timer && this.auto) this.timer.measure(fn);
    else fn();
  }

  /**
   * One rendered frame: `frameMs` from the previous frame's start, `simMs` the CPU time of the
   * frame outside rendering.
   */
  frame(frameMs: number, simMs: number, paused: boolean): void {
    if (!this.auto || !this.targets) return;
    const g = this.timer?.poll();
    if (g !== undefined && g !== null) this.gpus.push(g);
    // Hidden tabs, hitches (streaming, compiles) and the pause menu are no measure of the GPU.
    if (document.hidden || paused || frameMs > 250) return;
    if (this.settle > 0) { this.settle -= frameMs / 1000; this.gpus.length = 0; return; }
    this.frames.push(frameMs);
    this.sims.push(simMs);
    this.winT += frameMs / 1000;
    if (this.winT < WINDOW_S) return;
    this.winT = 0;
    const f = median(this.frames), s = median(this.sims), gpu = this.gpus.length >= 10 ? median(this.gpus) : null;
    this.frames.length = this.sims.length = this.gpus.length = 0;
    // Slow and graphics-bound: by the GPU timer if there is one, else when most of the frame is
    // not simulation (rendering or waiting for the GPU).
    const slow = f > SLOW_MS && (gpu !== null ? gpu > 0.6 * f || gpu > 16 : s < 0.6 * f);
    const fast = gpu !== null && f < UP_FRAME_MS && gpu < UP_GPU_MS;
    this.slowWins = slow ? this.slowWins + 1 : 0;
    this.fastWins = fast ? this.fastWins + 1 : 0;
    if (this.slowWins >= 2 && this.step < LADDER.length - 1) {
      this.failed.add(this.step);
      this.move(this.step + 1, `${(1000 / f).toFixed(0)} fps${gpu !== null ? `, GPU ${gpu.toFixed(1)} ms` : ''}`);
    } else if (this.fastWins >= 8 && this.step > 0 && !this.failed.has(this.step - 1)) {
      this.move(this.step - 1, `GPU ${gpu!.toFixed(1)} ms per frame`);
    }
  }

  private move(step: number, why: string): void {
    this.step = step;
    this.learn();
    this.apply();
    console.log(`[graphics] auto → ${this.level.name} (${why})`);
    this.onChange?.(this.level, why);
  }

  /** Auto's first rung: what this GPU ended on last time, else a guess from its name. */
  private autoStart(): number {
    try {
      const o = JSON.parse(localStorage.getItem(LEARNED_KEY) ?? 'null') as { gpu?: string; step?: number } | null;
      if (o && o.gpu === this.gpu && typeof o.step === 'number' && o.step >= 0 && o.step < LADDER.length) return o.step;
    } catch { /* storage unavailable */ }
    return guessStep(this.gpu, screen.width * screen.height * (window.devicePixelRatio || 1) ** 2);
  }

  private learn(): void {
    try { localStorage.setItem(LEARNED_KEY, JSON.stringify({ gpu: this.gpu, step: this.step })); } catch { /* storage unavailable */ }
  }
}

/** The GPU's name ("ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 …)" → "NVIDIA GeForce RTX 4060 …"). */
export function gpuName(ctx: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = ctx.getExtension('WEBGL_debug_renderer_info');
    const raw = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
    const m = /^ANGLE \([^,]*,\s*(.*?)(?:\s+Direct3D.*|\s+\(0x[0-9a-f]+\).*|,.*)?\)$/i.exec(raw);
    return (m ? m[1] : raw).trim();
  } catch { return ''; }
}

/** First guess from the GPU's name and the screen's pixel count (the timer and frame rate correct it). */
export function guessStep(gpu: string, screenPixels: number): number {
  const g = gpu.toLowerCase();
  let step: number;
  if (!g) step = PRESET.high;
  else if (/swiftshader|llvmpipe|softpipe|basic render|software/.test(g)) step = LADDER.length - 1;
  else if (/rtx\s*[3-9]0[6-9]0|rx\s*[6-9][7-9]00|radeon pro w7|arc\s*a7|arc\s*b5|apple m\d (pro|max|ultra)/.test(g)) step = PRESET.ultra;
  else if (/rtx|gtx\s*10[6-9]0|gtx\s*16|rx\s*[5-9]\d{3}|radeon\s*rx|arc|apple m\d/.test(g)) step = PRESET.high;
  else if (/iris|radeon|vega|gtx|quadro|mx\s*\d|apple/.test(g)) step = PRESET.medium;
  else if (/intel|uhd|hd graphics|mali|adreno|powervr/.test(g)) step = PRESET.low;
  else step = PRESET.high;
  // 1440p and up: a rung down (more pixels for the same GPU), except at the top.
  if (screenPixels > 3.2e6 && step > 0 && step < PRESET.low) step++;
  return step;
}

/** GPU time per frame from EXT_disjoint_timer_query_webgl2 (WebGL2 only). */
class GpuTimer {
  private pending: WebGLQuery[] = [];
  private free: WebGLQuery[] = [];

  private constructor(private gl: WebGL2RenderingContext, private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }) {}

  static create(ctx: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer | null {
    if (typeof WebGL2RenderingContext === 'undefined' || !(ctx instanceof WebGL2RenderingContext)) return null;
    const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
    return ext ? new GpuTimer(ctx, ext) : null;
  }

  measure(fn: () => void): void {
    // Results come back a few frames later; do not pile up queries if they stop arriving.
    if (this.pending.length > 6) { fn(); return; }
    const gl = this.gl;
    const q = this.free.pop() ?? gl.createQuery();
    if (!q) { fn(); return; }
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    try { fn(); } finally { gl.endQuery(this.ext.TIME_ELAPSED_EXT); }
    this.pending.push(q);
  }

  /** The oldest finished measurement in ms (null: none ready; disjoint results are dropped). */
  poll(): number | null {
    const gl = this.gl;
    const q = this.pending[0];
    if (!q || !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return null;
    this.pending.shift();
    this.free.push(q);
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) return null;
    return (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
  }
}

function loadSetting(): QualitySetting {
  try { const s = localStorage.getItem(SETTING_KEY); if (s === 'low' || s === 'medium' || s === 'high' || s === 'ultra') return s; } catch { /* storage unavailable */ }
  return 'auto';
}

function loadScale(): number | null {
  try { const v = Number(localStorage.getItem(SCALE_KEY)); return Number.isFinite(v) && v >= 0.25 && v <= 2 ? v : null; } catch { return null; }
}
