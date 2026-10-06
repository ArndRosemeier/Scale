/**
 * Everything the WebGPU path needs, loaded only when the game runs on it (`?gpu=webgpu`), so the
 * default WebGL build does not carry three's node system. See docs/WEBGPU_PLAN.md.
 */
import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { makeSkyNode } from './sky';
import { createFacadeNodeMaterial } from './facade';
import { createGroundNodeMaterial, createTerrainNodeMaterial, createWaterNodeMaterial } from './ground';
import { clearGlassNodeMaterial, clearGlassElemNodeMaterial, skylineNodeMaterial } from './city';

export { clearGlassNodeMaterial, clearGlassElemNodeMaterial, skylineNodeMaterial };
import { undergroundTrainNodeMaterial, deepCaveNodeMaterial, deepFallsNodeMaterial, deepMotesNode, deepShardNodeMaterial } from './underground';
export { undergroundTrainNodeMaterial, deepCaveNodeMaterial, deepFallsNodeMaterial, deepMotesNode, deepShardNodeMaterial };
import { createBarkNodeMaterial, createLeafNodeMaterial, createFarTreeNodeMaterial, createClumpNodeMaterial } from './vegetation';
export { createBarkNodeMaterial, createLeafNodeMaterial, createFarTreeNodeMaterial, createClumpNodeMaterial };
import { createVehicleNodeMaterial } from './vehicles';
import { createFurnitureNodeMaterial } from './furniture';
export { createVehicleNodeMaterial, createFurnitureNodeMaterial };
import { createRainNodeMaterial } from './weather';
import { createDustNodeMaterial, createBeamNodeMaterial, createPowerParticleNodeMaterial, createDecalNodeMaterial, createSmokeColumnNodeMaterial, createStarFxNodeMaterial, createStarParticlesNode } from './effects';
import { createBroodNodeMaterial, createBirdNodeMaterial, createCreatureNodeMaterial, createDebrisNodeMaterial, bronzeNodeMaterial } from './creatures';
import { createNavGlowNodeMaterial, createSignNodeMaterial, createHoloNodeMaterial } from './signs';
export { createRainNodeMaterial, createDustNodeMaterial, createBeamNodeMaterial, createPowerParticleNodeMaterial, createDecalNodeMaterial, createSmokeColumnNodeMaterial, createStarFxNodeMaterial, createStarParticlesNode };
export { createBroodNodeMaterial, createBirdNodeMaterial, createCreatureNodeMaterial, createDebrisNodeMaterial, bronzeNodeMaterial };
export { createNavGlowNodeMaterial, createSignNodeMaterial, createHoloNodeMaterial };
export { makeSkyNode, createFacadeNodeMaterial, createGroundNodeMaterial, createTerrainNodeMaterial, createWaterNodeMaterial };

export function createRenderer(canvas: HTMLCanvasElement, forceWebGL: boolean): THREE.WebGPURenderer {
  return new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: true, forceWebGL });
}

/**
 * Polygon offset with reversed depth: WebGLRenderer flips the slope factor when the depth buffer
 * is reversed, three's WebGPU and WebGL2 backends do not, so decals and the street surfaces
 * (polygonOffsetFactor -1: "nearer") would sink behind what they should cover. Flip it the same
 * way. Call after `renderer.init()`, once the backend is chosen.
 */
export function flipPolygonOffsets(renderer: THREE.WebGPURenderer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backend = renderer.backend as any;
  if (backend.pipelineUtils) {
    const pu = backend.pipelineUtils;
    const create = pu.createRenderPipeline.bind(pu);
    pu.createRenderPipeline = (renderObject: { material: THREE.Material }, promises: unknown) => {
      const m = renderObject.material;
      if (!m.polygonOffset) return create(renderObject, promises);
      const f = m.polygonOffsetFactor;
      m.polygonOffsetFactor = -f;
      try { return create(renderObject, promises); } finally { m.polygonOffsetFactor = f; }
    };
  } else if (backend.state?.setPolygonOffset) {
    const st = backend.state;
    const set = st.setPolygonOffset.bind(st);
    st.setPolygonOffset = (on: boolean, factor: number, units: number) => set(on, -factor, units);
  }
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
