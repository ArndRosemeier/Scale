/// <reference lib="webworker" />
import { generateFacadeLayer, generateGroundLayer, TEX_SIZE } from './texgen';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (ev: MessageEvent<{ family: 'facade' | 'ground'; index: number; size?: number }>) => {
  const { family, index } = ev.data;
  const size = ev.data.size ?? TEX_SIZE;
  const layer = family === 'facade' ? generateFacadeLayer(index, size) : generateGroundLayer(index, size);
  self.postMessage({ family, index, size, albedo: layer.albedo, normal: layer.normal }, [layer.albedo.buffer, layer.normal.buffer]);
};
