/**
 * Procedural material texture arrays (facade + ground families), generated
 * in parallel workers and cached in IndexedDB between sessions.
 */
import * as THREE from 'three';
import { FACADE_LAYER_COUNT, GROUND_LAYER_COUNT, TEX_SIZE, FACADE_TILE_METERS, GROUND_TILE_METERS } from './texgen';

const CACHE_VERSION = 'tex-v3';

export interface MaterialArrays {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  tileMeters: number[];
  layers: number;
}

function makeArray(data: Uint8Array, size: number, layers: number, srgb: boolean): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

async function idbGet(key: string): Promise<ArrayBuffer | undefined> {
  return new Promise((res) => {
    try {
      const req = indexedDB.open('scale-cache', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('blobs');
      req.onerror = () => res(undefined);
      req.onsuccess = () => {
        const tx = req.result.transaction('blobs', 'readonly');
        const g = tx.objectStore('blobs').get(key);
        g.onsuccess = () => res(g.result as ArrayBuffer | undefined);
        g.onerror = () => res(undefined);
      };
    } catch { res(undefined); }
  });
}
async function idbPut(key: string, value: ArrayBuffer): Promise<void> {
  return new Promise((res) => {
    try {
      const req = indexedDB.open('scale-cache', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('blobs');
      req.onerror = () => res();
      req.onsuccess = () => {
        const tx = req.result.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').put(value, key);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      };
    } catch { res(); }
  });
}

export class TextureLibrary {
  facade!: MaterialArrays;
  ground!: MaterialArrays;

  async load(onProgress?: (f: number) => void): Promise<void> {
    const size = TEX_SIZE;
    const jobs: { family: 'facade' | 'ground'; index: number }[] = [];
    for (let i = 0; i < FACADE_LAYER_COUNT; i++) jobs.push({ family: 'facade', index: i });
    for (let i = 0; i < GROUND_LAYER_COUNT; i++) jobs.push({ family: 'ground', index: i });
    const layerBytes = size * size * 4;
    const fa = new Uint8Array(layerBytes * FACADE_LAYER_COUNT), fn = new Uint8Array(layerBytes * FACADE_LAYER_COUNT);
    const ga = new Uint8Array(layerBytes * GROUND_LAYER_COUNT), gn = new Uint8Array(layerBytes * GROUND_LAYER_COUNT);
    const key = `${CACHE_VERSION}-${size}`;
    const cached = await idbGet(key);
    if (cached && cached.byteLength === fa.length * 2 + ga.length * 2) {
      const all = new Uint8Array(cached);
      fa.set(all.subarray(0, fa.length));
      fn.set(all.subarray(fa.length, fa.length * 2));
      ga.set(all.subarray(fa.length * 2, fa.length * 2 + ga.length));
      gn.set(all.subarray(fa.length * 2 + ga.length));
      onProgress?.(1);
    } else {
      const nw = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
      let done = 0;
      await new Promise<void>((resolve, reject) => {
        const queue = jobs.slice();
        let active = 0;
        const workers: Worker[] = [];
        const next = (w: Worker) => {
          const j = queue.shift();
          if (!j) {
            w.terminate();
            if (--active === 0) resolve();
            return;
          }
          w.postMessage({ ...j, size });
        };
        for (let i = 0; i < nw; i++) {
          const w = new Worker(new URL('./tex.worker.ts', import.meta.url), { type: 'module' });
          workers.push(w);
          active++;
          w.onmessage = (ev) => {
            const { family, index, albedo, normal } = ev.data as { family: string; index: number; albedo: Uint8Array; normal: Uint8Array };
            if (family === 'facade') { fa.set(albedo, index * layerBytes); fn.set(normal, index * layerBytes); }
            else { ga.set(albedo, index * layerBytes); gn.set(normal, index * layerBytes); }
            done++;
            onProgress?.(done / jobs.length);
            next(w);
          };
          w.onerror = (e) => reject(new Error(e.message));
          next(w);
        }
      });
      const all = new Uint8Array(fa.length * 2 + ga.length * 2);
      all.set(fa, 0); all.set(fn, fa.length); all.set(ga, fa.length * 2); all.set(gn, fa.length * 2 + ga.length);
      void idbPut(key, all.buffer);
    }
    this.facade = { albedo: makeArray(fa, size, FACADE_LAYER_COUNT, true), normal: makeArray(fn, size, FACADE_LAYER_COUNT, false), tileMeters: FACADE_TILE_METERS, layers: FACADE_LAYER_COUNT };
    this.ground = { albedo: makeArray(ga, size, GROUND_LAYER_COUNT, true), normal: makeArray(gn, size, GROUND_LAYER_COUNT, false), tileMeters: GROUND_TILE_METERS, layers: GROUND_LAYER_COUNT };
  }
}
