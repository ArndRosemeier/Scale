/**
 * Shader counter (Shift+F11, off by default): a small box showing how many shaders were compiled
 * in the last 10 seconds, to get a feel for when compiles happen and whether they line up with
 * hitches. Also shows the longest frame of those 10 seconds.
 *
 * WebGL: new programs in three's renderer.info.programs. WebGPU: three's node shader builds (the
 * main-thread part) and the GPU pipelines created (webgpu/index.ts counts both). Also shows the
 * shader cap (render/shaderCap.ts): its limit, what started in the last second, what waits for it.
 */
import type * as THREE from 'three';
import { shaderCap } from '../render/shaderCap';
import { hitch } from './HitchLog';

const WINDOW_MS = 10000;

interface GpuCounts { count: number; syncPipes: number; asyncPipes: number }

export class ShaderCounter {
  private el: HTMLDivElement | null = null;
  private on = false;
  private seen = new WeakSet<object>();
  /** [time, shaders, pipelines] per frame that compiled something. */
  private events: [number, number, number][] = [];
  private frames: [number, number][] = [];
  private last = 0;
  private lastGpu: GpuCounts | null = null;
  private shown = 0;

  constructor(private gl: THREE.WebGLRenderer, private webgpu: boolean) {
    // (F11 itself is the browser's full screen; Shift+F11 is free. Capture phase: nothing else sees it.)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F11' && e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); this.toggle(); }
    }, true);
    // Counting runs all the time (cheap), so the window is already full when it is switched on.
    this.prime();
    const tick = (t: number): void => { this.sample(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  toggle(on = !this.on): void {
    this.on = on;
    if (on && !this.el) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:9000;pointer-events:none;'
        + 'font:12px/1.35 ui-monospace,Consolas,monospace;color:#e8f0ff;background:rgba(10,14,22,0.72);padding:4px 10px;border-radius:4px;white-space:pre;text-align:center';
      document.body.appendChild(el);
      this.el = el;
    }
    if (this.el) this.el.style.display = on ? '' : 'none';
    this.shown = 0;
  }

  private prime(): void {
    if (this.webgpu) this.lastGpu = this.gpuCounts();
    else for (const p of this.programs()) this.seen.add(p);
  }

  private programs(): object[] {
    return ((this.gl.info as unknown as { programs?: object[] }).programs ?? []);
  }

  private gpuCounts(): GpuCounts | null {
    const n = (window as unknown as { nodeBuilds?: GpuCounts }).nodeBuilds;
    return n ? { count: n.count, syncPipes: n.syncPipes, asyncPipes: n.asyncPipes } : null;
  }

  private sample(t: number): void {
    let shaders = 0, pipes = 0;
    if (this.webgpu) {
      const g = this.gpuCounts();
      if (g && this.lastGpu) { shaders = g.count - this.lastGpu.count; pipes = g.syncPipes + g.asyncPipes - this.lastGpu.syncPipes - this.lastGpu.asyncPipes; }
      if (g) this.lastGpu = g;
    } else {
      for (const p of this.programs()) if (!this.seen.has(p)) { this.seen.add(p); shaders++; }
    }
    if (shaders || pipes) this.events.push([t, shaders, pipes]);
    if (this.last) this.frames.push([t, t - this.last]);
    this.last = t;
    const cut = t - WINDOW_MS;
    while (this.events.length && this.events[0][0] < cut) this.events.shift();
    while (this.frames.length && this.frames[0][0] < cut) this.frames.shift();
    // (Redraw a few times a second, not every frame.)
    if (!this.on || !this.el || t - this.shown < 250) return;
    this.shown = t;
    let s = 0, p = 0, worst = 0;
    for (const e of this.events) { s += e[1]; p += e[2]; }
    for (const f of this.frames) worst = Math.max(worst, f[1]);
    const c = shaderCap;
    const cap = !c.active ? 'cap: starts after loading' : c.maxPerSecond > 0 ? `cap ${c.maxPerSecond}/s, last second ${c.lastSecond}, waiting ${c.waiting}` : 'cap: off';
    this.el.textContent = (this.webgpu
      ? `Shaders built, last 10 s: ${s}  ·  GPU pipelines: ${p}`
      : `Shaders compiled, last 10 s: ${s}`) + `\n${cap}\nlongest frame: ${worst.toFixed(0)} ms` + this.freezeLine(t);
  }

  /** Freezes (src/debug/HitchLog.ts) this session: how many, the last one (Shift+F9 saves them). */
  private freezeLine(t: number): string {
    const f = hitch.freezes, last = f[f.length - 1];
    if (!last) return '\nfreezes: none (Shift+F9 saves the log)';
    const ago = Math.max(0, (t / 1000 - last.t) / 60);
    return `\nfreezes: ${f.length}, last ${(last.ms / 1000).toFixed(1)} s, ${ago < 1 ? 'just now' : ago.toFixed(0) + ' min ago'} (Shift+F9 saves the log)`;
  }
}
