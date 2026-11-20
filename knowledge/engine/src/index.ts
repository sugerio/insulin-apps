// The Knowledge engine Worker: insulin-apps-knowledge-engine. It has no public address; the Knowledge app reaches
// it over the SUGER_ENGINE service binding and names the organization it acts for in x-knowledge-org on every call.
// Each collection's Durable Object is addressed by organization and collection, and also keeps its organization:
// another organization's collection id answers 404, exactly like an unknown one.

import type { Env } from './env.ts'
import { handle } from './router.ts'

export { CollectionEngine } from './collection.ts'
export { Capacity } from './capacity.ts'
export { Outbox } from './outbox.ts'
export { Registry } from './registry.ts'

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
} satisfies ExportedHandler<Env>
