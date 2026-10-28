// The gateway's static files, served on every host (even before configuration is checked, so the 503 page is styled).
import { BAR_CSS } from './assets/bar-css.ts'
import { BAR_JS } from './assets/bar-js.ts'
import { GATEWAY_CSS } from './assets/gateway-css.ts'
import { assetHeaders } from './http/headers.ts'

const ASSETS: Record<string, { body: string; type: string }> = {
  '/__insulin/gateway.css': { body: GATEWAY_CSS, type: 'text/css; charset=utf-8' },
  '/__insulin/bar.css': { body: BAR_CSS, type: 'text/css; charset=utf-8' },
  '/__insulin/bar.js': { body: BAR_JS, type: 'text/javascript; charset=utf-8' },
}

export function staticAsset(request: Request, url: URL): Response | null {
  const asset = ASSETS[url.pathname]
  if (!asset) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  return new Response(request.method === 'HEAD' ? null : asset.body, { headers: assetHeaders(asset.type) })
}
