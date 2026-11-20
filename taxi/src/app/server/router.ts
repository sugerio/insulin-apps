import { openAppD1, readAppEnv } from '#platform'
import { createApp } from './app.ts'
import { gatewayFetchOf } from './gateway-fetch.ts'

const app = createApp()

export async function handleAppRequest(request: Request): Promise<Response> {
  const database = await openAppD1()
  const gatewayFetch = gatewayFetchOf(request)
  return app.fetch(request, {
    DB: database as D1Database,
    // The hourly usage report (lib/usage-metrics.ts): the deploy sets both when the platform takes reports, and the
    // report goes over the gateway's service binding when the deploy gave the app one (gateway-fetch.ts).
    SUGER_METRICS_URL: readAppEnv('SUGER_METRICS_URL'),
    SUGER_APP_TOKEN: readAppEnv('SUGER_APP_TOKEN'),
    ...(gatewayFetch ? { METRICS_FETCH: gatewayFetch } : {}),
  })
}
