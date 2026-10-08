/**
 * Everything the WebGPU path needs, loaded only when the game runs on it (`?gpu=webgpu`), so the
 * default WebGL build does not carry three's node system. See docs/WEBGPU_PLAN.md.
 */
import * as THREE from 'three/webgpu';
import { renderOutput, texture } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { makeSkyNode, makeStarsNode } from './sky';
import { createFacadeNodeMaterial } from './facade';
import { createGroundNodeMaterial, createTerrainNodeMaterial, createWaterNodeMaterial } from './ground';
import { clearGlassNodeMaterial, clearGlassElemNodeMaterial, skylineNodeMaterial } from './city';

export { clearGlassNodeMaterial, clearGlassElemNodeMaterial, skylineNodeMaterial };
import { undergroundTrainNodeMaterial, deepCaveNodeMaterial, deepFallsNodeMaterial, deepMotesNode, deepShardNodeMaterial } from './underground';
export { undergroundTrainNodeMaterial, deepCaveNodeMaterial, deepFallsNodeMaterial, deepMotesNode, deepShardNodeMaterial };
import { createBarkNodeMaterial, createLeafNodeMaterial, createFarTreeNodeMaterial, createClumpNodeMaterial } from './vegetation';
export { createBarkNodeMaterial, createLeafNodeMaterial, createFarTreeNodeMaterial, createClumpNodeMaterial };
import { createVehicleNodeMaterial } from './vehicles';
import { createFurnitureNodeMaterial } from './furniture';
export { createVehicleNodeMaterial, createFurnitureNodeMaterial };
import { createRainNodeMaterial } from './weather';
import { createDustNodeMaterial, createBeamNodeMaterial, createPowerParticleNodeMaterial, createDecalNodeMaterial, createSmokeColumnNodeMaterial, createStarFxNodeMaterial, createStarParticlesNode } from './effects';
import { createBroodNodeMaterial, createBirdNodeMaterial, createCreatureNodeMaterial, createDebrisNodeMaterial, bronzeNodeMaterial } from './creatures';
import { createNavGlowNodeMaterial, createSignNodeMaterial, createHoloNodeMaterial } from './signs';
export { createRainNodeMaterial, createDustNodeMaterial, createBeamNodeMaterial, createPowerParticleNodeMaterial, createDecalNodeMaterial, createSmokeColumnNodeMaterial, createStarFxNodeMaterial, createStarParticlesNode };
export { createBroodNodeMaterial, createBirdNodeMaterial, createCreatureNodeMaterial, createDebrisNodeMaterial, bronzeNodeMaterial };
export { createNavGlowNodeMaterial, createSignNodeMaterial, createHoloNodeMaterial };
export { createSkinNodeMaterial, createGarmentNodeMaterial, createShellNodeMaterial, createEyeNodeMaterial, createHairNodeMaterial, createHornNodeMaterial, simpleNodeMaterial, createLashNodeMaterial } from './people';
export { createCrowdNodeMaterial } from './crowd';
export { patchSkyOcclusionNode } from './skyOcclusion';
export { makeStarsNode };
export { makeSkyNode, createFacadeNodeMaterial, createGroundNodeMaterial, createTerrainNodeMaterial, createWaterNodeMaterial };

export function createRenderer(canvas: HTMLCanvasElement, forceWebGL: boolean): THREE.WebGPURenderer {
  // (trackTimestamp: GPU time per frame for the auto quality, where the adapter has timestamp queries.)
  return new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: true, forceWebGL, trackTimestamp: true });
}

/**
 * Polygon offset with reversed depth: WebGLRenderer flips the slope factor when the depth buffer
 * is reversed, three's WebGPU and WebGL2 backends do not, so decals and the street surfaces
 * (polygonOffsetFactor -1: "nearer") would sink behind what they should cover. Flip it the same
 * way. Call after `renderer.init()`, once the backend is chosen.
 */
export function afterInit(renderer: THREE.WebGPURenderer): void {
  flipPolygonOffsets(renderer);
  packBeforeRender(renderer);
  watchVertexBuffers(renderer);
  countNodeBuilds(renderer);
  shareInstancedShaders(renderer);
  noPerFrameUploads();
  oneNodeBuildAtATime(renderer);
  asyncDrawPipelines(renderer);
}

