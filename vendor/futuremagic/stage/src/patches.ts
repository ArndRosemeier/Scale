/**
 * Renderer hooks that enforce the shader policy (see the game's docs/SHADERS.md). They reach into three.js r186
 * internals (`_nodes`, `_pipelines`), each guarded: if a three update renames them, the hook is
 * skipped and `installShaderPolicy` says which, so the monitor still shows what happens.
 * Adapted from Scale (src/render/webgpu/index.ts) via Dunfinity (src/render/shaders/patches.ts).
 */
import { BufferAttribute, InterleavedBuffer, DynamicDrawUsage, NodeUpdateType, ReferenceNode, StaticDrawUsage, TextureNode, type WebGPURenderer } from 'three/webgpu';
import { Fn, float, nodeObject, vec3, vec4 } from 'three/tsl';
import type { ShaderCap } from './cap';
import { codeHash, type ShaderMonitor } from './monitor';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** Every hook that could not be installed (empty: all in place). */
export function installShaderPolicy(renderer: WebGPURenderer, cap: ShaderCap, monitor: ShaderMonitor): string[] {
  const missing: string[] = [];
  if (!queueNodeBuilds(renderer, cap, monitor)) missing.push('node build queue');
  if (!asyncDrawPipelines(renderer)) missing.push('async draw pipelines');
  if (!rebindSwitchedTextures(renderer)) missing.push('texture rebind');
  if (!keepTextureUpdates()) missing.push('texture node updates');
  if (!shareShadowNodes(renderer)) missing.push('shared shadow nodes');
  if (!fixedBundleUniforms(renderer)) missing.push('fixed bundle uniforms');
  if (!balancedBindingRelease(renderer)) missing.push('balanced binding release');
  noPerFrameUploads();
  timeGpu(monitor);
  return missing;
}

/**
 * Node (TSL → WGSL/GLSL) builds: a build that really happens (not a cache hit) is timed and
 * recorded. Async builds (compileAsync, i.e. the Stage) run one at a time, and each waits for room
 * under the cap. A synchronous build means something was drawn that the Stage never compiled: it
 * cannot wait, but the monitor records it, so the steady-state check fails.
 */
function queueNodeBuilds(renderer: WebGPURenderer, cap: ShaderCap, monitor: ShaderMonitor): boolean {
  const nodes = (renderer as Any)._nodes;
  const getForRender = nodes?.getForRender;
  if (typeof getForRender !== 'function' || typeof nodes.getForRenderCacheKey !== 'function' || !nodes.nodeBuilderCache) return false;
  const needsBuild = (ro: Any): boolean => nodes.get(ro).nodeBuilderState === undefined && !nodes.nodeBuilderCache.has(nodes.getForRenderCacheKey(ro));
  /** The material, and for a pass's own material (a shadow's) the object drawn, by the names up its parents. */
  const label = (ro: Any): string => {
    const own = ro?.object?.material === ro?.material || (Array.isArray(ro?.object?.material) && ro.object.material.includes(ro.material));
    const names: string[] = [];
    for (let o = ro?.object; o && names.length < 3; o = o.parent) if (o.name) names.push(o.name);
    return `${ro?.material?.name || ro?.material?.type || '?'}${ro?.object?.isInstancedMesh ? ' (instanced)' : ''}${own ? '' : ` of ${ro?.object?.type ?? '?'}${names.length ? ` ${names.join('<')}` : ''}`}`;
  };
  let last: Promise<unknown> = Promise.resolve();
  deferLateBuilds(renderer, cap, monitor, needsBuild, label);
  nodes.getForRender = function (this: Any, ro: Any, useAsync = false) {
    if (!needsBuild(ro)) return getForRender.call(this, ro, useAsync);
    if (!useAsync) {
      const t0 = performance.now();
      try { return monitor.time('node-sync', label(ro), () => getForRender.call(this, ro, false), codeOf); } finally { cap.spent(t0, performance.now()); }
    }
    const run = last.then(async () => {
      // An identical object queued earlier may have built this shader meanwhile: then it is a cache hit.
      if (!needsBuild(ro)) return getForRender.call(this, ro, true);
      const release = await cap.slot();
      const t0 = performance.now();
      let made: unknown;
      return Promise.resolve(getForRender.call(this, ro, true)).then((state) => (made = state)).finally(() => {
        monitor.record('node-async', performance.now() - t0, label(ro), t0, codeOf(made));
        release();
      });
    });
    last = run.catch(() => undefined);
    return run;
  };
  return true;
}

