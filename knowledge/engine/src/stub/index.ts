// The in-memory engine (engine.ts) and its control interface, for the Knowledge app's development builds and tests.
// worker.ts serves the same engine as a Worker, for the local stack and the workerd smoke test.

export { createStubEngine, STUB_MARKER, type StubControl, type StubEngine, type StubOptions, type StubTiming } from './engine'
export { applyHiding, DEFAULT_HIDING, findHidden, type HidingRuleSet } from './hiding'
export { serveControl } from './control'

import { createStubEngine, type StubEngine } from './engine'

let shared: StubEngine | undefined

/**
 * The one in-memory engine of a development server (`npm run dev`, the AppBuilder's preview), kept for the process's
 * life so collections survive between requests. Imports take a few seconds and waking a minute's worth of seconds, so
 * the screens show progress as they would with the real engine.
 */
export function devEngine(): StubEngine {
  shared ??= createStubEngine({ timing: { wakeMs: 3_000, importMs: 2_000, perDocumentMs: 500 } })
  return shared
}
