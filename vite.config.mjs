import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'remove-crossorigin',
      transformIndexHtml(html) {
        return html.replace(/ crossorigin/g, '');
      },
    },
  ],

  // All asset references stay relative so they resolve under file://
  // (Electron production) as well as http:// (Vite dev server).
  base: './',

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  // ─── Keep native deps OUT of the renderer bundle ─────────────────────────
  // tesseract.js runs in the MAIN process (electron/ocrWorker.js). The
  // browser-fallback import() in src/utils/ocrEngine.js is only reached
  // outside Electron, so we mark it external to stop Vite/Rollup from
  // emitting a renderer chunk for it. That chunk previously caused the
  // production black screen: Vite rewrote the dynamic import with
  // `import.meta.url`, which under file:// + asar cannot resolve the
  // Tesseract worker script or WASM core, so createWorker() hung forever.
  optimizeDeps: {
    exclude: ['tesseract.js'],
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Avoid transpiling dynamic import() into a URL-relative helper.
    target: 'esnext',
    rollupOptions: {
      external: ['tesseract.js'],
      output: {
        // Force a single entry chunk for the renderer — no orphaned
        // sibling chunks that could be referenced by an absolute URL.
        manualChunks: undefined,
      },
    },
  },
});
