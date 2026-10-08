/**
 * Start-up warm-up behind the loading screen: everything that would otherwise stall the first
 * seconds of play is done here.
 *
 * Shader compiles are only part of it. The first time a mesh is *drawn* the GPU process still
 * does work three's compile() never triggers: geometry and instance buffers are uploaded, textures
 * that were never bound are uploaded, and ANGLE (D3D11) builds the input-layout / render-target
 * variants of a linked program (with a cold shader cache that is the actual HLSL compile, about
 * 0.1 s per program). Those stalls happen in the GPU process — a frame that comes 200–500 ms late —
 * whenever the camera first looks at something new: measured as the big hitches when the player
 * turned round in the first seconds.
 *
 * So the warm-up
 *  1. stages one small mesh of every material that appears later (interiors, tree species, street
 *     furniture, stand-ins, cutscene content) in front of the camera,
 *  2. uploads every texture the scene references (initTexture),
 *  3. compiles the whole scene in parallel (compileAsync) before the first frame — started earlier,
 *     that frame compiled every program one after the other,
 *  4. starts the frame loop with the shader gate on (meshes appearing now — rigs that finished
 *     loading, the first crowd — compile in parallel instead of blocking a frame),
 *  5. renders real frames from several views — all round the start, plus a cutscene's shots —
 *     with every empty instanced batch (cars, crowds, FX with nothing to show yet) drawn once,
 *  6. waits for calm frames.
 *
 * `?warm=0` runs the previous warm-up instead (for A/B measurements).
 */
import * as THREE from 'three';
import type { Renderer } from './Renderer';

export interface WarmView {
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

export interface WarmHost {
  renderer: Renderer;
  /** Resolves after the game's next frame. */
  nextFrame(): Promise<void>;
  /** Starts the game's frame loop. */
  startLoop(): void;
  gate: { enabled: boolean; readonly busy: number; waiting(): string[] };
}

export interface WarmOpts {
  /** Small meshes of content that appears later; the old warm-up compiled only these (out of view). */
  staging?: THREE.Object3D[];
  /** More of it, staged in view (the old warm-up compiled these in the background after the start). */
  later?: THREE.Object3D[];
  /** Extra views to render from (a cutscene's shots). */
  views?: WarmView[];
}

export interface WarmReport {
  legacy: boolean;
  textures: number;
  texMs: number;
  compileMs: number;
  views: number;
  viewsMs: number;
  calmMs: number;
  totalMs: number;
  programs: number;
  /** Programs that existed when the parallel compile had finished (the rest were compiled while rendering). */
  programsCompiled: number;
  /** What the shader gate was still waiting for when the warm-up ended. */
  gateWaiting: string[];
  /** WebGPU only: node shader builds after compile, after the views, at the end. */
  nodeBuilds?: number[];
}

export const LEGACY_WARMUP = new URLSearchParams(location.search).get('warm') === '0';

export async function warmUp(host: WarmHost, progress: (f: number) => void, opts: WarmOpts = {}): Promise<WarmReport> {
  return LEGACY_WARMUP ? legacy(host, progress, opts) : current(host, progress, opts);
}

async function current(host: WarmHost, progress: (f: number) => void, opts: WarmOpts): Promise<WarmReport> {
  const R = host.renderer, gl = R.gl, scene = R.scene, cam = R.camera;
  const t0 = performance.now();
  const rep: WarmReport = { legacy: false, textures: 0, texMs: 0, compileMs: 0, views: 0, viewsMs: 0, calmMs: 0, totalMs: 0, programs: 0, programsCompiled: 0, gateWaiting: [] };
  // 1. Staging, in front of the camera (moved along into every view below).
  const stage = new THREE.Group();
  stage.name = 'warm-stage';
  for (const o of [...(opts.staging ?? []), ...(opts.later ?? [])]) stage.add(o);
  const placeStage = () => {
    stage.position.copy(cam.position).addScaledVector(cam.getWorldDirection(_v), 3);
    stage.updateMatrixWorld(true);
  };
  placeStage();
  scene.add(stage);
  // 2. Textures.
  const tt = performance.now();
  const seen = new Set<THREE.Texture>();
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (m) for (const x of Array.isArray(m) ? m : [m]) texturesOf(x, seen);
    const dm = (o as THREE.Mesh).customDepthMaterial;
    if (dm) texturesOf(dm, seen);
  });
  for (const t of seen) {
    // (Render targets' textures and videos are set up by their owners.)
    if ((t as THREE.Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture || (t as THREE.VideoTexture).isVideoTexture) continue;
    if (!t.image && !(t as THREE.DataTexture).isDataTexture && !(t as THREE.DataArrayTexture).isDataArrayTexture) continue;
    try { gl.initTexture(t); rep.textures++; } catch { /* not uploadable yet */ }
  }
  rep.texMs = performance.now() - tt;
  progress(0.1);
  // 3. Compile, then 4. the frame loop with the gate on.
  const tc = performance.now();
  // (WebGPU: in parts, a few compiling at once, so their pipelines compile in parallel.)
  await (R.webgpu ? Promise.all(compileParts(scene, 32).map((o) => R.compileAsync(o))) : R.compileAsync(scene));
  rep.compileMs = performance.now() - tc;
  rep.programsCompiled = (gl.info.programs ?? []).length;
  const builds = (window as unknown as { nodeBuilds?: { count: number } }).nodeBuilds;
  if (builds) rep.nodeBuilds = [builds.count];
  // (Gate first: startLoop runs the first frame at once, and what that frame adds — vehicle and
  // FX batches, the first crowd — would otherwise compile one program after the other in it.)
  host.gate.enabled = true;
  host.startLoop();
  progress(0.4);
  // 5. Views: real frames from all round and from the given shots, empty batches drawn once.
  const tv = performance.now();
  const views: WarmView[] = [];
  const p = cam.position.clone();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    views.push({ pos: p, look: p.clone().add(new THREE.Vector3(Math.sin(a), -0.12, Math.cos(a))) });
  }
  views.push({ pos: p, look: p.clone().add(new THREE.Vector3(0.2, 1, 0)) });
  views.push(...(opts.views ?? []));
  const forced: { m: THREE.InstancedMesh; culled: boolean }[] = [];
  scene.traverseVisible((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && im.count === 0 && im.instanceMatrix.count > 0) forced.push({ m: im, culled: im.frustumCulled });
  });
  const saved = { pos: cam.position.clone(), q: cam.quaternion.clone() };
  for (let i = 0; i < views.length; i++) {
    const v = views[i];
    cam.position.copy(v.pos);
    cam.lookAt(v.look);
    cam.updateMatrixWorld();
    placeStage();
    const first = i === 0;
    if (first) for (const f of forced) { f.m.count = 1; f.m.frustumCulled = false; }
    try { R.render(); } finally {
      if (first) for (const f of forced) { f.m.count = 0; f.m.frustumCulled = f.culled; }
    }
    rep.views++;
    cam.position.copy(saved.pos);
    cam.quaternion.copy(saved.q);
    await host.nextFrame();
    progress(0.4 + 0.4 * ((i + 1) / views.length));
  }
  rep.viewsMs = performance.now() - tv;
  if (builds) rep.nodeBuilds!.push(builds.count);
  scene.remove(stage);
  // 6. Calm frames; meanwhile the gate's parallel compiles finish (not waiting forever on one).
  const tw = performance.now();
  let calm = 0;
  // (WebGPU: new meshes stay hidden until their background compile is done; wait for those longer.)
  const busyMs = R.webgpu ? 20000 : 3000;
  while ((calm < 20 || (host.gate.busy > 0 && performance.now() - tw < busyMs)) && performance.now() - tw < Math.max(8000, busyMs)) {
    const f0 = performance.now();
    await host.nextFrame();
    calm = performance.now() - f0 < 45 ? calm + 1 : 0;
    progress(0.8 + 0.2 * Math.min(1, calm / 20));
  }
  rep.calmMs = performance.now() - tw;
  rep.totalMs = performance.now() - t0;
  rep.programs = (gl.info.programs ?? []).length;
  rep.gateWaiting = host.gate.waiting().slice(0, 20);
  if (builds) rep.nodeBuilds!.push(builds.count);
  return rep;
}

