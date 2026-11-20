import { builtinEnvironments, type Environment } from 'vitest/runtime'

// jsdom for the screens, with modules prepared the way the server's are (Vite's `ssr` environment): the page tests
// render the screens against Knowledge's own API in the same process (support/live.tsx), whose preview database is
// Node's SQLite, which Vite refuses to prepare for a browser.
export default { ...builtinEnvironments.jsdom, name: 'jsdom-server', viteEnvironment: 'ssr' } satisfies Environment