/** Draw-time pipelines compiling at most at once, see asyncDrawPipelines. */
const MAX_DRAW_PIPES = 6;
let drawPipesInFlight = 0;
/** Where pipelines created while drawing put their promises (nobody waits; only counted). */
const drawSink = {
  push(p: Promise<unknown>): void {
    drawPipesInFlight++;
    void p.finally(() => drawPipesInFlight--);
  },
};

/**
 * A pipeline that compileAsync did not build ahead (shadow passes, which compileAsync does not
 * cover, and whatever first shows up in a frame) is created while drawing, blocking: the GPU process
 * compiles it before the frame goes on, ~0.1 s each on the PC, over a hundred of them during
 * loading (6–7 fps) and a hitch whenever one turns up in play. Created async instead, the object is
 * skipped until its pipeline is ready (three's renderer checks `isReady` before every draw; a mesh
 * or its shadow shows up a few frames later instead of stalling the frame), and several compile in
 * parallel. Internal: `_pipelines.updateForRender` / `getForRender(renderObject, promises)` (r186);
 * `&syncpipes` turns it off.
 */
function asyncDrawPipelines(renderer: THREE.WebGPURenderer): void {
  const url = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.name ?? location.href;
  if (/[?&]syncpipes\b/.test(url)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipelines = (renderer as any)._pipelines;
  if (typeof pipelines?.updateForRender !== 'function' || typeof pipelines.getForRender !== 'function') return;
  // (At most MAX_DRAW_PIPES compiling: a hundred at once during loading slowed everything else
  // down. Over the limit, an object without any pipeline yet just waits for a later frame; one that
  // has a pipeline is always updated, so it never draws with an outdated one.)
  pipelines.updateForRender = function (this: { get(ro: unknown): { pipeline?: unknown }; getForRender(ro: unknown, p: unknown): unknown }, renderObject: unknown) {
    if (drawPipesInFlight >= MAX_DRAW_PIPES && this.get(renderObject).pipeline === undefined) return;
    this.getForRender(renderObject, drawSink);
  };
}

/**
 * compileAsync builds an object's node shaders in steps that yield to the main thread
 * (getForRenderAsync) and then waits for its pipeline. Two compileAsync calls whose node builds
 * interleave produce broken shaders, so the game used to run them strictly one after the other,
 * which also meant one GPU pipeline compile at a time. With the async node builds queued here
 * (each still runs whole, as before), several compileAsync calls can run at once and their
 * pipelines compile in parallel (the browser compiles async pipelines on worker threads).
 * Internal: `_nodes.getForRenderAsync` (r186); without it nothing changes, see Renderer.compileAsync.
 */
export function oneNodeBuildAtATime(renderer: THREE.WebGPURenderer): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = (renderer as any)._nodes;
  const build = nodes?.getForRenderAsync;
  if (typeof build !== 'function') return false;
  if (nodes.oneAtATime) return true;
  let last: Promise<unknown> = Promise.resolve();
  nodes.getForRenderAsync = function (this: unknown, renderObject: unknown) {
    const run = last.then(() => build.call(this, renderObject));
    last = run.catch(() => undefined);
    return run;
  };
  nodes.oneAtATime = true;
  return true;
}

/**
 * WebGPU uploads a DynamicDrawUsage attribute again on EVERY frame, whole (WebGL only treats it as
 * a hint and uploads on `needsUpdate`, like any other). The game marks its changes with
 * `needsUpdate` everywhere, as WebGL needs, so on WebGPU dynamic attributes are plain ones: they
 * are uploaded when their version changes (three's instancing nodes sync versions the same way).
 * With hundreds of instance buffers, several of them sized for growth, the per-frame copies were
 * megabytes a frame.
 */
function noPerFrameUploads(): void {
  for (const C of [THREE.BufferAttribute, THREE.InterleavedBuffer]) {
    const P = C.prototype as unknown as { setUsage(u: number): unknown };
    const set = P.setUsage;
    P.setUsage = function (this: unknown, u: number) { return set.call(this, u === THREE.DynamicDrawUsage ? THREE.StaticDrawUsage : u); };
  }
}

