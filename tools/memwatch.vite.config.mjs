// Dev server for tools/memwatch.cjs: the game's config plus cross-origin isolation, so the page can
// measure its workers' memory (performance.measureUserAgentSpecificMemory). Run from the repo folder:
// npx vite --config tools/memwatch.vite.config.mjs --port 5193 --strictPort
import { defineConfig } from 'vite';
export default defineConfig({
  root: process.cwd(),
  server: { strictPort: true, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }, hmr: false },
  worker: { format: 'es' },
  optimizeDeps: { include: ['onnxruntime-web/wasm'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
