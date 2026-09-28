import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    headers: {
      // Required for SharedArrayBuffer -> threaded ffmpeg-style work later.
      // Harmless today, and forgetting it is a nasty debug session.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Multi-page: / is the editor, /phase0 is the raw encode-loop proof.
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: 'index.html', phase0: 'phase0.html' } },
  },
})
