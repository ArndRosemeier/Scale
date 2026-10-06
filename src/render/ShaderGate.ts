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

/** Released by three (no material uses it any more): deleted, it will never report ready. */
function released(p: { isReady(): boolean }): boolean {
  return (p as { usedTimes?: number }).usedTimes === 0;
}

export class ShaderGate {
  readonly stats = { checked: 0, passed: 0, standins: 0, hidden: 0, swapped: 0, shadowWaits: 0, late: [] as { what: string; ms: number }[] };
  private seen = new WeakMap<THREE.Object3D, THREE.Material | THREE.Material[]>();
  private queue: THREE.Object3D[] = [];
  private pending: Pending[] = [];
  private lightScene: THREE.Scene;
  private shadowScene: THREE.Scene;
  private depthMats = new Map<string, THREE.MeshDepthMaterial>();
  private shadowWait: { mesh: THREE.Mesh; progs: { isReady(): boolean }[] }[] = [];
  private lights: THREE.Light[] = [];
  private lightCount = -1;
  private lightsAt = -1e9;
  private standins = new Map<string, THREE.MeshLambertMaterial>();
  private props: { get(o: object): { currentProgram?: { isReady(): boolean } } };
  private warm: { o: THREE.Object3D; t0: number }[] = [];
  enabled = true;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.Camera, private asScenePass: <T>(fn: () => T) => T = (fn) => fn()) {
    this.props = (renderer as unknown as { properties: ShaderGate['props'] }).properties;
    // Compile against the real scene state (fog, environment) and its lights, without
    // traversing the whole scene for every request.
    this.lightScene = Object.create(scene) as THREE.Scene;
    (this.lightScene as unknown as { traverseVisible: (cb: (o: THREE.Object3D) => void) => void }).traverseVisible = (cb) => { for (const l of this.lights) cb(l); };
    // The shadow pass renders with the scene's lights but without fog / environment.
    this.shadowScene = new THREE.Scene();
    (this.shadowScene as unknown as { traverseVisible: (cb: (o: THREE.Object3D) => void) => void }).traverseVisible = (cb) => { for (const l of this.lights) cb(l); };
    // WebGPU builds its pipelines asynchronously by itself: no gate (see docs/WEBGPU_PLAN.md).
    if (WEBGPU) { this.enabled = false; return; }
    // Every subtree added anywhere is looked at once.
    const gate = this;
    const add = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function (this: THREE.Object3D, ...objs: THREE.Object3D[]) {
      const r = add.apply(this, objs);
      if (gate.enabled) for (const o of objs) gate.queue.push(o);
      return r;
    };
  }

  /** Mark everything currently in the scene as known (after the start-up warm-up). */
  adoptScene(): void {
    this.scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) this.seen.set(o, m); });
    this.queue.length = 0;
  }

  /** Per frame, before rendering. */
  update(): void {
    if (WEBGPU) return;
    if (this.queue.length && performance.now() - this.lightsAt > 2000) this.refreshLights();
    // New objects.
    if (this.queue.length) {
      const q = this.queue;
      this.queue = [];
      for (const root of q) if (this.inScene(root)) root.traverse((o) => this.check(o));
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
    // Background precompiles finished?
    if (this.warm.length) this.warm = this.warm.filter((w) => !this.allReady(w.o));
  }

  /**
   * Compile an object's materials in the background (not shown, not added to the scene).
   * Used for stand-in meshes of content that appears later.
   */
  precompile(o: THREE.Object3D): void {
    if (WEBGPU) {
      void (this.renderer as unknown as { compileAsync(o: THREE.Object3D, c: THREE.Camera, s: THREE.Scene): Promise<void> }).compileAsync(o, this.camera, this.scene).catch((e) => console.warn('[gate] precompile', e));
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

  get busy(): number { return this.pending.length + this.warm.length; }

  /** What is still waiting for its shader (for the warm-up report). */
  waiting(): string[] {
    return [...this.pending.map((p) => describe(p.mesh, p.real)), ...this.warm.map((w) => `precompile ${w.o.name || w.o.type}`)];
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
    }
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

  /** The depth material the shadow map will use for this mesh/material (same program key). */
  private depthFor(mesh: THREE.Mesh, m: THREE.Material): THREE.Material {
    if (mesh.customDepthMaterial) return mesh.customDepthMaterial;
    const src = m as THREE.MeshStandardMaterial;
    const needsOwn = (src.alphaMap && src.alphaTest > 0) || (src.map && src.alphaTest > 0) || (src.displacementMap && src.displacementScale !== 0) || src.alphaToCoverage;
    const side = src.shadowSide ?? (src.side === THREE.FrontSide ? THREE.BackSide : src.side === THREE.BackSide ? THREE.FrontSide : THREE.DoubleSide);
    const key = needsOwn ? `${src.map ? 1 : 0}${src.alphaMap ? 1 : 0}${src.displacementMap ? 1 : 0}|${side}` : `base|${side}`;
    let d = this.depthMats.get(key);
    if (!d) {
      d = new THREE.MeshDepthMaterial();
      if (needsOwn) {
        d.map = src.map ?? null; d.alphaMap = src.alphaMap ?? null; d.alphaTest = src.alphaToCoverage ? 0.5 : src.alphaTest;
        d.displacementMap = src.displacementMap ?? null; d.displacementScale = src.displacementScale ?? 1; d.displacementBias = src.displacementBias ?? 0;
      }
      d.side = side;
      this.depthMats.set(key, d);
    }
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
