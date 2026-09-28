import { defineConfig, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

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
      const counter = { now: 0, total: 0, warned: false }
      const reset = setInterval(() => {
        counter.now = 0
        counter.warned = false
      }, 1000)
      server.httpServer?.once('close', () => clearInterval(reset))

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

          // Defence in depth. A page bug that emits thousands of logs per
          // second can saturate stdout and the event loop, which looks
          // exactly like a crashed browser. Count and complain once.
          const perSecond = ++counter.now
          if (perSecond > 200) {
            if (!counter.warned) {
              counter.warned = true
              process.stdout.write('\x1b[31m[!] over 200 debug logs/sec — the page is probably in a log loop\x1b[0m\n')
            }
            return
          }
          counter.total++

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
  plugins: [solid(), tailwindcss(), terminalLogger()],
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
