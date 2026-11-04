/**
 * The stage: the one way things enter the visible scene (each game's docs/SHADERS.md).
 * From Dunfinity src/render/stage.ts (v0.281); the material registry is now passed in (`StageOptions`).
 *
 *  1. `warmUp()` compiles every material kind (the game's registry) against the real scene (its lights and
 *     fog) behind the loading screen, at full speed. Then the shader cap switches on.
 *  2. `add(obj)` compiles the object first (`compileAsync`: a cache hit for a warmed kind, otherwise a
 *     queued build under the cap) and only then puts it into the scene. Nothing ever draws with a
 *     shader that is not ready, so nothing compiles on the render path.
 */
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Vector3, type Camera, type InstancedMesh, type Material, type Object3D, type RenderTarget, type Scene, type WebGPURenderer } from 'three/webgpu';
import { ShaderCap } from './cap';
import { ShaderMonitor } from './monitor';
import { installShaderPolicy, shadowKindOf } from './patches';
import { StaticBundle } from './bundle';

/**
 * A material kind as the Stage sees it: each game keeps its own closed registry of kinds (its
 * `materials.ts`) and hands them to the Stage, which warms each one with a stand-in mesh.
 */
export interface StageKind {
  readonly name: string;
  /** The vertex attributes every mesh of the kind carries (part of the shader's cache key). */
  readonly attributes: readonly string[];
  /** The kind's one shared material. */
  make(): Material;
  readonly shadow: { readonly cast: boolean; readonly receive: boolean };
}

export interface StageOptions {
  /** Every material kind, warmed by `warmUp`. */
  kinds: () => readonly StageKind[];
  /**
   * Sets a game's own attribute (not position, normal, color, uv or look) on a stand-in of 3
   * vertices; returns false if it does not know the name. Dunfinity's `surface` goes here.
   */
  attribute?: (g: BufferGeometry, name: string) => boolean;
  /**
   * Where the scene is drawn when a post chain draws it (its scene pass, `createPost`): every compile and
   * warm-up draw happens against it, since a shader is built for the target it draws into.
   */
  target?: () => RenderTarget | null;
  /** Draws one frame the game's way (a post chain); by default `renderer.render(scene, camera)`. */
  draw?: () => void;
}

/** Frames drawn to warm the shadow pass (async pipelines finish over a few). */
const WARM_FRAMES = 8;
/** Milliseconds the warm-up waits before its shadow frames (`warmShadows`). */
const SETTLE_MS = 500;
/** A layer only the headlamp's shadow camera sees: casters warmed later are drawn into its map alone. */
const WARM_LAYER = 7;


/**
 * What the shadow pass's shader for a caster depends on: whether it is instanced, how many bones it
 * is skinned to, its attributes and morphs, and what the pass borrows from its material (its kind,
 * by type and name; side, cut-outs, moved vertices, the nodes it lends: `shadowKindOf`). Casters
 * alike share a shader (with the shared shadow nodes, patches.ts); one of each is drawn. Humans have
 * a material each, alike per part, so not the material itself.
 */
function casterKey(m: Mesh): string {
  const g = m.geometry, mats = (Array.isArray(m.material) ? m.material : [m.material]) as (Material & { alphaMap?: unknown; positionNode?: unknown; displacementMap?: unknown })[];
  return [(m as { isInstancedMesh?: boolean }).isInstancedMesh, (m as { skeleton?: { bones: unknown[] } }).skeleton?.bones.length ?? -1, m.receiveShadow,
    // Morph targets by identity, as three keys them: a mesh with morphs of its own has shaders of its own.
    Object.keys(g.attributes).sort().map((k) => `${k}${g.attributes[k]!.itemSize}`).join(','), Object.entries(g.morphAttributes as Record<string, { id: number }[]>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, list]) => `${k}:${list.map((a) => a.id).join('.')}`).join(','), !!g.index,
    ...mats.map((mat) => [mat.type, mat.name, mat.side, mat.shadowSide, mat.alphaTest > 0, !!mat.alphaMap, mat.transparent, !!mat.positionNode, !!mat.displacementMap, shadowKindOf(mat)].join(':'))].join('|');
}

/**
 * The casters already drawn into the shadow pass, each with the geometry and material it was drawn with.
 * A caster drawn again with both unchanged has its shadow-pass objects built already (three keeps them
 * per mesh), so `everyCaster` skips it: a character re-dressed in turn keeps its earlier garments as
 * hidden meshes, and drawing those again each time made a warm-up grow with every outfit.
 */
export class DrawnCasters {
  private readonly drawn = new WeakMap<object, { geometry: object; material: object }>();

