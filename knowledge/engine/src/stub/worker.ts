// The in-memory engine as a Worker: the local stack and the workerd smoke test run it as insulin-apps-knowledge-engine
// and bind it to the app as SUGER_ENGINE, in place of the real engine. Its state lives in the isolate's memory, so it
// lasts as long as the process does. It also serves the control interface under /__control/ (control.ts).
//
// Imports take a couple of seconds and a sleeping collection a few to wake, so screens show progress; with the var
// KNOWLEDGE_STUB_TIMING=instant (the smoke test) everything finishes at once.

import { createStubEngine, type StubEngine } from './engine'
import { serveControl } from './control'

let engine: StubEngine | undefined

export default {
  async fetch(request: Request, env: Record<string, unknown> = {}): Promise<Response> {
    engine ??= createStubEngine({
      timing: env.KNOWLEDGE_STUB_TIMING === 'instant' ? { wakeMs: 0, importMs: 0, perDocumentMs: 0 } : { wakeMs: 3_000, importMs: 2_000, perDocumentMs: 500 },
    })
    return (await serveControl(engine.control, request)) ?? engine.fetch(request)
  },
}
