/**
 * The one renderer for a game (each game guards that nothing else constructs one): three.js
 * WebGPURenderer, so materials are written once in TSL / node materials.
 *
 * From Dunfinity src/render/renderer.ts (v0.281). A game picks its backends:
 *  - `'webgpu'`: WebGPU only. A browser without it gets `GraphicsUnavailable`, never WebGL 2 (Solarpolis).
 *  - `'webgpu-or-webgl2'`: WebGPU where the browser has it, three's WebGL 2 backend everywhere else (Dunfinity).
 */
import { ACESFilmicToneMapping, AgXToneMapping, CustomToneMapping, WebGPURenderer } from 'three/webgpu';
import { gradedAgX } from './grade';

export type Backends = 'webgpu' | 'webgpu-or-webgl2';

export interface RendererInfo {
  renderer: WebGPURenderer;
  /** Which backend three.js picked. */
  backend: 'webgpu' | 'webgl2';
}

/**
 * Thrown by `createRenderer` when the browser cannot draw with the backends the game allows (or the
 * one it offers will not start): the page shows a plain message instead of a black screen.
 */
export class GraphicsUnavailable extends Error {
  constructor(readonly why: string) {
    super(`No 3D graphics: ${why}`);
  }
}

/** Whether the browser exposes WebGPU at all (its adapter is asked for in `createRenderer`). */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu;
}

/** Which of the two backends this browser offers, before trying either. */
export function graphicsSupport(): { webgpu: boolean; webgl2: boolean } {
  let webgl2 = false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // a browser keeps only so many contexts
  } catch { /* none */ }
  return { webgpu: hasWebGPU(), webgl2 };
}

export interface RendererOptions {
  backends: Backends;
  /** Draw with WebGL 2 even where WebGPU exists (testing the fallback); only with `'webgpu-or-webgl2'`. */
  forceWebGL?: boolean;
  /** Exposure for the tone mapping (default 1). */
  exposure?: number;
  /**
   * The tone curve: `'aces'` (default; filmic, shifts bright hues), `'agx'` (keeps hues, softer), or
   * `'graded'`: AgX with a look whose uniforms are `GRADE` (grade.ts). In the output pass either way.
   */
  tone?: 'aces' | 'agx' | 'graded';
  /** Highest device pixel ratio drawn (default 2). */
  maxPixelRatio?: number;
  /**
   * The depth buffer. `'reversed'` keeps precision from a metre to hundreds of kilometres in one view
   * (Solarpolis); `'logarithmic'` does too where reversed depth is missing, at a cost per fragment.
   * Part of every shader's cache key: choose it once, before the warm-up. Default `'standard'`.
   */
  depth?: 'standard' | 'reversed' | 'logarithmic';
}

export async function createRenderer(canvas: HTMLCanvasElement, opts: RendererOptions): Promise<RendererInfo> {
  const webgpuOnly = opts.backends === 'webgpu';
  if (webgpuOnly && opts.forceWebGL) throw new Error('createRenderer: forceWebGL needs backends "webgpu-or-webgl2"');
  if (webgpuOnly) {
    if (!hasWebGPU()) throw new GraphicsUnavailable('this browser does not offer WebGPU');
    // Ask for the adapter first: without one three.js would quietly fall back to WebGL 2.
    const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu;
    const adapter = await gpu.requestAdapter().catch(() => null);
    if (!adapter) throw new GraphicsUnavailable('WebGPU is offered but no graphics adapter is available');
  } else {
    const support = graphicsSupport();
    if (!support.webgl2 && (!support.webgpu || opts.forceWebGL)) throw new GraphicsUnavailable('this browser offers neither WebGPU nor WebGL 2');
  }
  const renderer = new WebGPURenderer({
    canvas, antialias: true, forceWebGL: opts.forceWebGL ?? false,
    reversedDepthBuffer: opts.depth === 'reversed', logarithmicDepthBuffer: opts.depth === 'logarithmic',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.maxPixelRatio ?? 2));
  // Tone mapping: bright surfaces roll off instead of clipping to flat white (it is applied in the output
  // pass, so no material shader changes with it).
  const tone = opts.tone ?? 'aces';
  if (tone === 'graded') renderer.library.addToneMapping(gradedAgX, CustomToneMapping);
  renderer.toneMapping = tone === 'aces' ? ACESFilmicToneMapping : tone === 'agx' ? AgXToneMapping : CustomToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1;
  try { await renderer.init(); } catch (err) {
    throw new GraphicsUnavailable(err instanceof Error ? err.message : String(err));
  }
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  if (webgpuOnly && backend !== 'webgpu') {
    renderer.dispose();
    throw new GraphicsUnavailable('WebGPU would not start');
  }
  return { renderer, backend };
}
