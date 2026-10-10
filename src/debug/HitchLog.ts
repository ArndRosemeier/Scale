/**
 * Hitch log: finds frames whose main-thread work exceeds a budget and records
 * what caused them.
 *
 * Per frame it collects
 *  - the time of every subsystem section (Game.T),
 *  - work done between frames (worker result handlers etc.), wrapped with
 *    `hitch.measure()` — these are attributed to the next frame,
 *  - renderer deltas: new shader programs (compiles), geometries and
 *    textures (GPU uploads),
 *  - free-form events (`hitch.note`), e.g. "cell 123 ready (45k tris)".
 *
 * A PerformanceObserver adds browser long tasks (>50 ms) so work that nobody
 * measured still shows up. Console: `hitches.report()`, `hitches.list`,
 * `hitches.clear()`, `hitches.json()`.
 *
 * Freezes: once the game runs (`arm()`), any visible stretch of more than FREEZE_MS between two
 * frames is kept apart from the small hitches (never pushed out by them) with everything known
 * about it: the frame's sections, measured work between frames, the browser's long tasks and
 * long animation frames that overlap it (with the scripts Chrome blames), the JS heap before and
 * after (a big drop = garbage collection), and what the game was doing (`context`). The last
 * few are also kept in localStorage, so a freeze is still there after a reload. Shift+F9 saves
 * them to a file; console `hitches.freezes`.
 */
import type * as THREE from 'three';

export interface HitchRecord {
  /** Seconds since page load. */
  t: number;
  frame: number;
  /** Main-thread work attributed to the frame (ms). */
  work: number;
  /** Wall time since the previous frame (ms); meaningless in hidden tabs. */
  interval: number;
  sections: Record<string, number>;
  /** Work between frames (async handlers), by name. */
  outside: Record<string, number>;
  programs: number;
  /** Names of the shader programs created in this frame. */
  newPrograms: string[];
  geometries: number;
  textures: number;
  notes: string[];
}

/** A frame gap longer than this (ms) is a freeze. */
export const FREEZE_MS = 500;
const FREEZE_KEEP = 30;
const FREEZE_STORE = 'scale.freezes';
const FREEZE_STORED = 12;

export interface FreezeRecord {
  /** Local wall-clock time. */
  at: string;
  /** Seconds since page load. */
  t: number;
  /** Time between the end of the previous frame and the end of this one (ms). */
  ms: number;
  /** Main-thread work the game measured in it (frame sections + handlers between frames). */
  work: number;
  /** What nobody measured: GC, browser work, unmeasured handlers, GPU/driver waits (ms). */
  unmeasured: number;
  sections: Record<string, number>;
  outside: Record<string, number>;
  notes: string[];
  programs: number;
  newPrograms: string[];
  geometries: number;
  textures: number;
  /** JS heap (MB) at the previous frame and now; null where the browser hides it. */
  heapMB: [number, number] | null;
  /** Browser long tasks overlapping the freeze ([start s, ms]). */
  longTasks: [number, number][];
  /** Long animation frames (Chrome) overlapping it, with their blamed scripts. */
  loaf: string[];
  context: string;
  version: string;
  /**
   * Draws in this frame that used a program with vertex data or a render target it had never been
   * drawn with. The graphics driver may build a shader variant for such a first combination
   * (ANGLE on Direct3D does), inside the draw: a stall the game does not measure.
   */
  firstDraws?: string;
  /** Estimated GPU memory held and uploaded around the freeze (see watchMemory). */
  gpuMemory?: string;
}

interface Perf { memory?: { usedJSHeapSize: number } }

class HitchLogImpl {
  /** Frames above this much main-thread work are recorded (ms). */
  threshold = 30;
  readonly list: HitchRecord[] = [];
  readonly longTasks: { t: number; ms: number }[] = [];
  private max = 500;
  private frame = 0;
  private frameStart = 0;
  private lastFrameStart = 0;
  private sections: Record<string, number> = {};
  private outside: Record<string, number> = {};
  private notes: string[] = [];
  private renderer: THREE.WebGLRenderer | null = null;
  private lastPrograms = 0;
  private seenPrograms = new Set<unknown>();
  private programNames: string[] = [];
  private lastGeo = 0;
  private lastTex = 0;
  private inFrame = false;
  /** Totals over all frames (not only hitches), for the report. */
  private totals: Record<string, { ms: number; max: number; hitches: number }> = {};
  private frames = 0;
  private workSum = 0;

