/**
 * Shader gate: no mesh ever waits for a shader compile on the render path.
 *
 * Every mesh added to the scene passes through the gate once (per material). Its
 * real program is requested with the parallel-compile extension (the driver compiles
 * on its own threads). If it is not ready yet, the mesh is shown with a stand-in
 * material whose program is already compiled (plain Lambert matching colour, map and
 * vertex colours) — or, for materials with custom shader code that a stand-in cannot
 * imitate (vertex animation, element collapse, discards), it is hidden until ready.
 * When the real program reports ready the material is swapped back.
 *
 * Programs are shared by key, so after a short while nearly every new mesh finds its
 * program compiled and passes straight through. A background queue (`precompile`)
 * compiles known variants ahead of time; `stats.late` records what still had to wait.
 */
import * as THREE from 'three';
import { WEBGPU } from './gpuMode';
import { shaderCap } from './shaderCap';

type Policy = 'pass' | 'standin' | 'hide';

interface Pending {
  mesh: THREE.Mesh;
  slot: number; // -1 = single material
  real: THREE.Material;
  /** The real program this mesh needs (captured when requested). */
  prog: { isReady(): boolean } | null;
  standin: THREE.Material | null;
  t0: number;
  castShadow: boolean;
}

/** Hidden meshes leave layer 0 for this layer (cameras and shadow cameras render layer 0). */
const HIDDEN_LAYER = 30;
/** A mesh waits at most this long for its program, then it is shown anyway. */
const GIVE_UP_MS = 8000;
/** How long a mesh checked without a shadow is watched for its shadow being switched on (ms). */
const SHADOW_WATCH_MS = 10000;

/** Released by three (no material uses it any more): deleted, it will never report ready. */
function released(p: { isReady(): boolean }): boolean {
  return (p as { usedTimes?: number }).usedTimes === 0;
}

export class ShaderGate {
  readonly stats = { checked: 0, passed: 0, standins: 0, hidden: 0, swapped: 0, shadowWaits: 0, lateShadows: 0, lateShadowNames: [] as string[], late: [] as { what: string; ms: number }[] };
  private seen = new WeakMap<THREE.Object3D, THREE.Material | THREE.Material[]>();
  private queue: THREE.Object3D[] = [];
  private pending: Pending[] = [];
  private lightScene: THREE.Scene;
  private shadowScene: THREE.Scene;
  private depthMats = new Map<string, THREE.MeshDepthMaterial>();
  private shadowWait: { mesh: THREE.Mesh; progs: { isReady(): boolean }[] }[] = [];
  /**
   * Meshes checked while they cast no shadow, watched for a while: their owner may switch the
   * shadow on just after adding them (a rig's garments get theirs on the rig's next update, which
   * for some rigs comes a frame after the gate looked). Their shadow-pass programs then compile
   * here instead of at the first shadow draw.
   */
  private shadowLater: { mesh: THREE.Mesh; until: number }[] = [];
  private lights: THREE.Light[] = [];
  private lightCount = -1;
  private lightsAt = -1e9;
  /** A light was added since the last refresh. */
  lightsDirty = true;
  private standins = new Map<string, THREE.MeshLambertMaterial>();
  private props: { get(o: object): { currentProgram?: { isReady(): boolean } } };
  private warm: { o: THREE.Object3D; t0: number }[] = [];
  enabled = true;
  /** Set when the start-up warm-up has finished; the shader cap starts after that. */
  warmedUp = false;

