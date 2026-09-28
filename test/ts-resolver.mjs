/**
 * Teach Node to resolve the bundler-style `./foo.js` specifiers our source
 * uses to the actual `./foo.ts` files.
 *
 * The app is built by Vite, which resolves those happily. Node's type
 * stripping does not, so a test that imports a module with a relative import
 * fails on ERR_MODULE_NOT_FOUND — which silently limits the test suite to
 * files that happen to have no imports.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true, format: 'module-typescript' }
    }
  }
  return nextResolve(specifier, context)
}
