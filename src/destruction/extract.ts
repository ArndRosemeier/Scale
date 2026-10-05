/** Cutting falling parts out of a static mesh by element (buildings, breakable landmarks). */
import * as THREE from 'three';

/** Copy the triangles whose vertices belong to the given element ids into a new geometry. */
export function extractElements(src: THREE.BufferGeometry, elems: Set<number>): THREE.BufferGeometry | null {
  // Runs on the whole cell's facade mesh: typed arrays and flat lookup tables only.
  const idx = src.getIndex()!.array as ArrayLike<number>;
  const aElem = (src.getAttribute('aElem') as THREE.BufferAttribute).array as ArrayLike<number>;
  let maxE = 0;
  for (const e of elems) if (e > maxE) maxE = e;
  const want = new Uint8Array(maxE + 1);
  for (const e of elems) want[e] = 1;
  const vCount = (src.getAttribute('position') as THREE.BufferAttribute).count;
  const map = new Int32Array(vCount).fill(-1);
  const order: number[] = [];
  const outIdx: number[] = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i];
    const e = Math.round(aElem[a]);
    if (e > maxE || !want[e]) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[i + k];
      let m = map[v];
      if (m < 0) { m = order.length; map[v] = m; order.push(v); }
      outIdx.push(m);
    }
  }
  if (!outIdx.length) return null;
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    const a = src.getAttribute(name) as THREE.BufferAttribute;
    const size = a.itemSize;
    const arr = a.array as unknown as Float32Array;
    const Arr = (arr as unknown as { constructor: new (n: number) => Float32Array }).constructor;
    const out = new Arr(order.length * size);
    for (let i = 0; i < order.length; i++) {
      const o = order[i] * size, d = i * size;
      for (let k = 0; k < size; k++) out[d + k] = arr[o + k];
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, size, a.normalized));
  }
  g.setIndex(order.length < 65536 ? new THREE.BufferAttribute(Uint16Array.from(outIdx), 1) : new THREE.BufferAttribute(Uint32Array.from(outIdx), 1));
  g.computeBoundingSphere();
  return g;
}
