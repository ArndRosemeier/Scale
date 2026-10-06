/**
 * Everything the WebGPU path needs, loaded only when the game runs on it (`?gpu=webgpu`), so the
 * default WebGL build does not carry three's node system. See docs/WEBGPU_PLAN.md.
 */
import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { makeSkyNode } from './sky';

export { makeSkyNode };

export function createRenderer(canvas: HTMLCanvasElement, forceWebGL: boolean): THREE.WebGPURenderer {
  return new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: true, forceWebGL });
}

export function createPMREM(renderer: unknown): THREE.PMREMGenerator {
  return new THREE.PMREMGenerator(renderer as THREE.WebGPURenderer);
}

/** The game's post-processing (HDR scene → bloom → tone mapping and sRGB → SMAA) as a node pipeline. */
export class Post {
  private pipeline: THREE.RenderPipeline;
  private scene: ReturnType<typeof pass>;
  private bloomNode: ReturnType<typeof bloom>;
  private bloomOn = true;
  private smaaOn = true;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this.scene = pass(scene, camera);
    this.bloomNode = bloom(this.scene.getTextureNode('output'), 0.16, 0.5, 2.0);
    this.build();
  }

  private build(): void {
    const col = this.scene.getTextureNode('output');
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
    this.pipeline.render();
  }
}
