/**
 * Everything the WebGPU path needs, loaded only when the game runs on it (`?gpu=webgpu`), so the
 * default WebGL build does not carry three's node system. See docs/WEBGPU_PLAN.md.
 */
import * as THREE from 'three/webgpu';
import { keepTextureUpdates, rebindSwitchedTextures, shareShadowNodes } from '@futuremagic/stage/patches';
import { renderOutput, texture } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { shaderCap } from '../shaderCap';
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
import { createDustNodeMaterial, createBeamNodeMaterial, createPowerParticleNodeMaterial, createDecalNodeMaterial, createSmokeColumnNodeMaterial, createStarFxNodeMaterial, createStarParticlesNode, createHaloNodeMaterial } from './effects';
import { createBroodNodeMaterial, createBirdNodeMaterial, createCreatureNodeMaterial, createDebrisNodeMaterial, bronzeNodeMaterial } from './creatures';
import { createNavGlowNodeMaterial, createSignNodeMaterial, createHoloNodeMaterial } from './signs';
export { createRainNodeMaterial, createDustNodeMaterial, createBeamNodeMaterial, createPowerParticleNodeMaterial, createDecalNodeMaterial, createSmokeColumnNodeMaterial, createStarFxNodeMaterial, createStarParticlesNode, createHaloNodeMaterial };
export { createBroodNodeMaterial, createBirdNodeMaterial, createCreatureNodeMaterial, createDebrisNodeMaterial, bronzeNodeMaterial };
export { createNavGlowNodeMaterial, createSignNodeMaterial, createHoloNodeMaterial };
export { createCrowdNodeMaterial } from './crowd';
export { patchSkyOcclusionNode } from './skyOcclusion';
export { viewSpaceLayerNode } from './garmentLayers';
export { makeStarsNode };
export { makeSkyNode, createFacadeNodeMaterial, createGroundNodeMaterial, createTerrainNodeMaterial, createWaterNodeMaterial };

export function createRenderer(canvas: HTMLCanvasElement, forceWebGL: boolean): THREE.WebGPURenderer {
  // (trackTimestamp: GPU time per frame for the auto quality, where the adapter has timestamp queries.)
  return new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: true, forceWebGL, trackTimestamp: true });
}