/**
 * After warm-up, something drawn whose shader nobody compiled ahead (a mesh made late, a shadow caster of a kind not
 * seen yet, a point light's shadow face) would build it on the render path at once, whatever the cap says. Instead
 * it builds there only in a frame with room under the cap (taking that frame's slot), and is skipped until then: it
 * shows (or casts its shadow) a few frames later, like a pipeline not ready yet (`asyncDrawPipelines`). It is built
 * while drawn, not later: a pass's own material (the shadow pass's) holds the object's nodes only during its draw.
 * The monitor records each skipped shader once as `node-late`. The Stage's own shadow warm-up (`monitor.note` set)
 * draws in a slot it holds already.
 */
export function deferLateBuilds(renderer: WebGPURenderer, cap: ShaderCap, monitor: ShaderMonitor, needsBuild: (ro: Any) => boolean, label: (ro: Any) => string): boolean {
  const r = renderer as Any, direct = r._renderObjectDirect, objects = r._objects, nodes = r._nodes;
  if (typeof direct !== 'function' || typeof objects?.get !== 'function') return false;
  const noted = new Set<string>();
  r._renderObjectDirect = function (this: Any, object: Any, material: Any, scene: Any, camera: Any, lightsNode: Any, group: Any, clippingContext: Any, passId: Any) {
    const drawNow = (): unknown => direct.call(this, object, material, scene, camera, lightsNode, group, clippingContext, passId);
    if (!cap.active || monitor.note) return drawNow();
    const ro = objects.get(object, material, scene, camera, lightsNode, this._currentRenderContext, clippingContext, passId);
    if (!needsBuild(ro)) return drawNow();
    if (!cap.room()) {
      const key = String(nodes.getForRenderCacheKey(ro));
      if (!noted.has(key)) { noted.add(key); monitor.record('node-late', 0, label(ro)); }
      return undefined;
    }
    const release = cap.take();
    try { return drawNow(); } finally { release(); }
  };
  return true;
}

/** The hash of the code a node build made (a NodeBuilderState), to find the same shader built twice. */
const codeOf = (state: unknown): number | undefined => {
  const s = state as { vertexShader?: string; fragmentShader?: string; computeShader?: string } | undefined;
  return s && (s.vertexShader || s.fragmentShader || s.computeShader) ? codeHash(s.vertexShader, s.fragmentShader, s.computeShader) : undefined;
};

/**
 * A pipeline nobody compiled ahead is created while drawing, blocking the frame (~0.1 s each).
 * Created async instead, the object is skipped until its pipeline is ready (three checks `isReady`
 * before every draw), so it shows up a few frames later instead of stalling.
 */
const MAX_DRAW_PIPES = 6;
function asyncDrawPipelines(renderer: WebGPURenderer): boolean {
  const pipelines = (renderer as Any)._pipelines;
  if (typeof pipelines?.updateForRender !== 'function' || typeof pipelines.getForRender !== 'function') return false;
  let inFlight = 0;
  const sink = { push(p: Promise<unknown>): void { inFlight++; void p.finally(() => inFlight--); } };
  pipelines.updateForRender = function (this: Any, ro: Any) {
    if (inFlight >= MAX_DRAW_PIPES && this.get(ro).pipeline === undefined) return;
    this.getForRender(ro, sink);
  };
  return true;
}

