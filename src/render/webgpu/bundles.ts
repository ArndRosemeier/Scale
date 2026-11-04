/**
 * Static city parts as WebGPU render bundles (AssetGenerator's StaticBundle, vendor/futuremagic/stage):
 * three records a bundle's draws once per camera and replays them, so the main thread no longer
 * walks, culls and encodes every cell mesh each frame. Each loaded city cell is one bundle
 * (CityStreamer), so a change in one cell (its LOD switching, slabs added, an element destroyed)
 * records only that cell again. `&bundles=0` turns them off.
 *
 * Installed here on top of three r186 internals (each guarded):
 *  - a bundle records again when its visible children change (`recordIfChanged`), and when a draw
 *    was left out of the recording because its pipeline was still compiling (once a build finished);
 *  - a bundle is culled as a whole against each camera (its children lose per-object culling);
 *  - replays skip the per-object uniform refresh (stage's `fixedBundleUniforms`, adapted): objects
 *    of a bundle only upload their own uniforms when recorded again, moved, or when a texture the
 *    bundle watches changed (`userData.watch`: the cell's element-state texture), so per-frame values
 *    (time, night, sun, wet, fog) must live in the render group (see common.ts `shared`).
 */
import * as THREE from 'three/webgpu';
import { StaticBundle } from '@futuremagic/stage/bundle';

// (The page's own URL: the game tidies the address bar before this module loads.)
const url = typeof location === 'undefined' ? '' : (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.name ?? location.href;
export const BUNDLES = !/[?&]bundles=0\b/.test(url);

/** Counters for dev.perf (reset by it). */
export const bundleStats = { records: 0, culled: 0, replays: 0, recordedDraws: 0, missed: 0 };

interface BundleData {
  incomplete?: number;
  stamp?: number;
  watchV?: number;
  bounds?: THREE.Sphere;
  boundsSig?: number;
  watch?: THREE.Texture | null;
  /** The lights each camera's recording was made with. */
  lights?: Map<number, string>;
}

const data = (b: StaticBundle): BundleData => b.userData as BundleData;

/** A group drawn as a render bundle (when bundles are on; else an ordinary group). */
export function staticGroup(name: string): THREE.Group {
  if (!BUNDLES) { const g = new THREE.Group(); g.name = name; return g; }
  return new StaticBundle(name);
}

/** Builds and pipelines finished so far (a recording that missed a draw waits for the next one). */
let pipesDone = 0;
export function pipelineFinished(): void { pipesDone++; }
let nodeCount = () => 0;
const builds = () => nodeCount() + pipesDone;

const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _s = new THREE.Sphere();

/** The bundle's bounds in world space: its meshes' bounding spheres (computed while their CPU copy exists). */
function bounds(b: StaticBundle): THREE.Sphere | null {
  const d = data(b);
  const sig = b.children.length * 7919 + b.version;
  if (d.bounds && d.boundsSig === sig) return d.bounds;
  const box = new THREE.Box3();
  let any = false;
  b.updateWorldMatrix(true, true);
  b.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (!(o as THREE.Mesh).isMesh || !g) return;
    if (!g.boundingSphere && g.attributes.position?.array) g.computeBoundingSphere();
    if (!g.boundingSphere) return;
    _s.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    box.expandByPoint(_s.center.clone().addScalar(_s.radius));
    box.expandByPoint(_s.center.clone().addScalar(-_s.radius));
    any = true;
  });
  d.boundsSig = sig;
  d.bounds = any ? box.getBoundingSphere(new THREE.Sphere()) : undefined;
  return d.bounds ?? null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** `nodeBuildCount`: node builds finished so far. */
