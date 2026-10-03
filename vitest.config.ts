import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

/**
 * Component tests.
 *
 * The Node test runner (`npm test`) strips types and cannot load `.tsx`, so
 * every UI behaviour in this repo is untested by construction — which is how a
 * fixed timeline height, a media row that survived deletion, and a scroller
 * that never scrolled all shipped green. This config runs the `.tsx` tests in a
 * real DOM instead, without disturbing the pure-logic suite.
 *
 * Only `*.test.tsx` is included: `.test.ts` files belong to the Node runner and
 * use `node:test`, which must not be loaded under Vitest.
 */
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
  },
})