  /** True if `m` was never drawn, or was drawn with another geometry or material. */
  fresh(m: { geometry: object; material: object }): boolean {
    const d = this.drawn.get(m);
    return !d || d.geometry !== m.geometry || d.material !== m.material;
  }

  mark(m: { geometry: object; material: object }): void {
    this.drawn.set(m, { geometry: m.geometry, material: m.material });
  }
}

/**
 * Start a new frame for three's nodes (its frame counter, which the shadow map is drawn once per),
 * as the renderer's own loop does each frame. Reaches into r186 internals: skipped if renamed.
 */
function newNodeFrame(renderer: WebGPURenderer): void {
  (renderer as unknown as { _nodes?: { nodeFrame?: { update?: () => void } } })._nodes?.nodeFrame?.update?.();
}

export class Stage {
  readonly cap = new ShaderCap();
  readonly monitor = new ShaderMonitor();
  /** Renderer hooks that could not be installed (a three.js update renamed an internal). */
  readonly missingHooks: string[];
  private pending = new Set<Object3D>();

  constructor(readonly renderer: WebGPURenderer, readonly scene: Scene, readonly camera: Camera, private readonly opts: StageOptions) {
    this.missingHooks = installShaderPolicy(renderer, this.cap, this.monitor);
    this.sharedShadows = !this.missingHooks.includes('shared shadow nodes');
    (globalThis as { shaders?: ShaderMonitor }).shaders = this.monitor;
    // Render bundles record again once a build finishes (a draw not ready while recording was left out).
    StaticBundle.builds = () => this.monitor.events.length;
  }

  /** Casters alike share their shadow shader (patches.ts `shareShadowNodes` is in place). */
  private readonly sharedShadows: boolean;

  /** Objects compiled but not yet visible. */
  get waiting(): number { return this.pending.size; }

  /**
   * Compile every material kind, then switch the cap on. Call after lights and fog are set up.
   * `extra`: objects whose materials are not registry kinds (the humanoid's, made by its package),
   * compiled with them (all at once); add them with `add` later (a cache hit by then).
   */
  async warmUp(extra: readonly Object3D[] = []): Promise<void> {
    // One real frame first: it settles the render context (frame buffer target) that compiled
    // shaders are keyed by, and builds the renderer's own output pass.
    this.drawFrame();
    const standIns = this.opts.kinds().map((k) => standIn(k, this.opts.attribute));
    // In front of the camera, in the scene's own frame (its root may stand off zero: a floating origin).
    this.scene.updateMatrixWorld();
    const front = this.scene.worldToLocal(this.camera.getWorldPosition(new Vector3()).add(new Vector3(0, 0, -2)));
    for (const m of standIns) {
      m.position.copy(front);
      m.frustumCulled = false; // compileAsync skips what is out of view, wherever the camera looks
    }
    const group = new Group();
    for (const m of standIns) group.add(m);
    // All at once: the kinds and every extra start compiling together, so the GPU builds their pipelines side by
    // side (one after another, each waited for, a cold start on WebGPU took about twice as long: MasterWorld A7).
    await Promise.all([this.onTarget(() => this.renderer.compileAsync(group, this.camera, this.scene)), ...extra.map((o) => this.prepare(o))]);
    // Then draw them, for the shadow pass's own (small) shaders, which compileAsync does not build.
    await this.warmShadows(group, extra);
    for (const m of standIns) m.geometry.dispose();
    this.monitor.phase = 'run';
    this.cap.active = true;
  }

  /**
   * The shadow pass draws casters with shaders of its own, which compileAsync does not build: draw
   * the stand-ins and `extra` in front of the camera (where the headlamp shines) for a few real
   * frames, so those build now, behind the loading screen, and not in play.
   */
  private async warmShadows(group: Group, extra: readonly Object3D[]): Promise<void> {
    for (const o of [group, ...extra]) o.traverse((c) => { if ((c as Mesh).isMesh && (c as Mesh).castShadow) this.casters.add(casterKey(c as Mesh)); });
    const parents = extra.map((o) => o.parent);
    // Each object's own culling flag, restored after (some never cull: things placed on the GPU).
    const culled = new Map<Object3D, boolean>();
    for (const o of extra) {
      group.add(o);
      o.traverse((c) => { culled.set(c, c.frustumCulled); c.frustumCulled = false; });
    }
    this.scene.add(group);
    // A moment first for the work the compiles just started to settle (measured, not fully understood):
    // without it the first shadow build, which carries the shadow pass's one-time setup, took 40 to 125 ms
    // in software GL, with it 37 to 53 ms (the budget is 100).
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    for (let k = 0; k < WARM_FRAMES; k++) {
      this.redrawShadow();
      this.onTarget(() => this.renderer.render(this.scene, this.camera));
      await new Promise((r) => setTimeout(r, 30));
    }
    this.scene.remove(group);
    extra.forEach((o, i) => {
      o.removeFromParent();
      parents[i]?.add(o);
      o.traverse((c) => { c.frustumCulled = culled.get(c) ?? true; });
    });
  }