  /** Freezes of this session (newest last). */
  readonly freezes: FreezeRecord[] = [];
  /** Freezes from earlier sessions (localStorage), newest last. */
  readonly earlier: FreezeRecord[] = [];
  /** Freezes are recorded once this is set (after loading: loading has its own long frames). */
  armed = false;
  /** What the game is doing, for a freeze record (set by Game). */
  context: (() => string) | null = null;
  /** Has the shader gate checked this object with its current material? (set by Game) */
  gateKnows: ((o: THREE.Object3D) => boolean) | null = null;
  /** The shader gate's state for a freeze record: what it waits for, what it asked for lately. */
  gateState: (() => string) | null = null;
  /** Called after a freeze is recorded (the HUD hint). */
  onFreeze: ((f: FreezeRecord) => void) | null = null;
  version = '';
  private lastFrameEnd = 0;
  private lastHeap = 0;
  /** When the page last went hidden / became visible (performance.now ms). */
  private hiddenAt = -1;
  private visibleAt = -1;
  /** Freezes still collecting browser entries (those arrive a little later): [record, from, to]. */
  private open: [FreezeRecord, number, number][] = [];
  private loafs: { start: number; ms: number; text: string }[] = [];

  constructor() {
    if (typeof window === 'undefined') return;
    try {
      const po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          this.longTasks.push({ t: e.startTime / 1000, ms: e.duration });
          this.attachEntry(e.startTime, e.duration, (f) => f.longTasks.push([+(e.startTime / 1000).toFixed(2), Math.round(e.duration)]));
        }
        if (this.longTasks.length > this.max) this.longTasks.splice(0, this.longTasks.length - this.max);
      });
      po.observe({ type: 'longtask', buffered: true });
    } catch { /* not supported */ }
    try {
      // Long animation frames (Chrome 123+): which scripts ran in a slow frame, and how long the
      // frame spent on style/layout and rendering. Only the long ones are kept.
      const po = new PerformanceObserver((l) => {
        for (const e of l.getEntries() as unknown as LoafEntry[]) {
          if (e.duration < 150) continue;
          const text = loafText(e);
          this.loafs.push({ start: e.startTime, ms: e.duration, text });
          if (this.loafs.length > 40) this.loafs.shift();
          this.attachEntry(e.startTime, e.duration, (f) => { if (f.loaf.length < 8) f.loaf.push(text); });
        }
      });
      po.observe({ type: 'long-animation-frame', buffered: false });
    } catch { /* not supported */ }
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.hiddenAt = performance.now(); else this.visibleAt = performance.now(); });
    try {
      const old = JSON.parse(localStorage.getItem(FREEZE_STORE) ?? '[]') as FreezeRecord[];
      if (Array.isArray(old)) this.earlier.push(...old.slice(-FREEZE_STORED));
    } catch { /* storage blocked */ }
  }

  /** Hands a browser entry to the open freezes it overlaps. */
  private attachEntry(start: number, ms: number, add: (f: FreezeRecord) => void): void {
    for (const [f, a, b] of this.open) if (start < b && start + ms > a) add(f);
  }

  /** Start recording freezes (the game is loaded and running). */
  arm(): void {
    // (lastFrameEnd stays: the very first frame of play is measured from the last warm-up frame;
    // resetting it here hid a 9 s freeze in that frame.)
    this.armed = true;
  }

  private scene: THREE.Object3D | null = null;

  attach(renderer: THREE.WebGLRenderer, scene?: THREE.Object3D): void {
    this.renderer = renderer;
    this.scene = scene ?? null;
    this.snapshotRenderer();
    this.watchDraws(renderer);
    this.watchMemory(renderer);
  }

  /** Estimated GPU memory (bytes) in buffers, textures and render targets, and uploads per frame. */
  private gpu = { buffers: 0, textures: 0, targets: 0, upload: 0, prevUpload: 0 };

  /**
   * Keeps a running estimate of what the game holds in GPU memory and how much it uploads per
   * frame, from the WebGL calls that allocate and fill it. When graphics memory runs over, the
   * driver pages it in and out: seconds where the GPU process is busy and the game waits.
   */
  private watchMemory(renderer: THREE.WebGLRenderer): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return;
    const G = this.gpu;
    const bound = new Map<number, WebGLBuffer | null>();
    const bufSize = new WeakMap<WebGLBuffer, number>();
    const texSize = new WeakMap<WebGLTexture, number>();
    const rbSize = new WeakMap<WebGLRenderbuffer, number>();
    const texBound = new Map<number, WebGLTexture | null>();
    let rb: WebGLRenderbuffer | null = null;
    const bpp = (fmt: number): number => {
      switch (fmt) {
        case gl.R8: case gl.ALPHA: case gl.LUMINANCE: case gl.R8UI: return 1;
        case gl.RG8: case gl.R16F: case gl.LUMINANCE_ALPHA: case gl.DEPTH_COMPONENT16: return 2;
        case gl.RGBA16F: case gl.RG32F: return 8;
        case gl.RGBA32F: return 16;
        case gl.RGB16F: return 6;
        case gl.RGB32F: return 12;
        default: return 4;
      }
    };
    const setTex = (target: number, bytes: number, add = false) => {
      const key = target >= gl.TEXTURE_CUBE_MAP_POSITIVE_X && target <= gl.TEXTURE_CUBE_MAP_NEGATIVE_Z ? gl.TEXTURE_CUBE_MAP : target;
      const t = texBound.get(key);
      if (!t) return;
      const old = texSize.get(t) ?? 0, now = add ? old + bytes : bytes;
      texSize.set(t, now);
      G.textures += now - old;
    };
    const srcSize = (src: unknown): [number, number] => {
      const o = src as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | null;
      return o ? [o.videoWidth || o.width || 0, o.videoHeight || o.height || 0] : [0, 0];
    };
    const wrap = <K extends keyof WebGL2RenderingContext>(name: K, before: (...a: never[]) => void) => {
      const orig = (gl[name] as unknown as (...a: unknown[]) => unknown).bind(gl);
      (gl as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => { try { (before as (...x: unknown[]) => void)(...a); } catch { /* diagnostics only */ } return orig(...a); };
    };
    wrap('bindBuffer', (target: number, b: WebGLBuffer | null) => { bound.set(target, b); });
    wrap('bufferData', (target: number, data: number | ArrayBufferView | ArrayBuffer | null, _usage: number, srcOffset?: number, length?: number) => {
      const b = bound.get(target);
      if (!b) return;
      let n = typeof data === 'number' ? data : data ? data.byteLength : 0;
      if (data && typeof data !== 'number' && ArrayBuffer.isView(data) && length) n = length * ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
      else if (data && typeof data !== 'number' && ArrayBuffer.isView(data) && srcOffset) n -= srcOffset * ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
      G.buffers += n - (bufSize.get(b) ?? 0);
      bufSize.set(b, n);
      if (typeof data !== 'number') G.upload += n;
    });
    wrap('bufferSubData', (_t: number, _o: number, data: ArrayBufferView, _so?: number, length?: number) => {
      G.upload += length ? length * ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) : data.byteLength;
    });
    wrap('deleteBuffer', (b: WebGLBuffer | null) => { if (b) { G.buffers -= bufSize.get(b) ?? 0; bufSize.delete(b); } });
    wrap('bindTexture', (target: number, t: WebGLTexture | null) => { texBound.set(target, t); });
    wrap('texStorage2D', (target: number, levels: number, fmt: number, w: number, h: number) => {
      const faces = target === gl.TEXTURE_CUBE_MAP ? 6 : 1;
      setTex(target, w * h * bpp(fmt) * faces * (levels > 1 ? 4 / 3 : 1));
    });
    wrap('texStorage3D', (target: number, levels: number, fmt: number, w: number, h: number, d: number) => {
      setTex(target, w * h * d * bpp(fmt) * (levels > 1 ? 4 / 3 : 1));
    });
    wrap('texImage2D', (target: number, level: number, fmt: number, ...rest: unknown[]) => {
      if (level !== 0) return;
      const [w, h] = typeof rest[0] === 'number' && typeof rest[1] === 'number' ? [rest[0] as number, rest[1] as number] : srcSize(rest[2]);
      const cube = target >= gl.TEXTURE_CUBE_MAP_POSITIVE_X && target <= gl.TEXTURE_CUBE_MAP_NEGATIVE_Z;
      const bytes = w * h * bpp(fmt);
      setTex(target, bytes, cube && target !== gl.TEXTURE_CUBE_MAP_POSITIVE_X); // (cube faces add up)
      if (!(typeof rest[0] === 'number' && rest[5] == null)) G.upload += bytes; // (no pixels: a render target)
    });
    wrap('texImage3D', (target: number, level: number, fmt: number, w: number, h: number, d: number) => {
      if (level !== 0) return;
      setTex(target, w * h * d * bpp(fmt));
      G.upload += w * h * d * bpp(fmt);
    });
    wrap('texSubImage2D', (_t: number, _l: number, _x: number, _y: number, ...rest: unknown[]) => {
      const [w, h] = typeof rest[0] === 'number' && typeof rest[1] === 'number' ? [rest[0] as number, rest[1] as number] : srcSize(rest[2]);
      G.upload += w * h * 4;
    });
    wrap('texSubImage3D', (_t: number, _l: number, _x: number, _y: number, _z: number, w: number, h: number, d: number) => { G.upload += w * h * d * 4; });
    wrap('deleteTexture', (t: WebGLTexture | null) => { if (t) { G.textures -= texSize.get(t) ?? 0; texSize.delete(t); } });
    wrap('bindRenderbuffer', (_t: number, r: WebGLRenderbuffer | null) => { rb = r; });
    const rbStore = (samples: number, fmt: number, w: number, h: number) => {
      if (!rb) return;
      const n = w * h * bpp(fmt) * Math.max(1, samples);
      G.targets += n - (rbSize.get(rb) ?? 0);
      rbSize.set(rb, n);
    };
    wrap('renderbufferStorage', (_t: number, fmt: number, w: number, h: number) => rbStore(1, fmt, w, h));
    wrap('renderbufferStorageMultisample', (_t: number, samples: number, fmt: number, w: number, h: number) => rbStore(samples, fmt, w, h));
    wrap('deleteRenderbuffer', (r: WebGLRenderbuffer | null) => { if (r) { G.targets -= rbSize.get(r) ?? 0; rbSize.delete(r); } });
  }

  /** The GPU memory line for a freeze record; starts the next frame's upload count. */
  private takeMemory(): string {
    const G = this.gpu, MB = 1048576;
    const text = `GPU memory ≈ ${Math.round((G.buffers + G.textures + G.targets) / MB)} MB (buffers ${Math.round(G.buffers / MB)}, textures ${Math.round(G.textures / MB)}, render targets ${Math.round(G.targets / MB)}); uploaded ${(G.upload / MB).toFixed(1)} MB this frame, ${(G.prevUpload / MB).toFixed(1)} MB the frame before`;
    G.prevUpload = G.upload;
    G.upload = 0;
    return text;
  }

  /** First draws of this frame: [new program × vertex data, new program × target, draws, programs]. */
  private prevDraws = '';
  private draws = { pairs: 0, targets: 0, calls: 0, progs: new Set<WebGLProgram>() };

  /**
   * Counts draws that use a program with vertex data (VAO) or a render target for the first time
   * (see FreezeRecord.firstDraws). A map lookup per draw call.
   */
  private watchDraws(renderer: THREE.WebGLRenderer): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return;
    let prog: WebGLProgram | null = null, vao: WebGLVertexArrayObject | null = null, fb: WebGLFramebuffer | null = null;
    const seen = new WeakMap<WebGLProgram, { vaos: WeakSet<object>; fbs: WeakSet<object>; screen: boolean; n: number }>();
    const SCREEN = {};
    const D = this.draws;
    const note = () => {
      D.calls++;
      if (!prog) return;
      let e = seen.get(prog);
      if (!e) seen.set(prog, (e = { vaos: new WeakSet(), fbs: new WeakSet(), screen: false, n: 0 }));
      const v = vao ?? SCREEN;
      // (A program drawn with fresh vertex data all the time, e.g. a geometry rebuilt every frame,
      // stops counting after 50: it would hide the rare first draws.)
      if (e.n < 50 && !e.vaos.has(v)) { e.vaos.add(v); e.n++; D.pairs++; D.progs.add(prog); }
      if (fb ? !e.fbs.has(fb) : !e.screen) { if (fb) e.fbs.add(fb); else e.screen = true; D.targets++; D.progs.add(prog); }
    };
    const use = gl.useProgram.bind(gl), bindVao = gl.bindVertexArray.bind(gl), bindFb = gl.bindFramebuffer.bind(gl);
    gl.useProgram = (p) => { prog = p; use(p); };
    gl.bindVertexArray = (a) => { vao = a; bindVao(a); };
    gl.bindFramebuffer = (t, f) => { if (t === gl.FRAMEBUFFER || t === gl.DRAW_FRAMEBUFFER) fb = f; bindFb(t, f); };
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'] as const) {
      const orig = (gl[name] as (...a: unknown[]) => void).bind(gl);
      (gl as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => { note(); orig(...a); };
    }
  }

  /** The first-draw line for a freeze record, and reset for the next frame. */
  private takeDraws(): string {
    const D = this.draws;
    let text = '';
    if (D.calls) {
      const names: string[] = [];
      const progs = (this.renderer?.info.programs ?? []) as unknown as { name: string; program: WebGLProgram }[];
      for (const p of progs) if (D.progs.has(p.program) && names.length < 6) names.push(p.name || this.whoUses(p as never) || '?');
      text = `${D.pairs} new program×geometry, ${D.targets} new program×target, ${D.calls} draws${names.length ? ': ' + names.join(', ') : ''}`;
    }
    D.pairs = 0; D.targets = 0; D.calls = 0; D.progs.clear();
    return text;
  }

  private snapshotRenderer(): [number, number, number] {
    const r = this.renderer;
    if (!r) return [0, 0, 0];
    const progs = (r.info.programs ?? []) as unknown as { name: string; cacheKey: string; id: number }[];
    this.programNames = [];
    for (const pr of progs) if (!this.seenPrograms.has(pr)) {
      // What made this a new program? Diff its cache key against a sibling of the same shader.
      let why = 'first';
      const a = pr.cacheKey.split(',');
      let sib: { cacheKey: string } | null = null, best = Infinity;
      for (const o of progs) {
        if (o === pr || !this.seenPrograms.has(o)) continue;
        const b = o.cacheKey.split(',');
        if (b[0] !== a[0] || b.length !== a.length) continue;
        let n = 0;
        for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) n++;
        if (n < best) { best = n; sib = o; }
      }
      if (sib) {
        const b = sib.cacheKey.split(',');
        const d: string[] = [];
        for (let k = 0; k < Math.max(a.length, b.length) && d.length < 6; k++) if (a[k] !== b[k]) d.push(`@${k}:${b[k]}→${a[k]}`);
        why = d.join(' ');
      }
      this.seenPrograms.add(pr);
      this.programNames.push(`${pr.name || this.whoUses(pr)}#${pr.id} ${why}`);
    }
    const p = progs.length, g = r.info.memory.geometries, tx = r.info.memory.textures;
    const d: [number, number, number] = [p - this.lastPrograms, g - this.lastGeo, tx - this.lastTex];
    this.lastPrograms = p; this.lastGeo = g; this.lastTex = tx;
    return d;
  }

  /** Which scene objects use this program (path of names + material type). */
  private whoUses(pr: unknown): string {
    const r = this.renderer, sc = this.scene;
    if (!r || !sc) return '?';
    const props = (r as unknown as { properties: { get(o: object): { currentProgram?: unknown; programs?: Map<string, unknown> } } }).properties;
    const found: string[] = [];
    sc.traverse((o) => {
      if (found.length >= 2) return;
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const mats = m ? (Array.isArray(m) ? m : [m]) : [];
      const extra = [(o as THREE.Mesh).customDepthMaterial].filter(Boolean) as THREE.Material[];
      for (const mat of [...mats, ...extra]) {
        const p = props.get(mat);
        let hit = p.currentProgram === pr;
        if (!hit && p.programs) for (const v of p.programs.values()) if (v === pr) hit = true;
        if (!hit) continue;
        let path = o.name || o.type, q = o.parent;
        for (let k = 0; k < 4 && q; k++, q = q.parent) if (q.name) path = q.name + '/' + path;
        // (Whether the shader gate had looked at this mesh: a program it never asked for was
        // compiled while drawing.)
        const gate = this.gateKnows ? (this.gateKnows(o) ? ' gate:seen' : ' gate:NEVER') : '';
        found.push(`${path}:${mat.type}${extra.includes(mat) ? '(depth)' : ''}${mat.side === 2 ? ' double' : mat.side === 1 ? ' back' : ''}${gate}`);
        break;
      }
    });
    return found.join('+') || 'shadow/depth?';
  }

  beginFrame(): void {
    this.frame++;
    this.lastFrameStart = this.frameStart;
    this.frameStart = performance.now();
    this.inFrame = true;
  }

  /** Time of a named section inside the frame (Game.T). */
  section(name: string, ms: number): void {
    this.sections[name] = (this.sections[name] ?? 0) + ms;
  }

  /** Measure work anywhere; outside a frame it is attributed to the next one. */
  measure<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    try { return fn(); } finally {
      const ms = performance.now() - t0;
      if (this.inFrame) this.section(name, ms);
      else this.outside[name] = (this.outside[name] ?? 0) + ms;
    }
  }

  note(text: string): void {
    if (this.notes.length < 40) this.notes.push(text);
  }

  endFrame(): void {
    this.inFrame = false;
    const now = performance.now();
    const inside = now - this.frameStart;
    let out = 0;
    for (const v of Object.values(this.outside)) out += v;
    const work = inside + out;
    let tracked = 0;
    for (const v of Object.values(this.sections)) tracked += v;
    if (inside - tracked > 0.5) this.sections['(untracked)'] = inside - tracked;
    const [dp, dg, dt] = this.snapshotRenderer();
    this.frames++;
    this.workSum += work;
    const hitch = work > this.threshold;
    const all = { ...this.sections };
    for (const [k, v] of Object.entries(this.outside)) all['~' + k] = v;
    for (const [k, v] of Object.entries(all)) {
      const T = this.totals[k] ?? (this.totals[k] = { ms: 0, max: 0, hitches: 0 });
      T.ms += v; T.max = Math.max(T.max, v);
    }
    if (hitch) {
      // Blame: the largest contributor gets the hitch count.
      let top = '', topMs = -1;
      for (const [k, v] of Object.entries(all)) if (v > topMs) { top = k; topMs = v; }
      if (top) this.totals[top].hitches++;
      const sorted: Record<string, number> = {};
      for (const [k, v] of Object.entries(this.sections).sort((a, b) => b[1] - a[1])) if (v >= 0.5) sorted[k] = +v.toFixed(1);
      const outs: Record<string, number> = {};
      for (const [k, v] of Object.entries(this.outside).sort((a, b) => b[1] - a[1])) if (v >= 0.5) outs[k] = +v.toFixed(1);
      this.list.push({
        t: +(this.frameStart / 1000).toFixed(2), frame: this.frame, work: +work.toFixed(1),
        interval: +(this.frameStart - this.lastFrameStart).toFixed(1),
        sections: sorted, outside: outs, programs: dp, newPrograms: this.programNames.slice(0, 12), geometries: dg, textures: dt, notes: this.notes.slice(),
      });
      if (this.list.length > this.max) this.list.shift();
    }
    // A stall in the GPU process shows as a late next frame, so the frame before counts too.
    const draws = this.takeDraws();
    const memory = this.takeMemory();
    this.checkFreeze(now, work, all, dp, dg, dt, `this frame: ${draws || 'none'} · frame before: ${this.prevDraws || 'none'}`, memory);
    this.prevDraws = draws;
    this.sections = {};
    this.outside = {};
    this.notes.length = 0;
  }

  private checkFreeze(now: number, work: number, all: Record<string, number>, dp: number, dg: number, dt: number, draws: string, memory: string): void {
    const heap = (performance as unknown as Perf).memory?.usedJSHeapSize ?? 0;
    const prevEnd = this.lastFrameEnd, prevHeap = this.lastHeap;
    this.lastFrameEnd = now;
    this.lastHeap = heap;
    // Close freezes whose browser entries have had time to arrive.
    if (this.open.length) {
      const keep = this.open.filter(([, , b]) => now - b < 3000);
      if (keep.length !== this.open.length) { this.open = keep; this.store(); }
    }
    if (!this.armed || !prevEnd || document.hidden) return;
    // Only the visible part counts: going hidden in between (tab switched, minimised) is no
    // freeze, but a long frame right after the page became visible again is one.
    if (this.hiddenAt > prevEnd - 50) return;
    const ms = now - Math.max(prevEnd, this.visibleAt);
    if (ms < FREEZE_MS) return;
    const top = (o: Record<string, number>, n: number) => {
      const r: Record<string, number> = {};
      for (const [k, v] of Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)) if (v >= 1) r[k] = Math.round(v);
      return r;
    };
    const outside: Record<string, number> = {};
    const sections: Record<string, number> = {};
    for (const [k, v] of Object.entries(all)) (k.startsWith('~') ? outside : sections)[k.replace(/^~/, '')] = v;
    let context = '';
    try { context = this.context?.() ?? ''; } catch (e) { context = 'context failed: ' + String(e); }
    try { if (this.gateState) context += ' · ' + this.gateState(); } catch { /* diagnostics */ }
    const f: FreezeRecord = {
      at: new Date().toLocaleString(), t: +(now / 1000).toFixed(1), ms: Math.round(ms), work: Math.round(work),
      unmeasured: Math.max(0, Math.round(ms - work)), sections: top(sections, 8), outside: top(outside, 6), notes: this.notes.slice(0, 12),
      programs: dp, newPrograms: this.programNames.slice(0, 6), geometries: dg, textures: dt,
      heapMB: heap && prevHeap ? [Math.round(prevHeap / 1048576), Math.round(heap / 1048576)] : null,
      longTasks: [], loaf: [], context, version: this.version, firstDraws: draws, gpuMemory: memory,
    };
    // Entries that arrived already (an observer can run before this frame ends).
    for (const e of this.longTasks) if (e.t * 1000 < now && (e.t * 1000 + e.ms) > prevEnd) f.longTasks.push([+e.t.toFixed(2), Math.round(e.ms)]);
    for (const e of this.loafs) if (e.start < now && e.start + e.ms > prevEnd && f.loaf.length < 8) f.loaf.push(e.text);
    this.freezes.push(f);
    if (this.freezes.length > FREEZE_KEEP) this.freezes.shift();
    this.open.push([f, prevEnd, now]);
    this.store();
    console.warn(`[freeze] ${f.ms} ms (measured work ${f.work} ms)`, f);
    try { this.onFreeze?.(f); } catch { /* HUD */ }
  }

  /** Keeps the newest freezes (earlier sessions + this one) in localStorage. */
  private store(): void {
    try { localStorage.setItem(FREEZE_STORE, JSON.stringify([...this.earlier, ...this.freezes].slice(-FREEZE_STORED))); } catch { /* full or blocked */ }
  }

  /** Everything for a bug report: freezes (this and earlier sessions), worst hitches, totals. */
  freezeReport(env: Record<string, unknown> = {}): string {
    const totals = Object.entries(this.totals).map(([k, v]) => ({ section: k, hitchesBlamed: v.hitches, maxMs: Math.round(v.max), avgMs: +(v.ms / Math.max(1, this.frames)).toFixed(2) }))
      .sort((a, b) => b.hitchesBlamed - a.hitchesBlamed || b.maxMs - a.maxMs).slice(0, 30);
    return JSON.stringify({
      saved: new Date().toLocaleString(), version: this.version, ...env,
      thisSession: this.freezes, earlierSessions: this.earlier,
      worstHitches: this.list.slice().sort((a, b) => b.work - a.work).slice(0, 15),
      frames: this.frames, avgWorkMs: +(this.workSum / Math.max(1, this.frames)).toFixed(1), totals,
    }, null, 1);
  }

  /** Human-readable summary in the console; returns the table rows. */
  report(): unknown {
    const rows = Object.entries(this.totals)
      .map(([k, v]) => ({ section: k, hitchesBlamed: v.hitches, maxMs: +v.max.toFixed(1), avgMs: +(v.ms / Math.max(1, this.frames)).toFixed(2) }))
      .sort((a, b) => b.hitchesBlamed - a.hitchesBlamed || b.maxMs - a.maxMs);
    console.log(`[hitch] ${this.list.length} hitches (> ${this.threshold} ms work) in ${this.frames} frames, avg work ${(this.workSum / Math.max(1, this.frames)).toFixed(1)} ms; long tasks: ${this.longTasks.length}`);
    console.table(rows);
    const compiles = this.list.filter((h) => h.programs > 0);
    if (compiles.length) console.log(`[hitch] ${compiles.length} hitches compiled shaders (${compiles.reduce((s, h) => s + h.programs, 0)} programs)`);
    const gate = (window as unknown as { shaderGate?: { stats: { checked: number; passed: number; standins: number; hidden: number; swapped: number; late: { what: string; ms: number }[] } } }).shaderGate;
    if (gate) {
      const g = gate.stats;
      console.log(`[gate] ${g.checked} material uses checked: ${g.passed} ready, ${g.standins} via stand-in, ${g.hidden} hidden until ready, ${g.swapped} swapped back`);
      if (g.late.length) console.table(g.late.slice(-30));
    }
    console.log('[hitch] worst frames:', this.list.slice().sort((a, b) => b.work - a.work).slice(0, 10));
    return rows;
  }

  json(): string { return JSON.stringify({ hitches: this.list, longTasks: this.longTasks, totals: this.totals, frames: this.frames }); }

  clear(): void {
    this.list.length = 0; this.longTasks.length = 0; this.totals = {}; this.frames = 0; this.workSum = 0;
  }
}