/**
 * three.js bug (r186, still in r187): disposing a render object releases its bind groups, counting
 * each group's users down, even when the render object never had its bind groups set up (it was
 * only queued for compileAsync, or disposed while its async node build was still pending, e.g.
 * because its mesh's geometry or material changed in between). Groups shared by every render
 * object of one shader (`shared` uniform groups) were then counted down for a user they never
 * counted up, reached zero while still drawn, and lost their GPU buffers: the next draw of another
 * mesh with that shader threw "writeBuffer: parameter 1 is not of type 'GPUBuffer'" (in Scale the
 * hero lost its hair, body or shoes). Only bind groups that were set up are released.
 * Internal: Bindings.deleteForRender and getForRender's `initialized` flag (r186).
 */
export function balancedBindingRelease(renderer: WebGPURenderer): boolean {
  const bindings = (renderer as Any)._bindings;
  const release = bindings?.deleteForRender;
  if (typeof release !== 'function' || typeof bindings.has !== 'function' || typeof bindings.get !== 'function' || typeof bindings.delete !== 'function') return false;
  if (release.balanced) return true;
  const balanced = function (this: Any, renderObject: Any) {
    if (this.has(renderObject) && this.get(renderObject).initialized === true) return release.call(this, renderObject);
    this.delete(renderObject);
  };
  balanced.balanced = true;
  bindings.deleteForRender = balanced;
  return true;
}

/**
 * A texture node whose value changes between draws (a shared material's per-object texture: Actors' eyes and skin
 * photos) must get a bind group with the new texture. three r186 rebuilds it only when the new texture's generation
 * (its `version`) differs from the binding's, so a switch between two textures of the same version (both uploaded
 * once: version 1) keeps the old one bound. Compiled ahead (the Stage), a binding starts on the node's fallback and
 * then never shows the object's own texture: Actors' eyes and skins came out white. A binding whose texture is about
 * to change forgets its generation, so the switch always rebuilds its group.
 */
export function rebindSwitchedTextures(renderer: WebGPURenderer): boolean {
  const bindings = (renderer as Any)._bindings;
  const update = bindings?._update;
  if (typeof update !== 'function') return false;
  bindings._update = function (this: Any, group: Any, all: Any) {
    for (const b of group?.bindings ?? []) if (b.isSampledTexture && b.textureNode && b.texture !== b.textureNode.value) b.generation = null;
    return update.call(this, group, all);
  };
  return true;
}

/**
 * A texture node given its own update (`onObjectUpdate`, `onFrameUpdate`: a shared material's per-object texture,
 * Actors' eyes and skin photos) must keep it. three r186's TextureNode sets its update type while building its uv
 * (from the uv matrix and flipY alone), which switched such an update off: the node kept its fallback texture for
 * good. From its setup on, such a node's update type can be set, but not taken back to none.
 */
let textureUpdatesKept = false;
export function keepTextureUpdates(): boolean {
  const proto = (TextureNode as Any)?.prototype;
  if (typeof proto?.setup !== 'function') return false;
  if (textureUpdatesKept) return true;
  textureUpdatesKept = true;
  const setup = proto.setup;
  proto.setup = function (this: Any, builder: unknown) {
    if (Object.prototype.hasOwnProperty.call(this, 'update') && this.updateType !== NodeUpdateType.NONE && !this.keepsUpdate) {
      let kept = this.updateType;
      Object.defineProperty(this, 'updateType', { configurable: true, enumerable: true, get: () => kept, set: (t: string) => { if (t !== NodeUpdateType.NONE) kept = t; } });
      this.keepsUpdate = true;
    }
    return setup.call(this, builder);
  };
  return true;
}