  /**
   * The camera of the light that casts shadows (the headlamp's). Once set, everything prepared after
   * the warm-up also gets its shadow-pass shaders built ahead (`warmShadowsOf`).
   */
  set shadowCamera(cam: Camera) {
    cam.layers.enable(WARM_LAYER);
    this.shadowCam = cam;
  }
  private shadowCam: Camera | null = null;
  /** The kinds of shadow caster whose shadow-pass shaders are built (`casterKey`). */
  private readonly casters = new Set<string>();
  /** Which meshes were drawn into the shadow pass as they are now (`everyCaster` skips those). */
  private readonly drawnCasters = new DrawnCasters();

  /**
   * Warm `objs` while the game is already drawing (behind the title screen) instead of in the
   * warm-up: one after another, each compiled under the cap and its shadows built like anything
   * prepared. Pass the roots of what will be added. Resolves when all are warm.
   */
  async warmLater(objs: readonly Object3D[]): Promise<void> {
    for (const o of objs) await this.prepare(o);
  }

  /**
   * The shadow pass draws casters with shaders of its own, which compileAsync does not build, and
   * builds them on the render path. So before `obj` (not in the scene yet) goes in, each new kind of
   * caster in it is drawn once, in a cap slot of its own, into the shadow camera only (a layer the
   * camera does not see).
   */
  private async warmShadowsOf(obj: Object3D, every = false): Promise<void> {
    if (!this.shadowCam || !this.cap.active || obj.parent) return;
    const meshes: Mesh[] = [], fresh: Mesh[] = [];
    obj.traverse((c) => { if ((c as Mesh).isMesh) meshes.push(c as Mesh); });
    for (const m of meshes) {
      if (!m.castShadow) continue; // the shadow pass draws casters only
      const key = casterKey(m);
      // With the shadow nodes shared (patches.ts), a caster of a known kind has its shader: drawing it again
      // builds nothing. Without them (three renamed the internal), `every` draws each new caster.
      if (this.casters.has(key) && (!every || this.sharedShadows || !this.drawnCasters.fresh(m))) continue;
      this.casters.add(key);
      fresh.push(m);
    }
    if (!fresh.length) return;
    const masks = meshes.map((m) => m.layers.mask), culled = meshes.map((m) => m.frustumCulled);
    for (const m of meshes) m.layers.disableAll();
    for (const m of fresh) {
      const release = await this.cap.slot();
      this.monitor.note = 'shadow warm-up';
      // Shown even if hidden or empty now (a pool with nobody in it yet): it will be drawn later.
      const hidden: Object3D[] = [];
      for (let p: Object3D | null = m; p && p !== this.scene; p = p.parent) if (!p.visible) { hidden.push(p); p.visible = true; }
      const inst = (m as InstancedMesh).isInstancedMesh ? m as InstancedMesh : null, count = inst?.count ?? 0;
      if (inst && !count) inst.count = 1;
      m.layers.set(WARM_LAYER);
      m.frustumCulled = false;
      // Drawn now, not left to the view's next frame (the view may not be drawing yet): its build
      // happens here, in the slot just taken.
      this.scene.add(obj);
      // Everything else hidden (the lights stay: they are part of every key): the draw costs next to nothing,
      // where the whole scene again, and its shadow map, took as long as a frame of its own.
      const others: Object3D[] = [];
      for (const c of this.scene.children) if (c !== obj && c.visible && !(c as { isLight?: boolean }).isLight) { others.push(c); c.visible = false; }
      newNodeFrame(this.renderer); // the shadow map is drawn once a frame, and the view may have drawn this one
      this.redrawShadow();
      try { this.onTarget(() => this.renderer.render(this.scene, this.camera)); } finally { for (const c of others) c.visible = true; }
      this.redrawShadow(); // it holds only this caster now: the next frame draws it whole again
      this.scene.remove(obj);
      m.layers.disableAll();
      this.drawnCasters.mark(m);
      if (inst) inst.count = count;
      for (const p of hidden) p.visible = false;
      this.monitor.note = '';
      release();
    }
    meshes.forEach((m, i) => { m.layers.mask = masks[i]; m.frustumCulled = culled[i]; });
  }

