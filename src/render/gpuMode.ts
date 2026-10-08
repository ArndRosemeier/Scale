/**
 * Which renderer the game runs on. WebGL is the default; `?gpu=webgpu` runs the WebGPU port in
 * progress (`?gpu=webgpu-gl` runs the same node renderer on its WebGL 2 backend). See
 * docs/WEBGPU_PLAN.md.
 */
const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('gpu');

export const WEBGPU = param === 'webgpu' || param === 'webgpu-gl';
export const WEBGPU_FORCE_GL = param === 'webgpu-gl';

type Kit = typeof import('./webgpu');
let kit: Kit | null = null;

/** Load the WebGPU side (before the renderer is created). */
export async function loadGpuKit(): Promise<void> {
  if (WEBGPU && !kit) kit = await import('./webgpu');
}

/** The WebGPU side; only valid when `WEBGPU` (after `loadGpuKit`). */
export function gpuKit(): Kit {
  if (!kit) throw new Error('WebGPU kit not loaded');
  return kit;
}
