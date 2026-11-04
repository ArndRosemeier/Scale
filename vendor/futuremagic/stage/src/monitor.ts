/**
 * Shader monitor (see the game's docs/SHADERS.md): records every shader build and how long it blocked the main
 * thread, and checks the policy: under 100 ms each, and after warm-up builds take at most a third of the time, spread
 * evenly: after a build of t ms, the next starts no sooner than 2t ms after it ended (the cap, cap.ts). It also names
 * shaders built again with the same code (`repeats`), the usual reason stalls come back. `window.shaders.report()` in the console; a game shows `stage.hudLine()` in its HUD or debug menu. From Dunfinity src/render/shaders/monitor.ts.
 */
export type Phase = 'warmup' | 'run';
/** `node-late`: a draw skipped until a frame with room under the cap to build its shader (patches.ts `deferLateBuilds`). */
export type BuildKind = 'node-sync' | 'node-async' | 'node-late' | 'gpu-module' | 'gpu-pipeline-sync' | 'gpu-pipeline-async' | 'gl-link';

/** `code`: a hash of the shader code a node build made (`codeHash`), to find the same shader built again. */
export interface ShaderEvent { t: number; kind: BuildKind; ms: number; what: string; phase: Phase; code?: number }

/** The same shader code built more than once, one of them after warm-up (`ShaderMonitor.repeats`). */
export interface Repeat { what: string; times: number; after: number; ms: number }

/** A hash of shader code (FNV-1a, 32 bit): equal code, equal hash. */
export function codeHash(...parts: (string | null | undefined)[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    if (!part) continue;
    for (let i = 0; i < part.length; i++) { h ^= part.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0xff; h = Math.imul(h, 0x01000193); // between the parts
  }
  return h >>> 0;
}

/** Which kinds stall the main thread while they run (the async ones yield or run off-thread). */
const BLOCKING: ReadonlySet<BuildKind> = new Set(['node-sync', 'gpu-module', 'gpu-pipeline-sync', 'gl-link']);
/** Which kinds start a new shader (counted against the cap). */
const STARTS: ReadonlySet<BuildKind> = new Set(['node-sync', 'node-async']);

export class ShaderMonitor {
  readonly budgetMs = 100;
  /** The most of any stretch of time that builds may take after warm-up (as the cap's `share`). */
  readonly share = 1 / 3;
  phase: Phase = 'warmup';
  /** Why the render path builds right now, if on purpose (appended to what synchronous builds record), e.g. the Stage's shadow warm-up. */
  note = '';
  readonly events: ShaderEvent[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  record(kind: BuildKind, ms: number, what: string, t = this.now() - ms, code?: number): void {
    // The note says why the render path builds: it marks synchronous builds only.
    const e: ShaderEvent = { t, kind, ms, what: this.note && kind === 'node-sync' ? `${what} (${this.note})` : what, phase: this.phase };
    if (code !== undefined) e.code = code;
    this.events.push(e);
  }

  /** Time a synchronous piece of work as one event; `codeOf` hashes the shader it made, if any. */
  time<T>(kind: BuildKind, what: string, fn: () => T, codeOf?: (made: T) => number | undefined): T {
    const t0 = this.now();
    let made: T | undefined, done = false;
    try { made = fn(); done = true; return made; } finally { this.record(kind, this.now() - t0, what, t0, done && codeOf ? codeOf(made as T) : undefined); }
  }

  /**
   * Shaders built more than once with the same code, at least once after warm-up, the costliest after warm-up first.
   * Each repeat is work a shared material or node would have saved: the same kind of thing (a person, a tile, a
   * plant) building its shader again for every copy, which is how stalls keep coming back. The policy does not fail
   * on them; the report names them.
   */
  repeats(): Repeat[] {
    const by = new Map<number, ShaderEvent[]>();
    for (const e of this.events) if (e.code !== undefined) { const list = by.get(e.code); if (list) list.push(e); else by.set(e.code, [e]); }
    const out: Repeat[] = [];
    for (const list of by.values()) {
      const after = list.filter((e) => e.phase === 'run');
      if (list.length < 2 || !after.length) continue;
      out.push({ what: after[0].what, times: list.length, after: after.length, ms: after.reduce((n, e) => n + e.ms, 0) });
    }
    return out.sort((a, b) => b.ms - a.ms);
  }

  /** Policy breaches, one line each (empty: the policy holds). */
  violations(): string[] {
    const out: string[] = [];
    for (const e of this.events) {
      if (BLOCKING.has(e.kind) && e.ms > this.budgetMs) out.push(`${e.phase}: ${e.kind} "${e.what}" blocked ${e.ms.toFixed(0)} ms (budget ${this.budgetMs} ms)`);
    }
    const starts = this.events.filter((e) => e.phase === 'run' && STARTS.has(e.kind)).sort((a, b) => a.t - b.t);
    const rest = 1 / this.share - 1;
    for (let i = 1; i < starts.length; i++) {
      const a = starts[i - 1], b = starts[i], earliest = a.t + a.ms + a.ms * rest;
      if (b.t < earliest - 1) out.push(`run: "${b.what}" (${b.kind}) started ${(b.t - a.t - a.ms).toFixed(0)} ms after a build of ${a.ms.toFixed(0)} ms ended (minimum ${(a.ms * rest).toFixed(0)} ms): "${a.what}" (${a.kind})`);
    }
    return out;
  }

  summary(): { warmup: number; run: number; late: number; worstMs: number; violations: number; repeats: number } {
    const blocking = this.events.filter((e) => BLOCKING.has(e.kind));
    return {
      warmup: this.events.filter((e) => e.phase === 'warmup' && STARTS.has(e.kind)).length,
      run: this.events.filter((e) => e.phase === 'run' && STARTS.has(e.kind)).length,
      late: this.events.filter((e) => e.kind === 'node-late').length,
      worstMs: blocking.reduce((m, e) => Math.max(m, e.ms), 0),
      violations: this.violations().length,
      repeats: this.repeats().length,
    };
  }

  report(): string {
    const s = this.summary();
    const repeats = this.repeats().map((r) => `built ${r.times}× alike (${r.after} after warm-up, ${r.ms.toFixed(0)} ms): ${r.what}`);
    return [`shaders: ${s.warmup} built in warm-up, ${s.run} after (${s.late} drawn late), worst block ${s.worstMs.toFixed(0)} ms, ${s.violations} violations, ${s.repeats} built again alike`, ...this.violations(), ...repeats].join('\n');
  }
}
