
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // GitHub Pages: https://mtsqy.github.io/ghactions-test/
  // Local development uses "/".
  base: command === 'build' ? '/ghactions-test/' : '/',

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
  },

  // Ensure Three.js is pre-bundled during development.
  optimizeDeps: {
    include: ['three'],
  },
}));
