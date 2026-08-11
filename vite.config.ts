import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  // The P2P wasm package must not be pre-bundled by Vite's dep optimizer.
  optimizeDeps: {
    exclude: ['summer-iroh'],
  },
  publicDir: 'public',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
