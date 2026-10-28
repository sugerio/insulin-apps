import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Tests run on Node: server, shared and import code against the preview's
// D1-compatible SQLite (src/local-d1.ts), and the React app under jsdom.
export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: { '#platform': resolve(import.meta.dirname, 'src/platform.local.ts') },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          // The retained server fixtures build a full synthetic ledger on the current Drizzle schema.
          testTimeout: 15_000,
          include: ['test/{shared,server,db,import}/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['test/web/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
