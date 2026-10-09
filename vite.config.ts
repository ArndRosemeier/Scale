import { defineConfig } from 'vite';

// The app publishes under a subpath of the shared static host
// (https://apps.futuremagic.de/scale/), so the publish build carries that base while
// the default build (dev server, previews, local runs) stays at the root. SCALE_BASE
// overrides both, e.g. to host under a different folder name.
export default defineConfig(({ mode }) => ({
  base: process.env.SCALE_BASE?.trim() || (mode === 'publish' ? '/scale/' : '/'),
  server: { host: true, port: 5180 },
  worker: { format: 'es' },
  // The chat's sentence-model worker: pre-bundled up front, else the dev server reloads the page
  // the first time someone talks.
  optimizeDeps: { include: ['onnxruntime-web/wasm'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
}));
