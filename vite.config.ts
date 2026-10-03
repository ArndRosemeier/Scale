import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 5180 },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
