// Per-request state: which of the gateway's hosts was asked for, the public scheme and origins, the clock, the form
// body of a POST and the cookies to add to the response.
import type { Config, HostedApp } from './config.ts'
import type { Env } from './env.ts'
import type { Session } from './auth/session.ts'

export type Site = 'apex' | 'auth' | 'app' | 'other'

export interface Context {
  env: Env
  config: Config
  exec: ExecutionContext
  request: Request
  url: URL
  /** The request's hostname, lower-cased. Routing never trusts the Host header separately from the URL. */
  host: string
  site: Site
  app: HostedApp | null
  /** https: everywhere, except http: for *.localhost when SITE_ENV=test. */
  scheme: 'https:' | 'http:'
  /** `:<port>` on a local development server, otherwise empty. */
  portSuffix: string
  /** SITE_ENV=test on http://*.localhost: cookies drop Secure and the __Host- prefix. Never in production. */
  relaxed: boolean
  now: number
  clientIp: string | null
  /** The parsed form of a POST, set by the router after its Origin and content-type checks. */
  form: URLSearchParams
  /** Set-Cookie values for the final response (router.ts adds them). */
  setCookies: string[]
  session?: { value: Session | null }
}

export function createContext(request: Request, env: Env, exec: ExecutionContext, config: Config): Context {
  const url = new URL(request.url)
  const host = url.hostname.toLowerCase()
  const app = config.appsByHost.get(host) ?? null
  const site: Site = host === config.domain ? 'apex' : host === config.authHost ? 'auth' : app ? 'app' : 'other'
  const relaxed = config.testMode && url.protocol === 'http:' && (host === 'localhost' || host.endsWith('.localhost'))
  return {
    env,
    config,
    exec,
    request,
    url,
    host,
    site,
    app,
    scheme: relaxed ? 'http:' : 'https:',
    portSuffix: relaxed && url.port ? `:${url.port}` : '',
    relaxed,
    now: Date.now(),
    clientIp: request.headers.get('CF-Connecting-IP'),
    form: new URLSearchParams(),
    setCookies: [],
  }
}

export function originOf(ctx: Context, host: string): string {
  return `${ctx.scheme}//${host}${ctx.portSuffix}`
}

/** This request's own origin, as browsers send it in the Origin header. */
export function ownOrigin(ctx: Context): string {
  return originOf(ctx, ctx.host)
}

export function authUrl(ctx: Context, path: string): string {
  return `${originOf(ctx, ctx.config.authHost)}${path}`
}

export function apexUrl(ctx: Context, path = '/'): string {
  return `${originOf(ctx, ctx.config.domain)}${path}`
}

export function appUrl(ctx: Context, app: HostedApp, path = '/'): string {
  return `${originOf(ctx, app.host)}${path}`
}

/** `/login?return_to=…` and friends: a path on the auth host with an optional return address. */
export function withReturnTo(path: string, returnTo: string | null): string {
  if (!returnTo) return path
  return `${path}${path.includes('?') ? '&' : '?'}return_to=${encodeURIComponent(returnTo)}`
}
