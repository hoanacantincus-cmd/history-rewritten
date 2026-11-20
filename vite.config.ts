import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Vite normally exposes public/ from root at dev time and copies it on build.
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4173' } },
});
