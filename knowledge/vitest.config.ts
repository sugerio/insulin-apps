import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Tests run on Node: the server against the preview's D1-compatible SQLite (src/local-d1.ts) with the in-memory engine
// (engine/src/stub/) as the engine, and the screens under jsdom against the same API.
export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: { '#platform': resolve(import.meta.dirname, 'src/platform.local.ts') },
  },
  test: {
    // Dates format in the machine's time zone; CI runs in UTC, so every machine does.
    env: { TZ: 'UTC', SUGER_ACCESS_MODE: 'console' },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          testTimeout: 15_000,
          include: ['test/{server,engine,db}/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          // jsdom, with modules prepared as the server's are: page tests run the screens against the real API.
          environment: './test/web/support/jsdom-server.ts',
          include: ['test/web/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
