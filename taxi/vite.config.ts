import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

const projectRoot = dirname(fileURLToPath(import.meta.url))

// The AppBuilder's shared UI modules, which it places under .suger/runtime.
const appBuilderModules = {
  '@suger/ui': 'sandbox-bundle.js',
  recharts: 'vendor/recharts-2.15.4.js',
  'date-fns': 'vendor/date-fns-4.2.1.js',
  lodash: 'vendor/lodash-4.18.1.js',
}

// What the server runs on, chosen at build time: the Cloudflare Worker (its env
// object: the D1 binding, vars and secrets) or, everywhere else, the local
// preview (process.env and a D1-compatible SQLite file). A Worker bundle never
// contains the local driver.
const platform = (process.env.NITRO_PRESET ?? '').startsWith('cloudflare')
  ? 'src/platform.worker.ts'
  : 'src/platform.local.ts'

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      '#platform': resolve(projectRoot, platform),
      ...Object.fromEntries(
        Object.entries(appBuilderModules).map(([name, path]) => [
          name,
          resolve(projectRoot, '.suger/runtime', path),
        ]),
      ),
    },
  },
  plugins: [
    react(),
    // index.html is the page; every /api/ request goes to src/api.ts.
    nitro({ routes: { '/api/**': './src/api.ts' } }),
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
})
