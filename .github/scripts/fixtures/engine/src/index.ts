import { DurableObject } from 'cloudflare:workers'

export class CollectionEngine extends DurableObject {}
export class Capacity extends DurableObject {}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ engine: 'fixture' })
  },
}
