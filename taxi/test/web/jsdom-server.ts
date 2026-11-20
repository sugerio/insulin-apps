import { builtinEnvironments, type Environment } from "vitest/runtime";

// jsdom for the screens, with modules prepared the way the server's are (Vite's `ssr` environment): the web tests
// render the app against the real server in the same process (test/support/server.ts), whose database is Node's
// SQLite (src/local-d1.ts), which Vite refuses to prepare for a browser on Node 22.
export default { ...builtinEnvironments.jsdom, name: "jsdom-server", viteEnvironment: "ssr" } satisfies Environment;
