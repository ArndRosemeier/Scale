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

  constructor() {
    try {
      const po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) this.longTasks.push({ t: e.startTime / 1000, ms: e.duration });
        if (this.longTasks.length > this.max) this.longTasks.splice(0, this.longTasks.length - this.max);
      });
      po.observe({ type: 'longtask', buffered: true });
    } catch { /* not supported */ }
  }

  private scene: THREE.Object3D | null = null;

  attach(renderer: THREE.WebGLRenderer, scene?: THREE.Object3D): void {
    this.renderer = renderer;
    this.scene = scene ?? null;
    this.snapshotRenderer();
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
        for (let k = 0; k < 2 && q; k++, q = q.parent) if (q.name) path = q.name + '/' + path;
        found.push(`${path}:${mat.type}${extra.includes(mat) ? '(depth)' : ''}`);
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
    this.sections = {};
    this.outside = {};
    this.notes.length = 0;
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

export const hitch = new HitchLogImpl();
(window as unknown as { hitches: HitchLogImpl }).hitches = hitch;
