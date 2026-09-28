import { defineConfig, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'

/**
 * Print the browser's debug logs in this terminal.
 *
 * "Copy the console output and paste it" is a bad debugging loop — it is slow,
 * it loses context, and it fails entirely when the bug is intermittent. This
 * makes the browser and the dev server share one place to look.
 *
 * Development only. It is a plugin on the dev server, so it does not exist in a
 * production build.
 */
function terminalLogger(): Plugin {
  return {
    name: 'open-editor:terminal-logger',
    configureServer(server) {
      server.middlewares.use('/__debug', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }

        let body = ''
        req.on('data', (chunk) => {
          body += chunk
          // A runaway log loop should not exhaust memory.
          if (body.length > 1_000_000) req.destroy()
        })

        req.on('end', () => {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end('ok')
          try {
            const entry = JSON.parse(body) as { level: string; message: string; time: number; tag: string }
            const stamp = new Date(entry.time).toISOString().slice(11, 23)
            const colour =
              entry.level === 'error' ? '\x1b[31m' : entry.level === 'warn' ? '\x1b[33m' : entry.level === 'debug' ? '\x1b[90m' : '\x1b[36m'
            process.stdout.write(
              `${colour}\x1b[2m${stamp}\x1b[0m ${colour}[${entry.tag}]\x1b[0m ${entry.message}\n`,
            )
          } catch {
            // A malformed payload is not worth crashing the dev server over.
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [solid(), terminalLogger()],
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
