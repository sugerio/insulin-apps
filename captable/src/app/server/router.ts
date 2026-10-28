import { openAppD1 } from '#platform'
import { createApp } from './app.ts'

const app = createApp()

export async function handleAppRequest(request: Request): Promise<Response> {
  const database = await openAppD1()
  return app.fetch(request, { DB: database as D1Database })
}
