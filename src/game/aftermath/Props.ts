/**
 * The aftermath's props in the world (src/props/aftermath.ts): one instanced mesh per model in the
 * shared vehicle material (one program, warmed with the vehicles), filled by the aftermath systems.
 * Static sets (the tent, barriers, tape, the memorial) are rebuilt only when they change; moving
 * ones (the crane's hook and the piece on it) every frame — a few hundred instances at most.
 */
import * as THREE from 'three';
import { createInstancedVehicleGeometry } from '../../props/vehicles';
import { triageTent, tentSign, cot, barrier, tape, tapePost, bouquet, candle, chunk, hookBlock, cable } from '../../props/aftermath';

export type PropKind = 'tent' | 'sign' | 'cot' | 'barrier' | 'tape' | 'post' | 'bouquet' | 'candle' | 'chunk' | 'hook' | 'cable';

const MODELS: Record<PropKind, [() => THREE.BufferGeometry, number]> = {
  tent: [triageTent, 4], sign: [tentSign, 4], cot: [cot, 24], barrier: [barrier, 96], tape: [tape, 128], post: [tapePost, 128],
  bouquet: [bouquet, 48], candle: [candle, 64], chunk: [chunk, 12], hook: [hookBlock, 4], cable: [cable, 4],
};

interface Batch { mesh: THREE.InstancedMesh; paint: THREE.InstancedBufferAttribute; state: THREE.InstancedBufferAttribute; n: number; cap: number }

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

export class AftermathProps {
  readonly group = new THREE.Group();
  private batches = new Map<PropKind, Batch>();

  constructor(material: THREE.Material) {
    this.group.name = 'aftermathProps';
    for (const k of Object.keys(MODELS) as PropKind[]) {
      const [make, cap] = MODELS[k];
      const geo = createInstancedVehicleGeometry(make(), cap);
      const mesh = new THREE.InstancedMesh(geo, material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = k !== 'tape' && k !== 'candle' && k !== 'bouquet';
      mesh.receiveShadow = true;
      mesh.name = `aftermath:${k}`;
      this.group.add(mesh);
      this.batches.set(k, { mesh, paint: geo.getAttribute('iPaint') as THREE.InstancedBufferAttribute, state: geo.getAttribute('iState') as THREE.InstancedBufferAttribute, n: 0, cap });
    }
  }

  /** Empty a kind (then `put` its instances again). */
  clear(k: PropKind): void { const b = this.batches.get(k)!; b.n = 0; this.flush(b); }

  /**
   * One instance: position, yaw (and pitch / roll), scale (x, y, z), paint (sRGB 0..1), state
   * (x: lit, z: indicator mode — 2 blinks both sides). False when the kind is full.
   */
  put(k: PropKind, x: number, y: number, z: number, yaw: number, paint: readonly [number, number, number], o: { sx?: number; sy?: number; sz?: number; pitch?: number; roll?: number; lit?: number; blink?: number } = {}): boolean {
    const b = this.batches.get(k)!;
    if (b.n >= b.cap) return false;
    _q.setFromEuler(_e.set(o.pitch ?? 0, yaw, o.roll ?? 0, 'YXZ'));
    _m.compose(_p.set(x, y, z), _q, _s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
    b.mesh.setMatrixAt(b.n, _m);
    b.paint.setXYZ(b.n, paint[0], paint[1], paint[2]);
    b.state.setXYZW(b.n, o.lit ?? 0, 0, o.blink ?? 0, 0);
    b.n++;
    this.flush(b);
    return true;
  }

  /** A full matrix (the hook under a crane's boom). */
  putMatrix(k: PropKind, m: THREE.Matrix4, paint: readonly [number, number, number]): boolean {
    const b = this.batches.get(k)!;
    if (b.n >= b.cap) return false;
    b.mesh.setMatrixAt(b.n, m);
    b.paint.setXYZ(b.n, paint[0], paint[1], paint[2]);
    b.state.setXYZW(b.n, 0, 0, 0, 0);
    b.n++;
    this.flush(b);
    return true;
  }

  count(k: PropKind): number { return this.batches.get(k)!.n; }

  private flush(b: Batch): void {
    b.mesh.count = b.n;
    if (!b.n) return;
    for (const a of [b.mesh.instanceMatrix, b.paint, b.state]) { a.clearUpdateRanges(); a.addUpdateRange(0, b.n * a.itemSize); a.needsUpdate = true; }
  }

  /** Start-up warm-up: one of each far under the player (programs and shadow variants compile behind the loading screen). */
  warm(x: number, y: number, z: number): void {
    for (const k of this.batches.keys()) { this.clear(k); this.put(k, x, y, z, 0, [0.5, 0.5, 0.5], { sx: 0.01, sy: 0.01, sz: 0.01 }); }
  }

  clearAll(): void { for (const k of this.batches.keys()) this.clear(k); }
}
