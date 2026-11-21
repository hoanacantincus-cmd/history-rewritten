import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: 'src/public-worker.ts', formats: ['es'], fileName: () => 'index.js' },
  },
});