/** The character creator's turntable: transparent, antialiased, otherwise set up like the game's. */
export async function createPreviewRenderer(canvas: HTMLCanvasElement, forceWebGL: boolean): Promise<THREE.WebGPURenderer> {
  const r = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', reversedDepthBuffer: true, forceWebGL });
  await r.init();
  afterInit(r);
  return r;
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
  guardDraws(renderer);
  if (!repairLostBindings(renderer)) console.warn('[webgpu] three internals renamed, not installed: repair lost bindings');
  quickShadowKeys(renderer);
  skipEmptyInstances(renderer);
  timeSlowPipelines();
  shareInstancedShaders(renderer);
  noPerFrameUploads();
  oneNodeBuildAtATime(renderer);
  asyncDrawPipelines(renderer);
  // From AssetGenerator's shared shader policy (vendor/futuremagic/stage): per-object textures of
  // shared graphs (Actors' skin photos and eyes) really switch, and casters alike share one shadow shader.
  const missing = [
    rebindSwitchedTextures(renderer) ? '' : 'texture rebind',
    keepTextureUpdates() ? '' : 'texture node updates',
    shareShadowNodes(renderer) ? '' : 'shared shadow nodes',
  ].filter(Boolean);
  if (missing.length) console.warn(`[webgpu] three internals renamed, not installed: ${missing.join(', ')}`);
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
    // (Each one also waits for room under the shader cap, see shaderCap.ts.)
    const run = last.then(() => shaderCap.slot()).then(() => build.call(this, renderObject));
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
let uploadsPatched = false;

function noPerFrameUploads(): void {
  // (Once: the creator's preview renderer and the game's both get here.)
  if (uploadsPatched) return;
  uploadsPatched = true;
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
  // (Hitches: frames over 50 ms, and the longest one, to see stutter while playing.)
  let frames = 0, hitches = 0, worst = 0, last = 0;
  const tick = (t: number): void => {
    frames++;
    const d = last ? t - last : 0;
    last = t;
    if (d > 50) hitches++;
    worst = Math.max(worst, d);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(() => {
    const top = [...log].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${n} ${k}`).join('; ');
    console.log(`[buildlog] ${(performance.now() / 1000).toFixed(0)} s, ${(frames / 10).toFixed(1)} fps, ${hitches} hitches > 50 ms (worst ${worst.toFixed(0)} ms), ${nodeBuilds.count} builds; ${gpu()}; last 10 s: ${top || 'none'}`);
    log.clear();
    frames = hitches = worst = 0;
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

/** What the backend is creating a pipeline for right now (see watchVertexBuffers). */
let building = '';
/** Its WGSL (three's node build result). */
let buildingCode: { vertex: string; fragment: string } | null = null;

/**
 * Every GPU pipeline that takes over 100 ms (the shader budget) is reported with what it was for and
 * how big its WGSL is; `window.slowPipelines` keeps them with their code (for a look at the source).
 */
function timeSlowPipelines(): void {
  const D = (globalThis as unknown as { GPUDevice?: { prototype: Record<string, (...a: unknown[]) => unknown> } }).GPUDevice?.prototype;
  if (!D) return;
  const slow: { ms: number; what: string; vertex: string; fragment: string }[] = [];
  (window as unknown as { slowPipelines: typeof slow }).slowPipelines = slow;
  const time = (name: string, isAsync: boolean) => {
    const f = D[name];
    D[name] = function (this: unknown, ...a: unknown[]) {
      const t0 = performance.now(), what = building || '?', { vertex, fragment } = buildingCode ?? { vertex: '', fragment: '' };
      const done = () => {
        const ms = performance.now() - t0;
        if (ms < 100) return;
        slow.push({ ms, what, vertex, fragment });
        console.warn(`[webgpu] pipeline ${ms.toFixed(0)} ms${isAsync ? ' (async)' : ' (blocking)'}: ${what}, WGSL vertex ${(vertex.length / 1024).toFixed(0)} KB, fragment ${(fragment.length / 1024).toFixed(0)} KB`);
      };
      const r = f.apply(this, a);
      if (isAsync) (r as Promise<unknown>).then(done, done); else done();
      return r;
    };
  };
  time('createRenderPipeline', false);
  time('createRenderPipelineAsync', true);
}

/**
 * One object whose draw throws (a binding without its GPU buffer) used to abort the whole frame,
 * every frame, so the picture froze. Its draw is skipped instead, and the first failure of each
 * object is reported with what it was, to find the cause. A failure is usually passing (see
 * repairLostBindings), so the object is tried again half a second later; only one that keeps
 * failing is dropped for good. (Dropping on the first failure made the hero lose its hair, body or
 * shoes for the rest of the session.)
 */
const DRAW_RETRY_MS = 500;
const DRAW_MAX_FAILS = 20;
function guardDraws(renderer: THREE.WebGPURenderer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = renderer as any;
  const draw = r._renderObjectDirect;
  const failed = new WeakMap<object, { fails: number; until: number }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r._renderObjectDirect = function (object: any, material: any, ...rest: unknown[]) {
    const f = failed.get(object);
    if (f && (f.fails >= DRAW_MAX_FAILS || performance.now() < f.until)) return;
    try {
      const out = draw.call(this, object, material, ...rest);
      if (f) failed.delete(object);
      return out;
    } catch (err) {
      const fails = (f?.fails ?? 0) + 1;
      failed.set(object, { fails, until: performance.now() + DRAW_RETRY_MS });
      if (fails > 1 && fails < DRAW_MAX_FAILS) return;
      const g = object.geometry;
      console.error(`[webgpu] draw failed${fails >= DRAW_MAX_FAILS ? ` ${fails} times, skipped from now on` : ', retried shortly'}: ${object.type} "${object.name}" (parent "${object.parent?.name ?? ''}", ${object.isSkinnedMesh ? `skinned, ${object.skeleton?.bones.length} bones, ` : ''}geometry ${g?.uuid?.slice(0, 8)} [${Object.keys(g?.attributes ?? {}).join(',')}]) material ${material?.type} "${material?.name}"`, err);
    }
  };
}

/**
 * A bind group whose uniform buffers were already freed is rebuilt before it is used. three counts
 * the users of each bind group and frees its GPU buffers when the count reaches zero; a render
 * object disposed while it is being drawn (Actors disposes and rebuilds a person's geometry when
 * it changes it) or a miscount leaves a group in use with no buffer, and the draw then throws
 * "writeBuffer: parameter 1 is not of type 'GPUBuffer'". The group gets new buffers holding its
 * current uniform values and a new GPU bind group. Internal: Bindings._update / _createBindings (r186).
 */
function repairLostBindings(renderer: THREE.WebGPURenderer): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = renderer as any, bindings = r._bindings, backend = r.backend;
  if (!backend?.isWebGPUBackend) return true; // the WebGL 2 backend keeps its buffers differently
  const update = bindings?._update, create = bindings?._createBindings;
  if (typeof update !== 'function' || typeof create !== 'function' || typeof bindings.delete !== 'function') return false;
  let reported = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bindings._update = function (this: any, group: any, all: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list: any[] = group?.bindings ?? [];
    if (list.some((b) => b.isUniformBuffer && backend.get(b).buffer === undefined)) {
      try {
        // Freed samplers and textures forgot their texture: take it from the node again.
        for (const b of list) if ((b.isSampler || b.isSampledTexture) && !b.texture && b.textureNode) b.texture = b.textureNode.value;
        this.delete(group);
        create.call(this, [group]);
        for (const b of list) if (b.isUniformBuffer) { b.update(); backend.updateBinding(b); }
        if (reported++ < 5) console.warn(`[webgpu] rebuilt a bind group whose buffers were freed while in use: "${group.name}"`);
      } catch (err) {
        if (reported++ < 5) console.warn('[webgpu] could not rebuild a freed bind group', err);
      }
    }
    return update.call(this, group, all);
  };
  return true;
}

/**
 * Instanced meshes with no instances (prop batches of kinds no loaded cell uses right now, most of
 * the aftermath props): three's WebGL renderer drops them cheaply, the WebGPU one does all the
 * per-object work (render object, uniforms, bindings) before finding nothing to draw: about 370 of
 * ~600 draws a frame at the start street, view and shadow pass (headless count 2026-11-04). They are
 * left out when the scene is gathered. Internal: `_projectObject` (r186).
 */
function skipEmptyInstances(renderer: THREE.WebGPURenderer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = renderer as any;
  const project = r._projectObject;
  if (typeof project !== 'function') { console.warn('[webgpu] three internals renamed, not installed: skip empty instances'); return; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r._projectObject = function (this: unknown, object: any, ...rest: unknown[]) {
    if (object.isInstancedMesh === true && object.count === 0 && object.children.length === 0) return;
    return project.call(this, object, ...rest);
  };
}

/**
 * The shadow pass draws every caster with one shared override material, and three copies each
 * caster's `alphaTest` onto it: switching between casters with and without alpha test (trees, hair
 * vs buildings) bumps its version, so every shadow draw after such a switch rebuilt its full
 * material cache key (a walk over all its properties and node graphs), ~250 keys per frame, about
 * a third of the per-draw time on the PC (CPU profile 2026-11-04). For the shadow pass material the
 * key only depends on what is copied from the caster, so a draw whose copied values (alpha test on
 * or off, maps, side, transparency, nodes) match those it was last checked with reuses its key.
 * Internal: RenderObject.getCacheKey (r186), reached through `_objects.createRenderObject`.
 */
function quickShadowKeys(renderer: THREE.WebGPURenderer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objects = (renderer as any)._objects;
  const create = objects?.createRenderObject;
  if (typeof create !== 'function') { console.warn('[webgpu] three internals renamed, not installed: quick shadow keys'); return; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sig = (m: any): string => `${m.side}|${m.alphaTest > 0}|${m.alphaMap?.id}|${m.displacementMap?.id}|${m.displacementScale !== 0}|${m.displacementBias !== 0}|${m.transparent}|${m.colorNode?.id}|${m.depthNode?.id}|${m.positionNode?.id}`;
  let patched = false;
  objects.createRenderObject = function (this: unknown, ...a: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ro = create.apply(this, a) as any;
    if (!patched) {
      patched = true;
      const P = Object.getPrototypeOf(ro), getCacheKey = P.getCacheKey;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      P.getCacheKey = function (this: any) {
        if (this.material?.isShadowPassMaterial !== true || this.initialCacheKey === undefined) return getCacheKey.call(this);
        const s = sig(this.material);
        if (this.shadowSig === s && !this.needsUpdate) return this.initialCacheKey;
        const key = getCacheKey.call(this);
        this.shadowSig = key === this.initialCacheKey ? s : undefined;
        return key;
      };
    }
    return ro;
  };
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
    const o = renderObject.object, m = renderObject.material;
    building = `${o.type} "${o.name}" (parent "${o.parent?.name ?? ''}") ${m.type} "${m.name}"`;
    const state = renderObject.getNodeBuilderState?.();
    buildingCode = { vertex: state?.vertexShader ?? '', fragment: state?.fragmentShader ?? '' };
    try { return create(renderObject, promises); } finally { building = ''; buildingCode = null; }
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
function packGeometry(object: THREE.Object3D): void {
  const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (!geometry || geometry.userData.vbPacked) return;
  // Never skinned meshes (people, creatures). Their owners keep writing attributes in place
  // through `.array` as tightly packed data (Actors rewrites normals and clip values when a person
  // is re-tucked); once interleaved, those writes landed on the skin weights and uvs, and the person
  // burst into a cloud of triangles until the next rebuild. They are not instanced, so they have
  // all 8 vertex buffers to themselves, and Actors keeps its meshes within that.
  if ((object as THREE.SkinnedMesh).isSkinnedMesh) return;
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
  objects.get = (object: THREE.Mesh, ...rest: unknown[]) => { packGeometry(object); return get(object, ...rest); };
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
