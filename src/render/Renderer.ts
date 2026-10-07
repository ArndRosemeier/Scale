/**
 * WebGL renderer with reversed-Z depth (a 10 cm player and a 30 km horizon
 * share one depth buffer), HDR post-processing (bloom, SMAA, AgX tone mapping).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WEBGPU, WEBGPU_FORCE_GL, gpuKit } from './gpuMode';

type Post = InstanceType<ReturnType<typeof gpuKit>['Post']>;

export class Renderer {
  /**
   * The three.js renderer. On the WebGPU path (`webgpu`) this is a WebGPURenderer: most of the
   * API is shared; WebGL-only calls (programs, extensions, `compile`) must check `webgpu` first.
   */
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly webgpu = WEBGPU;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private smaa!: SMAAPass;
  private post: Post | null = null;
  readonly reversed: boolean;

  constructor(canvas: HTMLCanvasElement) {
    if (WEBGPU) {
      this.gl = gpuKit().createRenderer(canvas, WEBGPU_FORCE_GL) as unknown as THREE.WebGLRenderer;
      this.reversed = true;
    } else {
      this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: true, stencil: false });
      this.reversed = this.gl.capabilities.reversedDepthBuffer;
    }
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.gl.setSize(window.innerWidth, window.innerHeight, false);
    this.gl.toneMapping = THREE.AgXToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 60000);
    if (WEBGPU) {
      this.post = new (gpuKit().Post)(this.gl as unknown as ConstructorParameters<ReturnType<typeof gpuKit>['Post']>[0], this.scene, this.camera);
      this.resize();
      window.addEventListener('resize', () => { this.onResize?.(); this.resize(); });
      return;
    }
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    if (this.reversed) {
      rt.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    }
    this.composer = new EffectComposer(this.gl, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.16, 0.5, 2.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
    this.resize();
    window.addEventListener('resize', () => { this.onResize?.(); this.resize(); });
  }

  /** Before the resize is applied (the graphics settings re-derive the pixel ratio). */
  onResize: (() => void) | null = null;

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.post) return;
    this.composer.setPixelRatio(this.gl.getPixelRatio());
    this.composer.setSize(w, h);
  }

  /** The WebGPU renderer needs an async start (device, adapter) before it can render. */
  async init(): Promise<void> {
    if (!this.webgpu) return;
    await (this.gl as unknown as { init(): Promise<unknown> }).init();
    gpuKit().afterInit(this.gl as unknown as Parameters<ReturnType<typeof gpuKit>['afterInit']>[0]);
    if (new URLSearchParams(location.search).has('offscreen')) gpuKit().offscreen(this.gl as unknown as Parameters<ReturnType<typeof gpuKit>['offscreen']>[0]);
  }

  setPixelRatio(pr: number): void {
    if (Math.abs(pr - this.gl.getPixelRatio()) < 1e-3) return;
    this.gl.setPixelRatio(pr);
    this.resize();
  }

  /** Bloom and SMAA on or off (the composer renders the last enabled pass to the screen). */
  setPost(bloom: boolean, smaa: boolean): void {
    if (this.post) { this.post.set(bloom, smaa); return; }
    this.bloom.enabled = bloom;
    this.smaa.enabled = smaa;
  }

  setBloom(strength: number): void {
    if (this.post) { this.post.setBloom(strength); return; }
    this.bloom.strength = strength;
  }

  render(): void {
    if (this.post) { this.post.render(); return; }
    this.composer.render();
  }

  /**
   * Run shader compiles as the scene pass sees them: rendering into the HDR target (linear
   * output, tone mapping in the output pass). Programs compiled against the canvas would
   * get different keys (sRGB, AgX) and never be used.
   */
  asScenePass<T>(fn: () => T): T {
    const prev = this.gl.getRenderTarget();
    this.gl.setRenderTarget(this.post ? this.post.sceneTarget as unknown as THREE.WebGLRenderTarget : this.composer.readBuffer);
    try { return fn(); } finally { this.gl.setRenderTarget(prev); }
  }

  /** compileAsync with matching program keys (see asScenePass). */
  compileAsync(obj: THREE.Object3D, target: THREE.Scene = this.scene): Promise<unknown> {
    if (!this.webgpu) return this.asScenePass(() => this.gl.compileAsync(obj, this.camera, target));
    // three's WebGPU compileAsync only takes what the camera sees, and builds one pipeline after
    // the other. Everything else was then built in the frames, one by one, blocking each. So:
    // no frustum culling and empty instanced batches as one instance while it collects the
    // objects (that part runs at once), and the scene in parts, compiled side by side.
    const undo: (() => void)[] = [];
    obj.traverseVisible((o) => {
      if (o.frustumCulled) { o.frustumCulled = false; undo.push(() => { o.frustumCulled = true; }); }
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh && im.count === 0 && im.instanceMatrix.count > 0) { im.count = 1; undo.push(() => { im.count = 0; }); }
    });
    let jobs: Promise<unknown>[];
    try {
      jobs = this.asScenePass(() => compileParts(obj, 16).map((part) => this.gl.compileAsync(part, this.camera, target)));
    } finally {
      for (const u of undo) u();
    }
    // A pipeline that fails to build never settles its promise: never let loading wait on it.
    let timer = 0;
    const late = new Promise((res) => { timer = window.setTimeout(() => { console.warn('[warm-up] compileAsync still pending after 60 s, going on'); res(null); }, 60000); });
    return Promise.race([Promise.all(jobs), late]).finally(() => clearTimeout(timer));
  }
}

/** Splits a tree into about `n` visible subtrees of similar renderable counts (whole subtrees, no overlaps). */
function compileParts(root: THREE.Object3D, n: number): THREE.Object3D[] {
  const counts = new Map<THREE.Object3D, number>();
  const count = (o: THREE.Object3D): number => {
    let c = (o as THREE.Mesh).geometry ? 1 : 0;
    for (const ch of o.children) if (ch.visible) c += count(ch);
    counts.set(o, c);
    return c;
  };
  const limit = Math.max(1, Math.ceil(count(root) / n));
  const parts: THREE.Object3D[] = [];
  const take = (o: THREE.Object3D): void => {
    const c = counts.get(o) ?? 0;
    if (c === 0) return;
    // (A renderable is taken with its children: compiling it compiles them too.)
    if (c <= limit || (o as THREE.Mesh).geometry || !o.children.length) { parts.push(o); return; }
    for (const ch of o.children) if (ch.visible) take(ch);
  };
  take(root);
  return parts;
}