interface LoafScript { invoker?: string; sourceURL?: string; sourceFunctionName?: string; duration: number; forcedStyleAndLayoutDuration?: number }
interface LoafEntry { startTime: number; duration: number; renderStart?: number; styleAndLayoutStart?: number; blockingDuration?: number; scripts?: LoafScript[] }

/** A long animation frame in one line: its length, script time by script, render/layout time. */
function loafText(e: LoafEntry): string {
  const scripts = (e.scripts ?? []).slice().sort((a, b) => b.duration - a.duration).slice(0, 4).map((s) => {
    const file = (s.sourceURL ?? '').split('/').pop()?.split('?')[0] ?? '';
    return `${Math.round(s.duration)} ms ${s.invoker ?? '?'}${s.sourceFunctionName ? ' ' + s.sourceFunctionName : ''}${file ? ' @' + file : ''}${s.forcedStyleAndLayoutDuration ? ` (layout ${Math.round(s.forcedStyleAndLayoutDuration)})` : ''}`;
  });
  let scriptMs = 0;
  for (const s of e.scripts ?? []) scriptMs += s.duration;
  const render = e.renderStart ? Math.round(e.startTime + e.duration - e.renderStart) : 0;
  return `${Math.round(e.duration)} ms frame at ${(e.startTime / 1000).toFixed(2)} s: scripts ${Math.round(scriptMs)} ms, render+layout ${render} ms, other ${Math.max(0, Math.round(e.duration - scriptMs - render))} ms${scripts.length ? ' | ' + scripts.join('; ') : ''}`;
}

export const hitch = new HitchLogImpl();
if (typeof window !== 'undefined') (window as unknown as { hitches: HitchLogImpl }).hitches = hitch;
