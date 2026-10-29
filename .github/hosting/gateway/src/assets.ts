// The gateway's static files. /__insulin/* are served on every host, even before configuration is checked, so the 503
// page is styled; /favicon.ico and /apple-touch-icon.png only on the apex and auth hosts (router.ts), since app hosts
// serve their own.
import type { Context } from './context.ts'
import { BAR_CSS } from './assets/bar-css.ts'
import { BAR_JS } from './assets/bar-js.ts'
import { GATEWAY_CSS } from './assets/gateway-css.ts'
import { ICON_SVG } from './assets/icon.ts'
import { APPLE_TOUCH_ICON_BASE64, FAVICON_ICO_BASE64 } from './assets/icons.ts'
import { assetHeaders } from './http/headers.ts'

// The stylesheet and the bar change with a deploy, so they are cached briefly; the icons hardly ever change.
const SHORT = 'public, max-age=300'
// The icons keep stable URLs, so a day's cache lets a new mark reach browsers soon after a deploy.
const ICON = 'public, max-age=86400'

interface Asset {
  body: string | Uint8Array
  type: string
  cache: string
}

function bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

const ASSETS: Record<string, Asset> = {
  '/__insulin/gateway.css': { body: GATEWAY_CSS, type: 'text/css; charset=utf-8', cache: SHORT },
  '/__insulin/bar.css': { body: BAR_CSS, type: 'text/css; charset=utf-8', cache: SHORT },
  '/__insulin/bar.js': { body: BAR_JS, type: 'text/javascript; charset=utf-8', cache: SHORT },
  '/__insulin/icon.svg': { body: ICON_SVG, type: 'image/svg+xml', cache: ICON },
}

const SITE_ICONS: Record<string, Asset> = {
  '/favicon.ico': { body: bytes(FAVICON_ICO_BASE64), type: 'image/x-icon', cache: ICON },
  '/apple-touch-icon.png': { body: bytes(APPLE_TOUCH_ICON_BASE64), type: 'image/png', cache: ICON },
}

function serve(request: Request, asset: Asset): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  return new Response(request.method === 'HEAD' ? null : asset.body, { headers: assetHeaders(asset.type, asset.cache) })
}

export function staticAsset(request: Request, url: URL): Response | null {
  const asset = ASSETS[url.pathname]
  return asset ? serve(request, asset) : null
}

/** /favicon.ico and /apple-touch-icon.png, as routes of the apex and auth hosts. */
export function siteIcon(ctx: Context): Response {
  return serve(ctx.request, SITE_ICONS[ctx.url.pathname]!)
}
