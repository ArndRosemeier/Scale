/**
 * Check converted avatars the way the game sees them (headless):
 *   npx tsx tools/avatar/check-glb.ts file.glb [...]
 * Loads each GLB (textures left out), runs the game's humanoid mapper and prints the mode
 * the game would use (retarget / clips / static), mapped bones, clips and problems.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mapHumanoid } from '../../src/avatar/HumanoidMap';

/** GLB without images (node has no image decoder): drop textures from the JSON chunk. */
function stripImages(buf: Buffer): ArrayBuffer {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  delete json.images; delete json.textures; delete json.samplers;
  for (const m of json.materials ?? []) {
    const p = m.pbrMetallicRoughness;
    if (p) { delete p.baseColorTexture; delete p.metallicRoughnessTexture; }
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    if (m.extensions) for (const e of Object.values(m.extensions) as Record<string, unknown>[]) for (const k of Object.keys(e)) if (k.endsWith('Texture')) delete e[k];
  }
  if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter((e: string) => !/texture/i.test(e));
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (js.length % 4)) % 4;
  js = Buffer.concat([js, Buffer.alloc(pad, 0x20)]);
  const rest = buf.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + js.length + rest.length, 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([head, js, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

for (const file of process.argv.slice(2)) {
  const gltf = await new GLTFLoader().parseAsync(stripImages(readFileSync(file)), '');
  const map = mapHumanoid(gltf.scene, gltf.parser.json, gltf.parser.associations as Map<unknown, { nodes?: number }>);
  const mode = map.ok ? 'retarget' : gltf.animations.length ? 'clips' : 'static';
  let meshes = 0, skinned = 0, verts = 0;
  gltf.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isMesh) return;
    meshes++; if (m.isSkinnedMesh) skinned++;
    verts += m.geometry.attributes.position.count;
  });
  const box = new THREE.Box3().setFromObject(gltf.scene);
  console.log(`${basename(file)}: mode=${mode} source=${map.source} mapped=${Object.keys(map.bones).length} missing=[${map.missing.join(',')}] meshes=${meshes} (skinned ${skinned}) verts=${verts} height=${(box.max.y - box.min.y).toFixed(2)} clips=[${gltf.animations.map((a) => a.name).join(',')}]${map.notes.length ? ' notes=' + map.notes.join('; ') : ''}`);
}
