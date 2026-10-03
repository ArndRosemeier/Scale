/**
 * Dev tool: load character files and report how the humanoid mapper sees them.
 * Console: `(await import('/src/debug/avatarProbe.ts')).probe(['/avatars/x.glb'])`
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mapHumanoid } from '../avatar/HumanoidMap';

export async function probe(urls: string[]): Promise<string> {
  const out: string[] = [];
  for (const url of urls) {
    try {
      const g = await new GLTFLoader().loadAsync(url);
      const m = mapHumanoid(g.scene, g.parser.json, g.parser.associations as Map<unknown, { nodes?: number }>);
      let nb = 0;
      g.scene.traverse((o) => { if ((o as THREE.Bone).isBone) nb++; });
      const box = new THREE.Box3().setFromObject(g.scene).getSize(new THREE.Vector3());
      out.push(`${url.split('/').pop()}: ${m.ok ? 'OK' : 'FAIL'} via ${m.source}, bones ${nb}, mapped ${Object.keys(m.bones).length}, missing [${m.missing.join(',')}], facing ${m.facing}, clips ${g.animations.length}, size ${box.toArray().map((v) => v.toFixed(2)).join('x')}${m.notes.length ? ' | ' + m.notes.slice(0, 3).join('; ') : ''}`);
    } catch (e) {
      out.push(`${url}: ERROR ${(e as Error).message}`);
    }
  }
  return out.join('\n');
}

/** Map an object that is already loaded (e.g. the current player rig). */
export function probeObject(o: THREE.Object3D): string {
  const m = mapHumanoid(o);
  return `${m.ok ? 'OK' : 'FAIL'} via ${m.source}, mapped ${Object.keys(m.bones).length}, missing [${m.missing.join(',')}] ${m.notes.slice(0, 3).join('; ')}`;
}

/** Indented bone hierarchy of a file (for diagnosing rigs). */
export async function boneTree(url: string): Promise<string> {
  const g = await new GLTFLoader().loadAsync(url);
  const lines: string[] = [];
  g.scene.updateMatrixWorld(true);
  g.scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    let d = 0;
    for (let p = o.parent; p && (p as THREE.Bone).isBone; p = p.parent) d++;
    const w = o.getWorldPosition(new THREE.Vector3());
    lines.push(`${' '.repeat(d)}${o.name}  (${w.x.toFixed(2)}, ${w.y.toFixed(2)}, ${w.z.toFixed(2)})`);
  });
  return lines.join('\n');
}
