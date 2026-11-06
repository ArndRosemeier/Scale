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
import { GRADED_AGX_GLSL, LOOK } from './look';

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
  private output!: OutputPass;
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
    this.output = gradedOutput(new OutputPass());
    this.composer.addPass(this.output);
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
    // (8: the browser compiles their GPU pipelines on its own threads, and one slow pipeline (a
    // glass or skin shader, several seconds on the PC) held up one in four. `&compiles=n` to compare.)
    const url = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.name ?? location.href;
    const n = Number(/[?&]compiles=(\d+)/.exec(url)?.[1]) || 8;
    this.parallelCompiles = gpuKit().oneNodeBuildAtATime(this.gl as unknown as Parameters<ReturnType<typeof gpuKit>['afterInit']>[0]) ? n : 1;
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

  /**
   * The bloom: how strong, how wide, and from what brightness on (in the scene's own HDR units, before
   * the exposure: SkySystem divides a brightness on screen by the exposure).
   */
  setBloom(strength: number, radius?: number, threshold?: number): void {
    if (this.post) { this.post.setBloom(strength, radius, threshold); return; }
    this.bloom.strength = strength;
    if (radius !== undefined) this.bloom.radius = radius;
    if (threshold !== undefined) this.bloom.threshold = threshold;
  }

  render(): void {
    if (this.post) { this.post.render(); return; }
    const u = this.output.material.uniforms;
    (u.gradeSlope.value as THREE.Vector3).fromArray(LOOK.slope);
    (u.gradeOffset.value as THREE.Vector3).fromArray(LOOK.offset);
    u.gradePower.value = LOOK.power;
    u.gradeSat.value = LOOK.saturation;
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
    // A few at a time, so their GPU pipelines compile in parallel; their node builds still run one
    // after the other (three's are not made to run interleaved; see oneNodeBuildAtATime).
    return new Promise((resolve, reject) => {
      this.compileWaiting.push(() => {
        try { return this.compileNow(obj, target).then(resolve, reject); } catch (e) { reject(e); return Promise.resolve(); }
      });
      this.nextCompile();
    });
  }

  /** WebGPU: how many compileAsync calls may run at once (1 without the node build queue). */
  private parallelCompiles = 1;
  private compilesRunning = 0;
  private compileWaiting: (() => Promise<unknown>)[] = [];

  private nextCompile(): void {
    while (this.compilesRunning < this.parallelCompiles && this.compileWaiting.length) {
      const job = this.compileWaiting.shift()!;
      this.compilesRunning++;
      void job().finally(() => { this.compilesRunning--; this.nextCompile(); });
    }
  }
  private compileCam = new THREE.PerspectiveCamera();

  /**
   * three's WebGPU compileAsync only takes what its camera sees (frustum, layers); everything else
   * was then built in the frames, one by one, each blocking its frame. So: no frustum culling and
   * empty instanced batches as one instance while it collects the objects (that part runs at
   * once), and a copy of the camera that sees every layer (the shader gate hides new meshes on
   * another layer until they are compiled).
   */
  private compileNow(obj: THREE.Object3D, target: THREE.Scene): Promise<unknown> {
    const undo: (() => void)[] = [];
    obj.traverseVisible((o) => {
      if (o.frustumCulled) { o.frustumCulled = false; undo.push(() => { o.frustumCulled = true; }); }
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh && im.count === 0 && im.instanceMatrix.count > 0) { im.count = 1; undo.push(() => { im.count = 0; }); }
    });
    const cam = this.compileCam.copy(this.camera);
    cam.layers.enableAll();
    let p: Promise<unknown>;
    try {
      p = this.asScenePass(() => this.gl.compileAsync(obj, cam, target));
    } finally {
      for (const u of undo) u();
    }
    // A pipeline that fails to build never settles its promise: never let loading wait on it.
    let timer = 0;
    const late = new Promise((res) => { timer = window.setTimeout(() => { console.warn('[warm-up] compileAsync still pending after 60 s, going on'); res(null); }, 60000); });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  }
}

/** The output pass with AgX plus the look (render/look.ts) in place of three's plain AgX. */
function gradedOutput(pass: OutputPass): OutputPass {
  const m = pass.material;
  const agx = 'gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );';
  const head = '#include <tonemapping_pars_fragment>';
  if (!m.fragmentShader.includes(agx) || !m.fragmentShader.includes(head)) throw new Error('OutputShader changed: graded AgX needs a new hook');
  m.fragmentShader = m.fragmentShader.replace(head, head + GRADED_AGX_GLSL).replace(agx, 'gl_FragColor.rgb = GradedAgX( gl_FragColor.rgb );');
  Object.assign(m.uniforms, { gradeSlope: { value: new THREE.Vector3(1, 1, 1) }, gradeOffset: { value: new THREE.Vector3() }, gradePower: { value: 1 }, gradeSat: { value: 1 } });
  return pass;
}