/** WebGPU uploads DynamicDrawUsage attributes whole on every frame; we mark changes with `needsUpdate`. */
let uploadsPatched = false;
function noPerFrameUploads(): void {
  if (uploadsPatched) return;
  uploadsPatched = true;
  for (const C of [BufferAttribute, InterleavedBuffer]) {
    const P = C.prototype as unknown as { setUsage(u: number): unknown };
    const set = P.setUsage;
    P.setUsage = function (this: unknown, u: number) { return set.call(this, u === DynamicDrawUsage ? StaticDrawUsage : u); };
  }
}

/** GPU-side costs: WebGPU shader modules and pipelines, WebGL program links. */
let gpuTimed = false;
function timeGpu(monitor: ShaderMonitor): void {
  if (gpuTimed) return;
  gpuTimed = true;
  const wrap = (proto: Any, name: string, kind: Parameters<ShaderMonitor['record']>[0]) => {
    const f = proto?.[name];
    if (typeof f !== 'function') return;
    proto[name] = function (this: unknown, ...a: unknown[]) { return monitor.time(kind, name, () => f.apply(this, a)); };
  };
  const D = (globalThis as Any).GPUDevice?.prototype;
  wrap(D, 'createShaderModule', 'gpu-module');
  wrap(D, 'createRenderPipeline', 'gpu-pipeline-sync');
  const fa = D?.createRenderPipelineAsync;
  if (typeof fa === 'function') {
    D.createRenderPipelineAsync = function (this: unknown, ...a: unknown[]) {
      const t0 = performance.now();
      const p = fa.apply(this, a) as Promise<unknown>;
      const end = () => monitor.record('gpu-pipeline-async', performance.now() - t0, 'pipeline', t0);
      p.then(end, end);
      return p;
    };
  }
  // WebGL 2 backend: linking is where a driver compiles (and getProgramParameter waits for it).
  const G = (globalThis as Any).WebGL2RenderingContext?.prototype;
  wrap(G, 'linkProgram', 'gl-link');
}

/**
 * The shadow pass draws every caster with one material per light and borrows what it needs from the caster's own
 * material (its colour's alpha, its map, its mask, a moved position). three r186 makes those borrowed nodes anew for
 * every material (`_getShadowNodes`), and a node's id is part of the shader's cache key: materials alike but not one
 * (Actors gives every person their own, sharing the nodes) each built their own shadow shader, the same code over
 * again. Here the borrowed nodes are made once per kind of material (the nodes it lends, whether it has a map) and
 * the map is read from the mesh drawn (`material.map` of the object), so all such casters share one shader.
 * Returns false (and leaves three's way) if the internal is renamed.
 */
export function shareShadowNodes(renderer: WebGPURenderer): boolean {
  const r = renderer as Any;
  if (typeof r._getShadowNodes !== 'function' || r._getShadowNodes.shared) return typeof r._getShadowNodes === 'function';
  const kinds = new Map<string, { colorNode: Any; depthNode: Any; positionNode: Any }>();
  const shared = function (this: Any, material: Any) {
    const key = shadowKindOf(material);
    let kind = kinds.get(key);
    if (!kind) kinds.set(key, (kind = shadowNodes(material, this.shadowMap?.transmitted === true)));
    return kind;
  };
  shared.shared = true;
  r._getShadowNodes = shared;
  return true;
}

const isNode = (n: Any): boolean => !!n?.isNode;
const idOf = (n: Any): string => (isNode(n) ? String(n.id) : '-');

/** What a material lends the shadow pass, as a key: materials with the same key get the same nodes. */
export function shadowKindOf(m: Any): string {
  return [m.map?.isTexture ? 'map' : '', idOf(m.colorNode), idOf(m.castShadowNode), idOf(m.maskShadowNode), idOf(m.maskNode), idOf(m.depthNode), idOf(m.castShadowPositionNode), idOf(m.positionNode)].join(',');
}