  private shadersBefore = -1;
  /** New meshes waiting for room under the shader cap (hidden meanwhile). */
  private backlog: THREE.Object3D[] = [];
  private parked = new WeakSet<THREE.Object3D>();

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.Camera, private asScenePass: <T>(fn: () => T) => T = (fn) => fn()) {
    this.props = (renderer as unknown as { properties: ShaderGate['props'] }).properties;
    // Compile against the real scene state (fog, environment) and its lights, without
    // traversing the whole scene for every request.
    this.lightScene = Object.create(scene) as THREE.Scene;
    (this.lightScene as unknown as { traverseVisible: (cb: (o: THREE.Object3D) => void) => void }).traverseVisible = (cb) => { for (const l of this.lights) cb(l); };
    // The shadow pass renders with the scene's lights but without fog / environment.
    this.shadowScene = new THREE.Scene();
    (this.shadowScene as unknown as { traverseVisible: (cb: (o: THREE.Object3D) => void) => void }).traverseVisible = (cb) => { for (const l of this.lights) cb(l); };
    // Every subtree added anywhere is looked at once.
    const gate = this;
    const add = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function (this: THREE.Object3D, ...objs: THREE.Object3D[]) {
      const r = add.apply(this, objs);
      if (gate.enabled) for (const o of objs) gate.queue.push(o);
      // A light (or a group holding lights) joining: programs depend on the light count, so the
      // next compile must use the new set (a stale one compiled programs nobody draws with).
      for (const o of objs) if ((o as THREE.Light).isLight || o.children.some((c) => (c as THREE.Light).isLight)) gate.lightsDirty = true;
      return r;
    };
    if (!WEBGPU) this.hookShadowPass();
  }

  // ------------------------------------------------------------------ shadow priming

  /** Meshes to draw once into the shadow map (see primeShadows), with how often each was tried. */
  private primeQueue: { mesh: THREE.Mesh; progs: { isReady(): boolean }[]; t0: number }[] = [];
  /** Shadow priming: meshes drawn, and the frames that drew some. */
  readonly primeStats = { meshes: 0, frames: 0 };

  /**
   * Draw these meshes (castShadow ones under `root`, visible or not) once into the shadow map,
   * writing nothing: one triangle each, colour and depth writes off.
   *
   * A compiled program is not the whole cost: the first time it draws with a new kind of vertex
   * data or into a new kind of target, ANGLE (D3D11) builds that variant of the shader in the GPU
   * process, which holds up the frame (a skinned figure's shadow, the first time a new rig cast
   * one: 177 ms on Arnd's PC). The warm-up primes the hidden stand-in people this way, which are
   * never drawn otherwise, so the people met later find those variants built.
   */
  primeShadows(root: THREE.Object3D): void {
    // (No shadow map, no shadow variants: a start without shadows compiled none either.)
    if (WEBGPU || !this.renderer.shadowMap.enabled) return;
    if (this.lightsDirty) this.refreshLights();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.castShadow) return;
      // (Their programs first: a draw before they are ready would wait for them.)
      const progs = this.compileShadow(m, Array.isArray(m.material) ? m.material : [m.material]);
      this.primeQueue.push({ mesh: m, progs, t0: performance.now() });
    });
  }

  /** After three's shadow pass (while its render state is set up), draws the queued primes. */
  private hookShadowPass(): void {
    const sm = this.renderer.shadowMap as THREE.WebGLShadowMap & { render: (lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera) => void };
    if (!sm || typeof sm.render !== 'function') return;
    const orig = sm.render.bind(sm);
    sm.render = (lights, scene, camera) => {
      const ran = sm.enabled && (sm.autoUpdate || sm.needsUpdate) && lights.length > 0;
      orig(lights, scene, camera);
      if (ran && this.primeQueue.length) this.primeDraws(lights);
    };
  }

  private primeDraws(lights: THREE.Light[]): void {
    const light = lights.find((l) => (l as THREE.DirectionalLight).shadow?.map) as THREE.DirectionalLight | undefined;
    if (!light || (light as unknown as THREE.PointLight).isPointLight) return;
    const R = this.renderer, cam = light.shadow.camera;
    const prev = R.getRenderTarget(), face = R.getActiveCubeFace(), mip = R.getActiveMipmapLevel();
    R.setRenderTarget(light.shadow.map as unknown as THREE.WebGLRenderTarget);
    let drawn = 0;
    try {
      this.primeQueue = this.primeQueue.filter((q) => {
        const mesh = q.mesh;
        if (!this.inScene(mesh)) return false;
        if (drawn >= 32) return true;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const shown = mats.filter((m) => m && m.visible);
        // Not compiled yet: next frame (a few seconds at most, then left to the real draw).
        if (!q.progs.every((p) => released(p) || p.isReady())) return true;
        const geo = mesh.geometry, dr = geo.drawRange, start = dr.start, count = dr.count;
        geo.setDrawRange(0, 3);
        mesh.modelViewMatrix.multiplyMatrices(cam.matrixWorldInverse, mesh.matrixWorld);
        try {
          for (const m of shown) {
            // (Set up per material, as three does: a shared depth material differs per draw.)
            const d = this.depthFor(mesh, m);
            const cw = d.colorWrite, dw = d.depthWrite;
            d.colorWrite = false; d.depthWrite = false;
            try { R.renderBufferDirect(cam, null as unknown as THREE.Scene, geo, d, mesh, null as unknown as THREE.GeometryGroup); } finally { d.colorWrite = cw; d.depthWrite = dw; }
          }
        } finally {
          geo.setDrawRange(start, count);
        }
        drawn++;
        this.primeStats.meshes++;
        return false;
      });
    } finally {
      R.setRenderTarget(prev, face, mip);
    }
    if (drawn) this.primeStats.frames++;
  }

  /** Mark everything currently in the scene as known (after the start-up warm-up). */
  adoptScene(): void {
    this.scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) this.seen.set(o, m); });
    this.queue.length = 0;
  }

  /**
   * WebGPU: how to compile a subtree in the background (the renderer's compileAsync). Its
   * pipelines are built off the render path, and the frames skip a mesh whose pipeline is still
   * being built; but a mesh drawn before that request would have them built on the spot, so new
   * meshes leave the camera's layer until their compile has finished.
   */
  gpuCompile: ((o: THREE.Object3D) => Promise<unknown>) | null = null;
  private gpuPending = 0;
  /** WebGPU: what each background compile still running was started for (for the warm-up report). */
  private gpuWhat = new Map<number, string>();
  private gpuIds = 0;
  private idleLogAt = -1e9;

  private updateWebGPU(): void {
    if (!this.queue.length || !this.gpuCompile) return;
    const q = this.queue;
    this.queue = [];
    for (const root of q) {
      if (!this.inScene(root)) continue;
      const fresh: THREE.Object3D[] = [];
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (!m || this.seen.get(o) === m) return;
        this.seen.set(o, m);
        this.stats.checked++;
        if (o.layers.isEnabled(0)) fresh.push(o);
      });
      if (!fresh.length) continue;
      const t0 = performance.now();
      const done = this.gpuCompile(root);
      // (After the call: it has already collected what to compile, by layer.)
      for (const o of fresh) { o.layers.disable(0); o.layers.enable(HIDDEN_LAYER); }
      this.stats.hidden += fresh.length;
      this.gpuPending++;
      const id = ++this.gpuIds;
      this.gpuWhat.set(id, `${root.name || root.type} (${fresh.length}): ${describe(fresh[0] as THREE.Mesh, (fresh[0] as THREE.Mesh).material as THREE.Material)}`);
      const show = (): void => {
        this.gpuPending--;
        this.gpuWhat.delete(id);
        if (this.gpuPending === 0 && performance.now() - this.idleLogAt > 30000) {
          this.idleLogAt = performance.now();
          const longest = this.stats.late.reduce((a, l) => Math.max(a, l.ms), 0);
          console.log(`[gate] background compiles done at ${(performance.now() / 1000).toFixed(1)} s: ${this.stats.hidden} meshes waited so far, longest ${longest} ms`);
        }
        for (const o of fresh) if (o.layers.isEnabled(HIDDEN_LAYER)) { o.layers.enable(0); o.layers.disable(HIDDEN_LAYER); }
        this.stats.swapped += fresh.length;
        const ms = performance.now() - t0;
        if (ms > 100) {
          this.stats.late.push({ what: describe(fresh[0] as THREE.Mesh, (fresh[0] as THREE.Mesh).material as THREE.Material), ms: Math.round(ms) });
          if (this.stats.late.length > 200) this.stats.late.shift();
        }
      };
      done.then(show, (e) => { console.warn('[gate] compile', e); show(); });
    }
  }

  // ---- the cap ------------------------------------------------------

  /** New shaders so far: three's program ids count up (WebGL); node builds (WebGPU). */
  private shadersSoFar(): number {
    if (WEBGPU) return (window as unknown as { nodeBuilds?: { count: number } }).nodeBuilds?.count ?? 0;
    const progs = (this.renderer.info as unknown as { programs?: { id: number }[] }).programs ?? [];
    return progs.length ? progs[progs.length - 1].id : 0;
  }

  /** Book the new shaders since the last look (whoever started them). True if there were any. */
  private account(): boolean {
    const n = this.shadersSoFar();
    const d = this.shadersBefore < 0 ? 0 : n - this.shadersBefore;
    this.shadersBefore = n;
    shaderCap.book(d);
    if (d > 0) {
      const now = performance.now();
      this.recent.push([now, d]);
      while (this.recent.length && this.recent[0][0] < now - 10000) this.recent.shift();
    }
    return d > 0;
  }

  /** Meshes to look at this frame: those waiting for room first, then the newly added ones. */
  private newMeshes(): THREE.Object3D[] {
    const out = this.backlog;
    this.backlog = [];
    const q = this.queue;
    this.queue = [];
    for (const root of q) root.traverse((o) => {
      if (!(o as THREE.Mesh).material || this.parked.has(o)) return;
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) out.push(o);
    });
    return out;
  }

  private park(o: THREE.Object3D): void {
    this.backlog.push(o);
    if (this.parked.has(o) || !o.layers.isEnabled(0)) return;
    this.parked.add(o);
    o.layers.disable(0); o.layers.enable(HIDDEN_LAYER);
  }

  private unpark(o: THREE.Object3D): void {
    if (!this.parked.has(o)) return;
    this.parked.delete(o);
    o.layers.enable(0); o.layers.disable(HIDDEN_LAYER);
  }

  /** Per frame, before rendering. */
  update(): void {
    // (Shaders built while drawing the last frame count too.)
    this.account();
    shaderCap.newFrame();
    // The cap starts once the start-up compiles (warm-up and the background precompiles) are done.
    // (Not during the warm-up: its first frame comes before the gate has looked at what that frame
    // added, so `busy` read 0 there and the cap held the rest of the warm-up to 5 builds a second.)
    if (!shaderCap.active && this.warmedUp && this.enabled && this.busy === 0) shaderCap.active = true;
    if (WEBGPU) { this.updateWebGPU(); return; }
    if (this.queue.length && (this.lightsDirty || performance.now() - this.lightsAt > 2000)) this.refreshLights();
    // New objects, one by one while there is room under the cap.
    if (this.queue.length || this.backlog.length) {
      for (const o of this.newMeshes()) {
        if (!this.inScene(o)) { this.unpark(o); continue; }
        const m = (o as THREE.Mesh).material;
        if (!m || this.seen.get(o) === m) { this.unpark(o); continue; }
        if (!shaderCap.room()) { this.park(o); continue; }
        this.unpark(o);
        this.check(o);
        if (this.account()) shaderCap.take();
      }
      shaderCap.waiting = this.backlog.length;
    }
    // Waiting meshes: swap back when their real program is ready.
    if (this.pending.length) {
      const now = performance.now();
      this.pending = this.pending.filter((p) => {
        // The program asked for can be released before it is ready (its material switched to
        // another variant meanwhile, e.g. an instanced batch got its colours): a deleted program
        // never reports ready, so ask again for the one the mesh needs now.
        if (p.prog && released(p.prog)) p.prog = this.request(p.mesh, p.real);
        // (Never wait forever: past the limit it is shown and compiles when drawn.)
        if (now - p.t0 < GIVE_UP_MS && (p.prog ? !p.prog.isReady() : !this.ready(p.real))) return true;
        this.restore(p);
        const ms = now - p.t0;
        this.stats.swapped++;
        if (ms > 30) {
          this.stats.late.push({ what: describe(p.mesh, p.real), ms: Math.round(ms) });
          if (this.stats.late.length > 200) this.stats.late.shift();
        }
        return false;
      });
    }
    if (this.shadowLater.length) {
      const now = performance.now();
      this.shadowLater = this.shadowLater.filter((w) => {
        if (w.mesh.castShadow && this.lateShadow(w.mesh)) return false;
        return now < w.until;
      });
    }
    if (this.shadowWait.length) {
      this.shadowWait = this.shadowWait.filter((w) => {
        if (!w.progs.every((p) => released(p) || p.isReady())) return true;
        if (!this.pending.some((p) => p.mesh === w.mesh)) {
          const c = this.shadowCast.get(w.mesh);
          w.mesh.castShadow = c ?? true;
          this.shadowCast.delete(w.mesh);
        }
        return false;
      });
    }
    // Primes left undrawn (the shadow map off or not updating, programs never ready): given up.
    if (this.primeQueue.length) {
      const now = performance.now();
      if (!this.renderer.shadowMap.enabled) this.primeQueue.length = 0;
      else this.primeQueue = this.primeQueue.filter((q) => now - q.t0 < GIVE_UP_MS);
    }
    // Background precompiles finished?
    if (this.warm.length) this.warm = this.warm.filter((w) => !this.allReady(w.o));
  }

  /**
   * Compile an object's materials in the background (not shown, not added to the scene).
   * Used for stand-in meshes of content that appears later.
   */
  precompile(o: THREE.Object3D): void {
    if (WEBGPU) {
      void this.gpuCompile?.(o).catch((e) => console.warn('[gate] precompile', e));
      return;
    }
    this.refreshLights();
    this.asScenePass(() => this.renderer.compile(o, this.camera, this.lightScene));
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh && m.castShadow) this.compileShadow(m, Array.isArray(m.material) ? m.material : [m.material]);
    });
    this.warm.push({ o, t0: performance.now() });
  }

  /** New shaders (whoever started them) in the last 10 s: [time, count]. */
  private recent: [number, number][] = [];

  /**
   * For the freeze log: 'seen' (checked with the material it has now), 'waiting' (new, hidden until
   * there is room under the shader cap: its programs came from a background compile, not a draw) or
   * 'NEVER' (drawn without a check: its program compiled while drawing).
   */
  stateOf(o: THREE.Object3D): string {
    if (this.seen.get(o) === (o as THREE.Mesh).material) return 'seen';
    return this.parked.has(o) || this.queue.includes(o) ? 'waiting' : 'NEVER';
  }

  /** One line for the freeze log: what the gate waits for and how many shaders started lately. */
  stateLine(): string {
    const now = performance.now();
    let n2 = 0, n10 = 0;
    for (const [t, d] of this.recent) { if (t > now - 10000) n10 += d; if (t > now - 2000) n2 += d; }
    const oldest = this.pending.reduce((a, p) => Math.max(a, now - p.t0), 0);
    return `gate: ${this.pending.length} waiting${this.pending.length ? ` (oldest ${(oldest / 1000).toFixed(1)} s: ${describe(this.pending[0].mesh, this.pending[0].real)})` : ''}, ${this.shadowWait.length} shadow, ${this.warm.length} precompiles, ${this.backlog.length} under cap; shaders started last 2 s: ${n2}, last 10 s: ${n10}`;
  }

  get busy(): number { return this.pending.length + this.warm.length + this.gpuPending + this.primeQueue.length; }

  /** What is still waiting for its shader (for the warm-up report). */
  waiting(): string[] {
    const gpu = new Map<string, number>();
    for (const w of this.gpuWhat.values()) gpu.set(w, (gpu.get(w) ?? 0) + 1);
    return [...this.pending.map((p) => describe(p.mesh, p.real)), ...this.warm.map((w) => `precompile ${w.o.name || w.o.type}`), ...[...gpu].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n}× ${w}`)];
  }

  // ------------------------------------------------------------------

  private check(o: THREE.Object3D): void {
    const mesh = o as THREE.Mesh;
    if (!(mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) return;
    const mat = mesh.material;
    if (!mat || this.seen.get(o) === mat) return;
    this.seen.set(o, mat);
    const mats = Array.isArray(mat) ? mat : [mat];
    // Request the real programs (non-blocking with KHR_parallel_shader_compile).
    this.compileFor(mesh);
    const progs = new Map<THREE.Material, { isReady(): boolean }>();
    for (const m of mats) { const pr = this.props.get(m).currentProgram; if (pr) progs.set(m, pr); }
    mats.forEach((m, i) => {
      this.stats.checked++;
      if (this.ready(m)) { this.stats.passed++; return; }
      this.gate(mesh, Array.isArray(mat) ? i : -1, m, progs);
    });
    // Shadow-pass variants: compile them too; the mesh casts no shadow until they are ready.
    if (mesh.castShadow || this.pending.some((p) => p.mesh === mesh && p.castShadow)) {
      const dprogs = this.compileShadow(mesh, mats);
      if (dprogs.length) {
        this.stats.shadowWaits++;
        const wasPending = this.pending.find((p) => p.mesh === mesh);
        if (!wasPending) mesh.castShadow = false;
        this.shadowWait.push({ mesh, progs: dprogs });
      }
    } else if (mesh.isMesh) {
      this.shadowLater.push({ mesh, until: performance.now() + SHADOW_WATCH_MS });
    }
  }

  /** A checked mesh started casting a shadow: compile its shadow-pass programs, no shadow until ready. */
  private lateShadow(mesh: THREE.Mesh): boolean {
    if (!this.inScene(mesh)) return false; // (not drawn yet: look again next frame)
    if (this.lightsDirty) this.refreshLights();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const dprogs = this.compileShadow(mesh, mats);
    const p = this.pending.find((q) => q.mesh === mesh);
    if (p) p.castShadow = true; // (restored with it once its real program is ready)
    if (!dprogs.length) return true;
    this.stats.lateShadows++;
    if (this.stats.lateShadowNames.length < 40) this.stats.lateShadowNames.push(describe(mesh, mats[0]));
    if (this.shadowWait.some((w) => w.mesh === mesh)) return true;
    mesh.castShadow = false;
    if (!p) this.shadowCast.set(mesh, true);
    this.shadowWait.push({ mesh, progs: dprogs });
    return true;
  }

  private gate(mesh: THREE.Mesh, slot: number, real: THREE.Material, progs: Map<THREE.Material, { isReady(): boolean }>): void {
    const policy = policyOf(real, mesh);
    if (policy === 'pass') return;
    let standin: THREE.Material | null = null;
    if (policy === 'standin') {
      standin = this.standinFor(real);
      // The stand-in itself must be ready for this kind of mesh, otherwise hide.
      if (!this.readyWith(mesh, standin)) standin = null;
    }
    const p: Pending = { mesh, slot, real, prog: progs.get(real) ?? null, standin, t0: performance.now(), castShadow: mesh.castShadow };
    if (standin) {
      if (slot < 0) mesh.material = standin;
      else (mesh.material as THREE.Material[])[slot] = standin;
      this.seen.set(mesh, mesh.material);
      this.stats.standins++;
    } else {
      mesh.layers.disable(0);
      mesh.layers.enable(HIDDEN_LAYER);
      this.stats.hidden++;
    }
    // Shadow-pass variants compile when first drawn into the shadow map: wait for the real one.
    mesh.castShadow = false;
    this.pending.push(p);
  }

  private restore(p: Pending): void {
    const m = p.mesh;
    if (p.standin) {
      const cur = p.slot < 0 ? m.material : (m.material as THREE.Material[])[p.slot];
      // The owner may have replaced the material meanwhile: then leave it alone.
      if (cur === p.standin) {
        if (p.slot < 0) m.material = p.real;
        else (m.material as THREE.Material[])[p.slot] = p.real;
      }
      this.seen.set(m, m.material);
    } else {
      m.layers.enable(0);
      m.layers.disable(HIDDEN_LAYER);
    }
    if (!this.shadowWait.some((w) => w.mesh === m)) m.castShadow = p.castShadow;
    else this.shadowCast.set(m, p.castShadow);
  }

  private shadowCast = new Map<THREE.Mesh, boolean>();

  /** Request the shadow-pass programs of a mesh; returns those not ready yet. */
  private compileShadow(mesh: THREE.Mesh, mats: THREE.Material[]): { isReady(): boolean }[] {
    const out: { isReady(): boolean }[] = [];
    for (const m of mats) {
      const dm = this.depthFor(mesh, m);
      const proxy = Object.create(mesh) as THREE.Mesh;
      proxy.material = dm;
      const root = { traverse: (cb: (o: THREE.Object3D) => void) => cb(proxy), traverseVisible: () => {} } as unknown as THREE.Object3D;
      this.asScenePass(() => this.renderer.compile(root, this.camera, this.shadowScene));
      const pr = this.props.get(dm).currentProgram;
      if (pr && !pr.isReady()) out.push(pr);
    }
    return out;
  }

  /**
   * The depth material the shadow map will use for this mesh/material (same program key), set up
   * as three's WebGLShadowMap.getDepthMaterial sets it before every shadow draw: side (flipped),
   * maps, alpha test, clipping, displacement. That includes a mesh's own customDepthMaterial, which
   * several meshes may share: a rig's shared depth material drew double-sided for the briefs and
   * the hair but had been compiled with the body's back side, so the double-sided variant was built
   * at the briefs' first shadow draw (the gentle giant's 0.2 s hitch on Arnd's PC).
   */
  private depthFor(mesh: THREE.Mesh, m: THREE.Material): THREE.Material {
    const src = m as THREE.MeshStandardMaterial;
    let d = mesh.customDepthMaterial as THREE.MeshDepthMaterial | undefined;
    if (!d) {
      const needsOwn = (src.alphaMap && src.alphaTest > 0) || (src.map && src.alphaTest > 0) || (src.displacementMap && src.displacementScale !== 0) || src.alphaToCoverage;
      // (One per kind three keeps apart: its shared one, or its copy per material that needs its own.)
      const key = needsOwn ? `${src.map ? 1 : 0}${src.alphaMap ? 1 : 0}${src.displacementMap ? 1 : 0}` : 'base';
      d = this.depthMats.get(key);
      if (!d) this.depthMats.set(key, d = new THREE.MeshDepthMaterial());
    }
    const flip = this.renderer.shadowMap.type !== THREE.VSMShadowMap;
    d.visible = src.visible;
    d.wireframe = src.wireframe ?? false;
    d.side = src.shadowSide ?? (!flip ? src.side : src.side === THREE.FrontSide ? THREE.BackSide : src.side === THREE.BackSide ? THREE.FrontSide : THREE.DoubleSide);
    d.alphaMap = src.alphaMap ?? null;
    d.alphaTest = src.alphaToCoverage ? 0.5 : (src.alphaTest ?? 0);
    d.map = src.map ?? null;
    d.clipShadows = src.clipShadows ?? false;
    d.clippingPlanes = src.clippingPlanes ?? null;
    d.clipIntersection = src.clipIntersection ?? false;
    d.displacementMap = src.displacementMap ?? null;
    d.displacementScale = src.displacementScale ?? 1;
    d.displacementBias = src.displacementBias ?? 0;
    return d;
  }

  private compileFor(mesh: THREE.Mesh): void {
    const root = { traverse: (cb: (o: THREE.Object3D) => void) => cb(mesh), traverseVisible: () => {} } as unknown as THREE.Object3D;
    this.asScenePass(() => this.renderer.compile(root, this.camera, this.lightScene));
  }

  /** Request the program of a material as drawn on this mesh (whatever the mesh shows now). */
  private request(mesh: THREE.Mesh, m: THREE.Material): { isReady(): boolean } | null {
    const proxy = Object.create(mesh) as THREE.Mesh;
    proxy.material = m;
    this.compileFor(proxy);
    return this.props.get(m).currentProgram ?? null;
  }

  /** Is the stand-in's program compiled for this mesh type (instanced / skinned / …)? */
  private readyWith(mesh: THREE.Mesh, m: THREE.Material): boolean {
    const proxy = Object.create(mesh) as THREE.Mesh;
    proxy.material = m;
    this.compileFor(proxy);
    return this.ready(m);
  }

  private ready(m: THREE.Material): boolean {
    const prog = this.props.get(m).currentProgram;
    return !!prog && prog.isReady();
  }

  private allReady(o: THREE.Object3D): boolean {
    let ok = true;
    o.traverse((c) => {
      const m = (c as THREE.Mesh).material;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) if (!this.ready(x)) ok = false;
    });
    return ok;
  }

  private standinFor(real: THREE.Material): THREE.MeshLambertMaterial {
    const r = real as THREE.MeshStandardMaterial;
    const key = `${r.map ? r.map.uuid : '-'}|${r.vertexColors ? 1 : 0}|${r.side}|${r.transparent ? 1 : 0}|${r.color ? r.color.getHexString() : 'fff'}|${r.alphaTest ?? 0}`;
    let s = this.standins.get(key);
    if (!s) {
      s = new THREE.MeshLambertMaterial({
        color: r.color ? r.color.clone() : 0xffffff, map: r.map ?? null, vertexColors: !!r.vertexColors,
        side: r.side, transparent: r.transparent, opacity: r.opacity ?? 1, alphaTest: r.alphaTest ?? 0,
        emissive: (r as THREE.MeshStandardMaterial).emissive?.clone() ?? new THREE.Color(0),
      });
      s.name = 'standin';
      this.standins.set(key, s);
    }
    return s;
  }

  /**
   * Compile the stand-in variants for each kind of mesh at start-up (plain, instanced,
   * skinned × map / vertex colours), so a stand-in never has to wait itself.
   */
  warmStandins(): THREE.Object3D {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(geo.getAttribute('position').count * 3).fill(1), 3));
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.needsUpdate = true;
    const variants = [
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      new THREE.MeshLambertMaterial({ map: tex }),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
      new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    ];
    for (const m of variants) {
      g.add(new THREE.Mesh(geo, m));
      g.add(new THREE.InstancedMesh(geo, m, 1));
    }
    return g;
  }

  private refreshLights(): void {
    // The light set is constant by design; re-collect only when the count changes.
    this.lightsAt = performance.now();
    this.lightsDirty = false;
    let n = 0;
    this.scene.traverseVisible((o) => { if ((o as THREE.Light).isLight) n++; });
    if (n === this.lightCount) return;
    this.lightCount = n;
    this.lights = [];
    this.scene.traverseVisible((o) => { if ((o as THREE.Light).isLight) this.lights.push(o as THREE.Light); });
  }

  private inScene(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === this.scene) return true;
    return false;
  }
}

/**
 * Stand-ins can imitate plain standard/physical/lambert materials. Materials with
 * custom shader code (vertex animation, discards, instanced attributes) can't be
 * imitated faithfully: hide those instead.
 */
function policyOf(m: THREE.Material, mesh: THREE.Mesh): Policy {
  if (m.name === 'standin') return 'pass';
  if ((m as THREE.ShaderMaterial).isShaderMaterial) return 'hide';
  const custom = m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile;
  if (custom) return 'hide';
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || mesh.morphTargetInfluences) return 'hide';
  if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial || (m as THREE.MeshLambertMaterial).isMeshLambertMaterial || (m as THREE.MeshBasicMaterial).isMeshBasicMaterial) return 'standin';
  return 'hide';
}

function describe(o: THREE.Object3D, m: THREE.Material): string {
  let path = o.name || o.type;
  let q = o.parent;
  for (let k = 0; k < 2 && q; k++, q = q.parent) if (q.name) path = q.name + '/' + path;
  return `${path}:${m.type}${m.name ? '(' + m.name + ')' : ''}`;
}
