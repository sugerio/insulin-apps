// The in-memory engine's control interface over HTTP, under /__control/, for the local stack and end-to-end tests.
// It exists only in the stub (development and the workerd smoke test); the real engine has nothing like it.

import type { UsageKind } from '../contract'
import type { StubControl, StubTiming } from './engine'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Answers a control request, or null when the path isn't one:
 *
 * - `POST /__control/state` `{ org, collectionId, state: asleep|waking|learning|busy|ready|null, seconds? }`
 * - `POST /__control/fail-next-import` `{ org?, collectionId?, times? (1-3, 3 fails it), fileName? }`
 * - `POST /__control/usage` `{ org, collectionId, kind: awake|learning|export|ready, seconds }`
 * - `POST /__control/hold` `{ on }`, `POST /__control/advance` `{ ms }`, `POST /__control/run`
 * - `POST /__control/answer-mode` `{ mode: ok|bad_citation|fail }`, `POST /__control/timing` `{ wakeMs?, importMs?, perDocumentMs? }`
 * - `POST /__control/damage` `{ org, collectionId, version }`: a restore point that failed its integrity check twice
 * - `POST /__control/reset`, `GET /__control/state`
 */
export async function serveControl(control: StubControl, request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/__control/')) return null
  if (request.method === 'GET' && path === '/__control/state') return json(control.snapshot())
  if (request.method !== 'POST') return json({ error: 'bad_request', message: 'Use POST.' }, 405)
  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return json({ error: 'bad_request', message: 'The request body must be JSON.' }, 400)
  }
  const text = (name: string) => (typeof body[name] === 'string' ? (body[name] as string) : undefined)
  const number = (name: string) => (typeof body[name] === 'number' && Number.isFinite(body[name]) ? (body[name] as number) : undefined)
  try {
    switch (path) {
      case '/__control/state':
        control.setState(text('org') ?? '', text('collectionId') ?? '', (body.state ?? null) as Parameters<StubControl['setState']>[2], number('seconds'))
        break
      case '/__control/fail-next-import':
        control.failNextImport({ org: text('org'), collectionId: text('collectionId'), times: number('times') ?? 1, fileName: text('fileName') })
        break
      case '/__control/usage':
        control.addUsage(text('org') ?? '', text('collectionId') ?? '', (text('kind') ?? 'awake') as UsageKind, number('seconds') ?? 0)
        break
      case '/__control/hold':
        control.hold(body.on === true)
        break
      case '/__control/advance':
        control.advance(number('ms') ?? 0)
        break
      case '/__control/run':
        control.runUntilIdle()
        break
      case '/__control/answer-mode':
        control.setAnswerMode((text('mode') ?? 'ok') as 'ok' | 'bad_citation' | 'fail')
        break
      case '/__control/timing':
        control.setTiming(body as Partial<StubTiming>)
        break
      case '/__control/damage':
        control.damage(text('org') ?? '', text('collectionId') ?? '', number('version') ?? 0)
        break
      case '/__control/reset':
        control.reset()
        break
      default:
        return json({ error: 'not_found', message: 'There is no such control.' }, 404)
    }
  } catch (error) {
    return json({ error: 'bad_request', message: error instanceof Error ? error.message : 'The control failed.' }, 400)
  }
  return json({ ok: true, ...control.snapshot() })
}
