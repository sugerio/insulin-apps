import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Tests run on Node: the server and shared code against the preview's D1-compatible SQLite (src/local-d1.ts), and the
// React app under jsdom, talking to the same server in the test's process.
export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: { '#platform': resolve(import.meta.dirname, 'src/platform.local.ts') },
  },
  test: {
    // Console mode: the server reads the platform's identity headers, never the preview's stand-in owner.
    env: { TZ: 'UTC', SUGER_ACCESS_MODE: 'console' },
    projects: [
      {
        extends: true,
        test: { name: 'node', environment: 'node', include: ['test/{shared,server,engine}/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'web', environment: 'jsdom', include: ['test/web/**/*.test.{ts,tsx}'] },
      },
    ],
  },
})
