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

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  readonly reversed: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: true, stencil: false });
    this.reversed = this.gl.capabilities.reversedDepthBuffer;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.gl.setSize(window.innerWidth, window.innerHeight, false);
    this.gl.toneMapping = THREE.AgXToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 60000);
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    if (this.reversed) {
      rt.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    }
    this.composer = new EffectComposer(this.gl, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.6, 1.4);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new SMAAPass());
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setBloom(strength: number): void {
    this.bloom.strength = strength;
  }

  render(): void {
    this.composer.render();
  }

  /**
   * Run shader compiles as the scene pass sees them: rendering into the HDR target (linear
   * output, tone mapping in the output pass). Programs compiled against the canvas would
   * get different keys (sRGB, AgX) and never be used.
   */
  asScenePass<T>(fn: () => T): T {
    const prev = this.gl.getRenderTarget();
    this.gl.setRenderTarget(this.composer.readBuffer);
    try { return fn(); } finally { this.gl.setRenderTarget(prev); }
  }

  /** compileAsync with matching program keys (see asScenePass). */
  compileAsync(obj: THREE.Object3D, target: THREE.Scene = this.scene): Promise<unknown> {
    return this.asScenePass(() => this.gl.compileAsync(obj, this.camera, target));
  }
}
