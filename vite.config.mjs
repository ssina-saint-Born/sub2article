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

  // ─── Keep native deps OUT of the renderer bundle (desktop only) ────────────
  // tesseract.js runs in the MAIN process (electron/ocrWorker.js). In Electron
  // mode, the render-side `await import('tesseract.js')` browser-fallback is
  // never reached because bridge.ocr.run (IPC) is used instead — so marking
  // it external prevents Vite/Rollup from bundling an extra ~5MB renderer
  // chunk we don't need, while still letting the dev server resolve it.
  //
  // BUILD-TARGETED: when BUILD_TARGET !== 'desktop', the `external` entry is
  // REMOVED so the dynamic `await import('tesseract.js')` in the browser
  // fallback becomes a real lazy-loaded chunk shipped into dist/assets/.
  // That chunk is what runs local OCR in the web build (WASM worker +
  // tessdata over CDN, paths overridden in src/utils/ocrEngine.js). The
  // desktop build passes BUILD_TARGET=desktop and keeps the external entry.
  optimizeDeps: {
    exclude: ['tesseract.js'],
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Avoid transpiling dynamic import() into a URL-relative helper.
    target: 'esnext',
    rollupOptions: {
      // Only external in desktop builds — see comment above.
      external: process.env.BUILD_TARGET === 'desktop' ? ['tesseract.js'] : [],
      output: {
        // Force a single entry chunk for the renderer — no orphaned
        // sibling chunks that could be referenced by an absolute URL.
        manualChunks: undefined,
      },
    },
  },
});