/**
 * The visible subtrees of `scene` as about `n` parts of similar size (by object count): groups
 * without a material of their own are opened up, largest first. Compiling the parts compiles what
 * compiling the scene does.
 */
function compileParts(scene: THREE.Scene, n: number): THREE.Object3D[] {
  const size = new Map<THREE.Object3D, number>();
  const count = (o: THREE.Object3D): number => {
    let c = 1;
    for (const ch of o.children) if (ch.visible) c += count(ch);
    size.set(o, c);
    return c;
  };
  count(scene);
  let parts = scene.children.filter((o) => o.visible);
  for (;;) {
    if (parts.length >= n) break;
    const open = parts
      .filter((o) => !(o as THREE.Mesh).material && o.children.some((c) => c.visible))
      .sort((a, b) => size.get(b)! - size.get(a)!)[0];
    if (!open) break;
    parts = parts.filter((o) => o !== open).concat(open.children.filter((c) => c.visible));
  }
  return parts;
}

/** The previous warm-up: frame loop first, compile the scene (staging out of view), calm frames. */
async function legacy(host: WarmHost, progress: (f: number) => void, opts: WarmOpts): Promise<WarmReport> {
  const R = host.renderer, scene = R.scene, cam = R.camera;
  const t0 = performance.now();
  const rep: WarmReport = { legacy: true, textures: 0, texMs: 0, compileMs: 0, views: 0, viewsMs: 0, calmMs: 0, totalMs: 0, programs: 0, programsCompiled: 0, gateWaiting: [] };
  host.startLoop();
  const warm = new THREE.Group();
  for (const o of opts.staging ?? []) warm.add(o);
  warm.position.copy(cam.position).y -= 50;
  scene.add(warm);
  const tc = performance.now();
  await R.compileAsync(scene);
  scene.remove(warm);
  rep.compileMs = performance.now() - tc;
  const tw = performance.now();
  let calm = 0;
  while (calm < 20 && performance.now() - tw < 8000) {
    const f0 = performance.now();
    await host.nextFrame();
    calm = performance.now() - f0 < 45 ? calm + 1 : 0;
    progress(Math.min(1, calm / 20));
  }
  rep.calmMs = performance.now() - tw;
  rep.totalMs = performance.now() - t0;
  rep.programs = (R.gl.info.programs ?? []).length;
  return rep;
}

const _v = new THREE.Vector3();

function texturesOf(m: THREE.Material, out: Set<THREE.Texture>): void {
  for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) out.add(v as THREE.Texture);
  const u = (m as THREE.ShaderMaterial).uniforms;
  if (u) for (const k in u) {
    const v = u[k]?.value;
    if (v && (v as THREE.Texture).isTexture) out.add(v as THREE.Texture);
    else if (Array.isArray(v)) for (const x of v) if (x && (x as THREE.Texture).isTexture) out.add(x as THREE.Texture);
  }
}
