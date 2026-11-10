// E-sign's addition to the Nitro server the Insulin template builds (vite.config.ts stays as the template has it; Nitro
// reads this file next to it). One middleware: the security headers of the pages (src/app/server/page-headers.ts).
import { defineConfig } from 'nitro/config'

export default defineConfig({
  handlers: [{ route: '/**', middleware: true, handler: './src/app/server/page-headers.ts' }],
})
