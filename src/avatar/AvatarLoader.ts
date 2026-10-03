/**
 * Loading imported character files in the browser: glTF/GLB/VRM natively, FBX via three's
 * FBXLoader (convenience path; the converter gives more predictable results).
 */
import * as THREE from 'three';
import type { LoadedModel } from './ImportedAvatar';

export const IMPORT_EXTENSIONS = ['.glb', '.gltf', '.vrm', '.fbx'];

export function extOf(name: string): string {
  const m = /\.[^.]+$/.exec(name.toLowerCase());
  return m ? m[0] : '';
}

export async function loadModel(data: ArrayBuffer, fileName: string): Promise<LoadedModel> {
  const ext = extOf(fileName);
  if (ext === '.fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const group = new FBXLoader().parse(data, '');
    upgradeMaterials(group);
    return { scene: group, animations: group.animations ?? [] };
  }
  if (ext === '.glb' || ext === '.gltf' || ext === '.vrm') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(data, '');
    return { scene: gltf.scene, animations: gltf.animations, json: gltf.parser.json, associations: gltf.parser.associations as Map<unknown, { nodes?: number }> };
  }
  throw new Error(`Unsupported file type "${ext}". Use GLB, glTF, VRM or FBX (or the converter for other formats).`);
}

/** FBX brings old-style Phong/Lambert materials: turn them into PBR like the rest of the game. */
function upgradeMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const conv = (src: THREE.Material): THREE.Material => {
      const p = src as THREE.MeshPhongMaterial;
      if (!(p.isMeshPhongMaterial || (src as THREE.MeshLambertMaterial).isMeshLambertMaterial)) return src;
      const shin = p.shininess ?? 20;
      const out = new THREE.MeshStandardMaterial({
        name: src.name, color: p.color, map: p.map, normalMap: p.normalMap ?? null,
        emissive: p.emissive, emissiveMap: p.emissiveMap ?? null, alphaMap: p.alphaMap ?? null,
        transparent: p.transparent, opacity: p.opacity, side: p.side, alphaTest: p.alphaTest,
        roughness: THREE.MathUtils.clamp(1 - Math.sqrt(shin / 100), 0.25, 0.95), metalness: 0,
      });
      if (out.map) out.map.colorSpace = THREE.SRGBColorSpace;
      src.dispose();
      return out;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
  });
}