  /**
   * The light with the shadow camera draws its map on the next render even if the game draws it only now and then
   * (`shadow.autoUpdate` off): the shadow warm-up builds its shaders by drawing into it.
   */
  private redrawShadow(): void {
    for (const c of this.scene.children) {
      const shadow = (c as { shadow?: { camera?: Camera; needsUpdate: boolean } }).shadow;
      if ((c as { isLight?: boolean }).isLight && shadow?.camera && shadow.camera === this.shadowCam) shadow.needsUpdate = true;
    }
  }

  /** Put `obj` into the scene once everything it draws with is compiled. */
  add(obj: Object3D): Promise<void> {
    this.pending.add(obj);
    return this.prepare(obj).then(() => {
      if (!this.pending.delete(obj)) return; // removed meanwhile
      this.scene.add(obj);
    });
  }

  /**
   * Compile everything `obj` draws with, without adding it (for callers that add it to a group of
   * their own once it is ready, like the terrain). `everyCaster`: draw each of its shadow casters
   * into the shadow pass once, even of a kind already warmed (a rebuilt human: its shadow builds were
   * its own, Dunfinity's src/render/humans/nobody.ts restyle). With the shadow nodes shared
   * (patches.ts `shareShadowNodes`) casters alike share their shader, and this draws only new kinds.
   */
  prepare(obj: Object3D, opts: { everyCaster?: boolean } = {}): Promise<void> {
    // compileAsync skips what is outside the view; it must compile everything, or the object
    // would build its shader on the render path the first time it comes into view.
    // compileAsync skips hidden objects too: what is hidden now (rain on a dry day) would build on the render path
    // once shown. Shown while compiling, unless already in the scene (then the view could draw it meanwhile).
    const culled: Object3D[] = [], hidden: Object3D[] = [];
    obj.traverse((o) => {
      if (o.frustumCulled) { o.frustumCulled = false; culled.push(o); }
      if (!o.visible && !obj.parent) { o.visible = true; hidden.push(o); }
    });
    return this.onTarget(() => this.renderer.compileAsync(obj, this.camera, this.scene)).finally(() => {
      for (const o of culled) o.frustumCulled = true;
      for (const o of hidden) o.visible = false;
    }).then(() => this.warmShadowsOf(obj, opts.everyCaster));
  }

  remove(obj: Object3D): void {
    this.pending.delete(obj);
    obj.removeFromParent();
  }

  /** One HUD line on the shader policy (plus any renderer hooks that could not be installed). */
  hudLine(): string {
    const s = this.monitor.summary();
    return `shaders ${s.warmup} warm-up + ${s.run} later · worst ${s.worstMs.toFixed(0)} ms · ${s.violations ? `${s.violations} POLICY VIOLATIONS (shaders.report())` : 'policy ok'}${s.repeats ? ` · ${s.repeats} built again alike (shaders.repeats())` : ''}`
      + (this.missingHooks.length ? `\nshader hooks missing: ${this.missingHooks.join(', ')}` : '');
  }

  /** One frame the game's way (its post chain, if any). */
  private drawFrame(): void {
    if (this.opts.draw) this.opts.draw();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Runs `f` with the post chain's scene pass as the render target (if there is one). compileAsync
   * takes the target when called, before its first await, so it can be restored right after.
   */
  private onTarget<T>(f: () => T): T {
    const t = this.opts.target?.();
    if (!t) return f();
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(t);
    try { return f(); } finally { this.renderer.setRenderTarget(prev); }
  }

  /** Once per frame, before rendering. */
  frame(): void {
    this.cap.newFrame();
  }
}

/** A tiny mesh with the kind's attributes, so its warm-up build matches real meshes of the kind. */
export function standIn(kind: StageKind, attribute?: StageOptions['attribute']): Mesh {
  const g = new BufferGeometry();
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  g.setAttribute('position', new Float32BufferAttribute(tri, 3));
  g.setIndex([0, 1, 2]); // part of the shader's cache key: every kind's meshes are indexed
  if (kind.attributes.includes('normal')) g.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  if (kind.attributes.includes('color')) g.setAttribute('color', new Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
  if (kind.attributes.includes('uv')) g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  if (kind.attributes.includes('look')) g.setAttribute('look', new Float32BufferAttribute(new Array(12).fill(0.5), 4));
  for (const name of kind.attributes) {
    if (['position', 'normal', 'color', 'uv', 'look'].includes(name)) continue;
    if (!attribute?.(g, name)) throw new Error(`Stage: kind ${kind.name} needs attribute "${name}"; pass StageOptions.attribute`);
  }
  const m = new Mesh(g, kind.make());
  m.castShadow = kind.shadow.cast;
  m.receiveShadow = kind.shadow.receive;
  return m;
}
