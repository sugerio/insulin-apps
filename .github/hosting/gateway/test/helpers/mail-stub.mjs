// Stands in for the Cloudflare Email Service binding in production-mode tests: `env.EMAIL.send(message)` reaches
// Mailer.send over RPC. Tests read what was sent, or make sends fail with a code, through the default fetch handler.
import { WorkerEntrypoint } from 'cloudflare:workers'

const sent = []
let failWith = null

export class Mailer extends WorkerEntrypoint {
  async send(message) {
    if (failWith) {
      const error = new Error('send failed')
      error.code = failWith
      throw error
    }
    sent.push(message)
    return { messageId: `<stub-${sent.length}@example.test>` }
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/sent') return Response.json(sent)
    if (url.pathname === '/fail') {
      failWith = url.searchParams.get('code') || null
      return new Response('ok')
    }
    return new Response('mail stub')
  },
}
