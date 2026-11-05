/**
 * Which renderer the game runs on. The game (index.html) runs on WebGPU wherever the browser
 * offers it, else on WebGL; `?gpu=webgl` or the pause menu's Renderer choice (remembered) runs
 * WebGL, `?gpu=webgpu` forces WebGPU, `?gpu=webgpu-gl` runs the node renderer on its WebGL 2
 * backend. The preview pages stay on WebGL unless asked. See docs/WEBGPU_PLAN.md.
 */
const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('gpu');

/** Read at run time, not at import: the game settles it in `loadGpuKit` before anything is built. */
export let WEBGPU = param === 'webgpu' || param === 'webgpu-gl';
export const WEBGPU_FORCE_GL = param === 'webgpu-gl';
/** What the URL alone asks for: the start screen's character creator keeps using this, whatever the
 * game's preload (game/Preload) has settled meanwhile. */
export const URL_WEBGPU = WEBGPU;
/** Set once Start was pressed (the creator then runs on the game's renderer kind). */
export let IN_GAME = false;
export function enterGame(): void { IN_GAME = true; }

const RENDERER_KEY = 'scale.renderer';
export type RendererChoice = 'webgpu' | 'webgl';

/** The renderer the player chose in the menu (WebGPU unless they picked WebGL). */
export function rendererChoice(): RendererChoice {
  try { return localStorage.getItem(RENDERER_KEY) === 'webgl' ? 'webgl' : 'webgpu'; } catch { return 'webgpu'; }
}

/** Remember the player's renderer; it applies from the next start. */
export function setRendererChoice(c: RendererChoice): void {
  try { localStorage.setItem(RENDERER_KEY, c); } catch { /* storage unavailable */ }
}

/** Why the game runs on the renderer it does (for the menu and the log). */
export let rendererWhy = param ? `?gpu=${param}` : 'default';

type Kit = typeof import('./webgpu');
let kit: Kit | null = null;

/**
 * Settle the renderer and load the WebGPU side (before the renderer is created). `gameDefault`:
 * the game itself, where WebGPU is the default (the preview pages pass nothing and stay on WebGL).
 * WebGPU needs an adapter: a browser without one (no WebGPU, a blocked GPU, headless without
 * flags) runs WebGL instead of three's slower WebGL 2 fallback.
 */
export async function loadGpuKit(gameDefault = false): Promise<void> {
  if (gameDefault && param === null) {
    if (rendererChoice() === 'webgl') rendererWhy = 'chosen in the menu';
    else {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
      WEBGPU = !!adapter;
      rendererWhy = adapter ? 'default' : gpu ? 'no WebGPU adapter' : 'no WebGPU in this browser';
    }
  } else if (param === 'webgl') rendererWhy = '?gpu=webgl';
  console.log(`[graphics] renderer: ${WEBGPU ? (WEBGPU_FORCE_GL ? 'WebGPU node renderer on WebGL 2' : 'WebGPU') : 'WebGL'} (${rendererWhy})`);
  if (WEBGPU && !kit) kit = await import('./webgpu');
}

/** The WebGPU side; only valid when `WEBGPU` (after `loadGpuKit`). */
export function gpuKit(): Kit {
  if (!kit) throw new Error('WebGPU kit not loaded');
  return kit;
}