/**
 * Instance matrices that fit a uniform buffer are put in one, with its size
 * and a per-object name written into the vertex shader: every instanced mesh then needed its own
 * shader and pipeline (~560 vertex shaders for ~160 fragment shaders). As vertex attributes,
 * which three uses for the larger ones anyway, they share them. Not where the
 * matrix (4 attribute slots, 1 vertex buffer) would not fit WebGPU's 16 attributes / 8 buffers.
 */
function shareInstancedShaders(renderer: THREE.WebGPURenderer): void {
  const prev = renderer.debug.onNodeBuilderCreated;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer.debug.onNodeBuilderCreated = (builder: any, renderObject: any) => {
    prev?.(builder, renderObject);
    const o = renderObject?.object as THREE.InstancedMesh | undefined;
    if (!o?.isInstancedMesh || typeof builder.getUniformBufferLimit !== 'function') return;
    const attrs = Object.values(o.geometry.attributes);
    const buffers = new Set(attrs.map((a) => (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data : a));
    const extra = o.instanceColor ? 1 : 0;
    // (Our own nodes can read the matrix again, as attributes of their own: up to 4 slots and a
    // buffer, unless the material says how many it reads.)
    const own = (renderObject.material?.userData?.instanceReads as number | undefined) ?? 4;
    if (attrs.length + extra + 4 + own > 16 || buffers.size + extra + 1 + (own > 0 ? 1 : 0) > 8) return;
    builder.getUniformBufferLimit = () => 0;
  };
}

/** Node shader builds so far, and pipelines built ahead (compileAsync) or on the spot while drawing. */
export const nodeBuilds = { count: 0, syncPipes: 0, asyncPipes: 0 };

function countNodeBuilds(renderer: THREE.WebGPURenderer): void {
  // `&buildlog`: every 10 s, what had its node shaders built (material, extra geometry attributes,
  // instanced or not) and the frame rate, to find what keeps building after loading.
  const url = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.name ?? location.href;
  const log = /[?&]buildlog\b/.test(url) ? new Map<string, number>() : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer.debug.onNodeBuilderCreated = (_builder: any, renderObject: any) => {
    nodeBuilds.count++;
    if (!log) return;
    const m = renderObject?.material as THREE.Material | undefined, o = renderObject?.object as THREE.Mesh | undefined;
    const attrs = Object.keys(o?.geometry?.attributes ?? {}).filter((k) => k !== 'position' && k !== 'normal' && k !== 'uv').join(',');
    const k = `${m?.name || m?.type}${(o as THREE.InstancedMesh | undefined)?.isInstancedMesh ? ' inst' : ''} [${attrs}]`;
    log.set(k, (log.get(k) ?? 0) + 1);
  };
  (window as unknown as { nodeBuilds: typeof nodeBuilds }).nodeBuilds = nodeBuilds;
  if (!log) return;
  const gpu = timeGpuCompiles();
  let frames = 0;
  const tick = (): void => { frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => {
    const top = [...log].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${n} ${k}`).join('; ');
    console.log(`[buildlog] ${(performance.now() / 1000).toFixed(0)} s, ${(frames / 10).toFixed(1)} fps, ${nodeBuilds.count} builds; ${gpu()}; last 10 s: ${top || 'none'}`);
    log.clear();
    frames = 0;
  }, 10000);
}

/**
 * `&buildlog`: how long the GPU side takes (WebGPU API calls on the device: shader modules and
 * pipelines, blocking or async), totals since the start. `busy` is the time with at least one async
 * pipeline in flight, `peak` the most at once, so the node-build share of a loading phase is what
 * remains.
 */
function timeGpuCompiles(): () => string {
  const t = { mods: 0, modMs: 0, sync: 0, syncMs: 0, async: 0, asyncMs: 0, busyMs: 0, flying: 0, peak: 0, since: 0 };
  const D = (globalThis as unknown as { GPUDevice?: { prototype: Record<string, (...a: unknown[]) => unknown> } }).GPUDevice?.prototype;
  if (!D) return () => 'no GPUDevice';
  const timed = (name: string, add: (ms: number) => void) => {
    const f = D[name];
    D[name] = function (this: unknown, ...a: unknown[]) { const t0 = performance.now(); try { return f.apply(this, a); } finally { add(performance.now() - t0); } };
  };
  timed('createShaderModule', (ms) => { t.mods++; t.modMs += ms; });
  timed('createRenderPipeline', (ms) => { t.sync++; t.syncMs += ms; });
  const fa = D.createRenderPipelineAsync;
  D.createRenderPipelineAsync = function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    if (t.flying++ === 0) t.since = t0;
    t.peak = Math.max(t.peak, t.flying);
    const end = () => { const now = performance.now(); t.async++; t.asyncMs += now - t0; if (--t.flying === 0) t.busyMs += now - t.since; };
    const p = fa.apply(this, a) as Promise<unknown>;
    p.then(end, end);
    return p;
  };
  return () => `gpu: ${t.mods} modules ${t.modMs.toFixed(0)} ms, ${t.sync} pipelines blocking ${t.syncMs.toFixed(0)} ms, ${t.async} async ${t.asyncMs.toFixed(0)} ms (busy ${t.busyMs.toFixed(0)} ms, peak ${t.peak})`;
}

/** Warns about pipelines over WebGPU's vertex buffer limit, also on the WebGL2 backend (where they would work). */
function watchVertexBuffers(renderer: THREE.WebGPURenderer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backend = renderer.backend as any;
  const create = backend.createRenderPipeline?.bind(backend);
  if (!create) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  backend.createRenderPipeline = (renderObject: any, promises: unknown) => {
    const n = renderObject.getVertexBuffers?.().length ?? 0;
    if (n > 8) {
      const o = renderObject.object, g = o.geometry;
      console.warn(`[webgpu] ${n} vertex buffers (WebGPU allows 8): ${o.type} "${o.name}" ${renderObject.material.type} attributes ${Object.keys(g.attributes).join(',')}`);
    }
    if (promises && promises !== drawSink) nodeBuilds.asyncPipes++; else nodeBuilds.syncPipes++;
    return create(renderObject, promises);
  };
}

function flipPolygonOffsets(renderer: THREE.WebGPURenderer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backend = renderer.backend as any;
  if (backend.pipelineUtils) {
    const pu = backend.pipelineUtils;
    const create = pu.createRenderPipeline.bind(pu);
    pu.createRenderPipeline = (renderObject: { material: THREE.Material }, promises: unknown) => {
      const m = renderObject.material;
      if (!m.polygonOffset) return create(renderObject, promises);
      const f = m.polygonOffsetFactor;
      m.polygonOffsetFactor = -f;
      try { return create(renderObject, promises); } finally { m.polygonOffsetFactor = f; }
    };
  } else if (backend.state?.setPolygonOffset) {
    const st = backend.state;
    const set = st.setPolygonOffset.bind(st);
    st.setPolygonOffset = (on: boolean, factor: number, units: number) => set(on, -factor, units);
  }
}

/** A render target's pixels, bottom row first like WebGL's readRenderTargetPixels. */
export async function readPixels(renderer: THREE.WebGPURenderer, rt: THREE.RenderTarget, w: number, h: number): Promise<Uint16Array> {
  const data = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h) as Uint16Array;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(renderer.backend as any).isWebGPUBackend) return data;
  // WebGPU textures start at the top row.
  const row = w * 4, out = new Uint16Array(row * h);
  for (let y = 0; y < h; y++) out.set(data.subarray(y * row, y * row + row), (h - 1 - y) * row);
  return out;
}

/**
 * Test aid (`&offscreen`): the final image goes into a render target instead of the canvas, and
 * `window.grabFrame()` returns it as a PNG data URL. Headless Chrome on SwiftShader loses the
 * WebGPU device on the first canvas present, but renders into targets fine.
 */
export function offscreen(renderer: THREE.WebGPURenderer): void {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.RenderTarget(size.x, size.y);
  renderer.setOutputRenderTarget(rt);
  (window as unknown as { grabFrame: () => Promise<string> }).grabFrame = async () => {
    const w = rt.width, h = rt.height;
    const px = await readPixels(renderer, rt, w, h) as unknown as Uint8Array;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    // (readPixels gives rows bottom-first, like WebGL.)
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  };
}

/**
 * WebGPU allows 8 vertex buffers per pipeline (three binds every non-interleaved attribute as its
 * own buffer, plus the instance matrix and instanced attributes). Geometries with many custom
 * attributes (street furniture, leaves) went over it and their pipelines failed. Before a
 * geometry is first rendered, if it has more buffers than that leaves room for, its static float
 * attributes other than position are interleaved into one buffer (the shader reads them by name
 * as before). Attributes that change after creation (dynamic usage, instanced) stay as they are.
 */
const MAX_OWN_BUFFERS = 5;
function packGeometry(geometry: THREE.BufferGeometry | undefined): void {
  if (!geometry || geometry.userData.vbPacked) return;
  geometry.userData.vbPacked = true;
  const attrs = geometry.attributes as Record<string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute>;
  const buffers = new Set<unknown>();
  for (const a of Object.values(attrs)) buffers.add((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data : a);
  if (buffers.size <= MAX_OWN_BUFFERS) return;
  const n = attrs.position?.count ?? 0;
  const pack: [string, THREE.BufferAttribute][] = [];
  for (const [name, a] of Object.entries(attrs)) {
    const b = a as THREE.BufferAttribute;
    if (name === 'position' || (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || (b as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) continue;
    if (!(b.array instanceof Float32Array) || b.normalized || b.usage !== THREE.StaticDrawUsage || b.count !== n || b.itemSize > 4) continue;
    pack.push([name, b]);
  }
  if (pack.length < 2) return;
  const stride = pack.reduce((s, [, b]) => s + b.itemSize, 0);
  const data = new Float32Array(stride * n);
  const ib = new THREE.InterleavedBuffer(data, stride);
  let off = 0;
  for (const [name, b] of pack) {
    const k = b.itemSize, src = b.array as Float32Array;
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) data[i * stride + off + c] = src[i * k + c];
    geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(ib, k, off));
    off += k;
  }
}

/** Packs every geometry once, before its first render object (and so its first pipeline) exists. */
function packBeforeRender(renderer: THREE.WebGPURenderer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objects = (renderer as any)._objects;
  if (!objects?.get) { console.warn('[webgpu] cannot pack vertex buffers: renderer internals changed'); return; }
  const get = objects.get.bind(objects);
  objects.get = (object: THREE.Mesh, ...rest: unknown[]) => { packGeometry(object.geometry); return get(object, ...rest); };
}

export function createPMREM(renderer: unknown): THREE.PMREMGenerator {
  return new THREE.PMREMGenerator(renderer as THREE.WebGPURenderer);
}

/** The game's post-processing (HDR scene → bloom → tone mapping and sRGB → SMAA) as a node pipeline. */
export class Post {
  private pipeline: THREE.RenderPipeline;
  /** The scene is drawn here (HDR) by a plain render, not by a pass() node inside the pipeline. */
  private target: THREE.RenderTarget;
  private bloomNode: ReturnType<typeof bloom>;
  private bloomOn = true;
  private smaaOn = true;
  private size = new THREE.Vector2();

  constructor(private renderer: THREE.WebGPURenderer, private scene: THREE.Scene, private camera: THREE.Camera) {
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    // (A pass() node renders the scene from inside the pipeline's own render, a nested render
    // call: three keys every pipeline by that, so compileAsync, which runs at the top level,
    // built pipelines the frames never used, and the frames built theirs one by one.)
    this.target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.target.texture.name = 'scene';
    const depth = new THREE.DepthTexture(1, 1);
    depth.isRenderTargetTexture = true;
    this.target.depthTexture = depth;
    this.bloomNode = bloom(texture(this.target.texture), 0.16, 0.5, 2.0);
    this.build();
  }

  private build(): void {
    const col = texture(this.target.texture);
    let out = this.bloomOn ? col.add(this.bloomNode) : col;
    out = renderOutput(out);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.pipeline.outputNode = (this.smaaOn ? smaa(out as any) : out) as any;
    this.pipeline.needsUpdate = true;
  }

  set(bloomOn: boolean, smaaOn: boolean): void {
    if (bloomOn === this.bloomOn && smaaOn === this.smaaOn) return;
    this.bloomOn = bloomOn;
    this.smaaOn = smaaOn;
    this.build();
  }

  setBloom(strength: number): void {
    this.bloomNode.strength.value = strength;
  }

  render(): void {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
    this.pipeline.render();
  }

  /** Where the scene is drawn: compiles target it so they build the pipelines the frames use. */
  get sceneTarget(): THREE.RenderTarget {
    return this.target;
  }
}