export function installStaticBundles(renderer: THREE.WebGPURenderer, nodeBuildCount: () => number): string[] {
  if (!BUNDLES) return [];
  nodeCount = nodeBuildCount;
  const r = renderer as Any;
  const missing: string[] = [];

  // Recording, and culling a bundle as a whole.
  const project = r._projectObject;
  if (typeof project === 'function') {
    r._projectObject = function (this: Any, object: Any, camera: THREE.Camera, ...rest: unknown[]) {
      if (object.isStaticBundle && object.visible) {
        const b = object as StaticBundle, d = data(b);
        if (d.incomplete !== undefined && d.incomplete !== builds()) { d.incomplete = undefined; b.changed(); }
        if (b.recordIfChanged()) bundleStats.records++;
        const t = d.watch;
        if (t && t.version !== d.watchV) { d.watchV = t.version; d.stamp = (d.stamp ?? 0) + 1; }
        if (!(camera as Any).isArrayCamera) {
          const s = bounds(b);
          if (s) {
            _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            _frustum.setFromProjectionMatrix(_m, (camera as Any).coordinateSystem, (camera as Any).reversedDepth);
            if (!_frustum.intersectsSphere(s)) { bundleStats.culled++; return; }
          }
        }
        bundleStats.replays++;
      }
      return project.call(this, object, camera, ...rest);
    };
  } else missing.push('bundle projection');

  // A draw left out of a recording (pipeline still compiling): record again after the next build.
  const pipelines = r._pipelines;
  const isReady = pipelines?.isReady;
  if (typeof isReady === 'function') {
    pipelines.isReady = function (this: Any, ro: Any) {
      const ok = isReady.call(this, ro);
      const cur = r._currentRenderBundle?.bundleGroup;
      if (!ok && cur?.isStaticBundle) { data(cur).incomplete = builds(); bundleStats.missed++; }
      return ok;
    };
  } else missing.push('bundle pipeline check');

  // A render nested inside a recording (the shadow map, drawn by the first shadow receiver's
  // updateBefore) ends with three setting the current bundle to null, so every later draw of the
  // outer recording was left out of its object list: those objects never refreshed on replay, not
  // even the camera (render group) uniforms, and the cells were drawn with the camera of the frame
  // they were recorded in. The outer recording's bundle is restored after a nested render.
  const renderScene = r._renderScene;
  if (typeof renderScene === 'function') {
    r._renderScene = function (this: Any, ...a: unknown[]) {
      const outer = this._currentRenderBundle;
      this._currentRenderBundle = null;
      try { return renderScene.apply(this, a); } finally { this._currentRenderBundle = outer; }
    };
  } else missing.push('nested bundle renders');

  // Counted for dev.perf: draws that went into recordings. GPU validation errors are logged.
  const backend = r.backend;
  const draw = backend?.draw;
  if (typeof draw === 'function') {
    backend.draw = function (this: Any, ro: Any, info: unknown) {
      const cur = r._currentRenderBundle;
      if (cur?.bundleGroup?.isStaticBundle) {
        bundleStats.recordedDraws++;
      }
      return draw.call(this, ro, info);
    };
  }
  backend?.device?.addEventListener?.('uncapturederror', (e: Any) => console.error('[webgpu] GPU error:', e.error?.message ?? e));

  // A replay keeps the shaders it was recorded with: a different set of lights (one switched on or
  // off, a shadow added) records again, so the cell's shaders get the new set.
  const renderBundles = r._renderBundles;
  if (typeof renderBundles === 'function') {
    r._renderBundles = function (this: Any, bundles: Any[], sceneRef: unknown, lightsNode: Any) {
      const lights = lightsNode?.getLights?.() as THREE.Light[] | undefined;
      let key = '';
      if (lights) for (const l of lights) key += `${l.id}${l.castShadow ? 's' : ''},`;
      for (const { bundleGroup: b, camera } of bundles) {
        if (!b.isStaticBundle) continue;
        const seen = (data(b).lights ??= new Map<number, string>());
        if (seen.get(camera.id) !== key) {
          if (seen.has(camera.id)) b.changed();
          seen.set(camera.id, key);
        }
      }
      return renderBundles.call(this, bundles, sceneRef, lightsNode);
    };
  } else missing.push('bundle lights');

  // Replays without the per-object refresh (stage's fixedBundleUniforms, plus the watched texture).
  const nodes = r._nodes;
  const needsRefresh = nodes?.needsRefresh;
  if (typeof needsRefresh === 'function') {
    const FULL = 2, SHARED = 1, NONE = 0;
    const sharedDone = new WeakMap<object, number>();
    nodes.needsRefresh = function (this: Any, ro: Any) {
      const res = needsRefresh.call(this, ro);
      const b = ro?.bundle;
      if (res !== FULL || !b?.isStaticBundle) return res;
      const m = ro.object.matrixWorld.elements as number[];
      const stamp = data(b).stamp ?? 0;
      const seen = ro.fixedSeen as { version: number; stamp: number; m: Float32Array } | undefined;
      if (seen && seen.version === b.version && seen.stamp === stamp && m.every((v, i) => v === seen.m[i])) {
        const state = this.get(ro)?.nodeBuilderState, renderId = this.getNodeFrameForRender?.(ro)?.renderId;
        if (!state || renderId === undefined) return SHARED;
        if (sharedDone.get(state) === renderId) return NONE;
        sharedDone.set(state, renderId);
        return SHARED;
      }
      ro.fixedSeen = { version: b.version, stamp, m: Float32Array.from(m) };
      return FULL;
    };
  } else missing.push('fixed bundle uniforms');
  return missing;
}