/** The map of the material of the mesh drawn (the first with a map, for a mesh with several). */
class DrawnMapNode extends (ReferenceNode as Any) {
  constructor() { super('map', 'texture', null); }
  updateReference(state: Any): Any {
    const m = state?.object?.material;
    this.reference = Array.isArray(m) ? (m.find((x: Any) => x?.map) ?? m[0]) : m;
    return this.reference;
  }
}

/** three r186's Renderer._getShadowNodes, with the map read from the mesh drawn instead of from `m`. */
function shadowNodes(m: Any, transmitted: boolean): { colorNode: Any; depthNode: Any; positionNode: Any } {
  const hasMap = !!m.map?.isTexture, hasColor = isNode(m.colorNode), hasCast = isNode(m.castShadowNode);
  const mask = isNode(m.maskShadowNode) ? m.maskShadowNode : isNode(m.maskNode) ? m.maskNode : null;
  let colorNode: Any = null;
  if (hasMap || hasColor || hasCast || mask) {
    let rgb: Any, alpha: Any;
    if (hasCast) {
      rgb = m.castShadowNode.rgb;
      alpha = m.castShadowNode.a;
      if (!transmitted) console.warn('Renderer: `shadowMap.transmitted` needs to be set to `true` when using `material.castShadowNode`.');
    } else {
      rgb = vec3(0);
      alpha = float(1);
    }
    if (hasMap) alpha = alpha.mul((nodeObject as Any)(new DrawnMapNode()).a);
    if (hasColor) alpha = alpha.mul(m.colorNode.a);
    colorNode = vec4(rgb, alpha);
    if (mask) colorNode = (Fn as Any)(([color]: Any[]) => { mask.not().discard(); return color; })(colorNode);
  }
  const depthNode = isNode(m.depthNode) ? m.depthNode : null;
  const positionNode = isNode(m.castShadowPositionNode) ? m.castShadowPositionNode : isNode(m.positionNode) ? m.positionNode : null;
  return { colorNode, depthNode, positionNode };
}

/**
 * A StaticBundle's replay still refreshed every object in it fully each frame: three's NodeMaterialObserver returns
 * FULL for any node material (`hasNode`) before it looks at bundles, so the per-object update a bundle should save
 * ran anyway (the terrain's 291 chunks cost more bundled than not). For an object in a StaticBundle whose recording
 * and matrix are as they were, the refresh is SHARED instead (its nodes update and the shared, render group, uniforms
 * upload, not its own group), and NONE for the rest of the render call once one object with the same shader did that:
 * the shared uniforms are one buffer for all of them. So a StaticBundle's materials must keep their per-frame values in the render group
 * (weather, sun, time); an object's own uniforms go up only when it is recorded again or moves.
 */
function fixedBundleUniforms(renderer: WebGPURenderer): boolean {
  const nodes = (renderer as Any)._nodes;
  const needsRefresh = nodes?.needsRefresh;
  if (typeof needsRefresh !== 'function') return false;
  const FULL = 2, SHARED = 1, NONE = 0;
  const sharedDone = new WeakMap<object, number>();
  nodes.needsRefresh = function (this: Any, ro: Any) {
    const r = needsRefresh.call(this, ro);
    const b = ro?.bundle;
    if (r !== FULL || !b?.isStaticBundle) return r;
    const m = ro.object.matrixWorld.elements as number[];
    const seen = ro.fixedSeen as { version: number; m: Float32Array } | undefined;
    if (seen && seen.version === b.version && m.every((v, i) => v === seen.m[i])) {
      const state = this.get(ro)?.nodeBuilderState, renderId = this.getNodeFrameForRender?.(ro)?.renderId;
      if (!state || renderId === undefined) return SHARED;
      if (sharedDone.get(state) === renderId) return NONE;
      sharedDone.set(state, renderId);
      return SHARED;
    }
    ro.fixedSeen = { version: b.version, m: Float32Array.from(m) };
    return FULL;
  };
  return true;
}
