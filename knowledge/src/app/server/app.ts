import { Hono } from 'hono'
import { apiCatalog } from './catalog.ts'
import { EngineCallError } from './engine/client.ts'
import type { AppEnv } from './env.ts'
import { nowOf } from './env.ts'
import { ApiError, forbidden, logError } from './http.ts'
import { can, isOrgOwner, isScheduleTick, PERMISSIONS, readCaller } from './identity.ts'
import { rememberCaller } from './members.ts'
import { syncOutbox } from './outbox.ts'
import { askingRoutes } from './routes/asking.ts'
import { attentionRoutes } from './routes/attention.ts'
import { collectionRoutes } from './routes/collections.ts'
import { historyRoutes } from './routes/history.ts'
import { knowledgeRoutes } from './routes/knowledge.ts'
import { rulesRoutes } from './routes/rules.ts'
import { sharingRoutes } from './routes/sharing.ts'
import { sourceRoutes } from './routes/sources.ts'
import { runTick } from './tick.ts'

/** What the engine's errors become for a person: plain words, never the engine's raw text. */
function engineError(error: EngineCallError): ApiError {
  const retry = error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}
  switch (error.code) {
    case 'not_found':
      return new ApiError('not_found', "That isn't in this collection any more. Reload and try again.")
    case 'deleting':
      return new ApiError('deleting', 'This collection is being deleted.')
    case 'not_restorable':
      return new ApiError('not_restorable', "This version can't be brought back: a file it held was removed for good, or it is too old.")
    case 'busy_learning':
      return new ApiError('busy_learning', 'This collection is learning. Try again once it has finished.', retry)
    case 'capacity':
      return new ApiError('capacity', 'Insulin Knowledge is busy. Try again in a few minutes.', retry)
    case 'too_large':
      return new ApiError('payload_too_large', 'That file is too large to learn.')
    case 'unsupported_type':
      return new ApiError('unsupported_type', "That is a type of file Insulin can't read.")
    case 'bad_request':
      return new ApiError('bad_request', error.message && error.status === 400 ? plain(error.message) : "The request wasn't accepted. Reload and try again.")
    default:
      return new ApiError('engine_unavailable', "Knowledge's engine isn't answering right now. Try again in a minute.", retry)
  }
}

/** An engine message passed on only when it reads as a sentence for a person (the engine writes them so). */
const plain = (message: string) => (/^[A-Z“"].{5,300}[.!?]$/s.test(message) && !/Error|Exception|at \w+ \(/.test(message) ? message : "The request wasn't accepted. Reload and try again.")

/**
 * Knowledge's API (`/api/**`): who calls (identity.ts), then the routes, each checking the caller's permissions and
 * role in the collection on the server for every way in (the site, AI assistants, API clients). The platform's tick
 * reaches `POST /api/scheduled` only, with no identity. Changes from a browser must come from the app's own origin
 * (the gateway sets Origin for assistants and API clients), outside development.
 */
export function createApp(options: { enforceSameOrigin?: boolean } = {}) {
  const app = new Hono<AppEnv>()

  app.use('/api/*', async (c, next) => {
    await next()
    c.res.headers.set('cache-control', 'no-store')
    c.res.headers.set('x-content-type-options', 'nosniff')
  })

  // The platform's tick, every five minutes (package.json `insulin.scheduled`). Only the tick passes: a request with a
  // member's, an API client's or an assistant's identity, or without `x-suger-access-via: schedule`, is refused. It is
  // never in the catalog.
  app.post('/api/scheduled', async (c) => {
    if (!isScheduleTick(c.req.raw)) throw forbidden('Only the platform can call this.')
    return c.json(await runTick(c.env, nowOf(c.env)))
  })

  if (options.enforceSameOrigin ?? !import.meta.env.DEV) {
    app.use('/api/*', async (c, next) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
        const origin = c.req.header('origin')
        const site = c.req.header('sec-fetch-site')
        if (origin !== new URL(c.req.url).origin || (site !== undefined && site !== 'same-origin')) throw forbidden('Cross-site request blocked.')
      }
      await next()
    })
  }

  app.use('/api/*', async (c, next) => {
    const caller = readCaller(c.req.raw, { preview: c.env.PREVIEW === true, trustOrgRole: c.env.TRUST_ORG_ROLE === true })
    // Without an identity, /api/health says only that the app answers (for uptime checks); everything else is 401.
    if (!caller && c.req.path === '/api/health' && c.req.method === 'GET') return c.json({ status: 'ok', service: 'knowledge' })
    if (!caller) return new ApiError('unauthorized', 'Sign in on insulinapps.com to use Knowledge.').toResponse()
    if (!can(caller, 'knowledge.use') && c.req.path !== '/api/me' && c.req.path !== '/api/catalog') {
      throw forbidden("Your role doesn't include Knowledge. Ask an admin of your organization for access.")
    }
    c.set('caller', caller)
    try {
      await rememberCaller(c.env.DB, caller, nowOf(c.env))
    } catch (error) {
      logError('remember_caller_failed', error)
    }
    await next()
  })

  // Who is calling, for the screens and for agents: the organization, the roles and what they allow.
  app.get('/api/me', (c) => {
    const caller = c.get('caller')
    return c.json({
      organizationId: caller.organizationId,
      user: { id: caller.id, email: caller.email, name: caller.name, kind: caller.kind },
      role: caller.appRole,
      organizationRole: caller.orgRole,
      isOrganizationOwner: isOrgOwner(caller),
      permissions: PERMISSIONS.filter((permission) => can(caller, permission)),
      accessVia: caller.via,
      preview: caller.preview,
      engine: Boolean(c.env.ENGINE),
      supportConfigured: Boolean(c.env.SUPPORT_EMAIL?.trim()),
    })
  })

  app.get('/api/catalog', (c) => c.json(apiCatalog(c.get('caller'))))

  // After a request that may have changed something in the engine, its outbox is pulled too (as on the tick), so
  // counts, history and usage follow at once; in the background when the runtime allows, never failing the request.
  app.use('/api/collections/*', async (c, next) => {
    await next()
    if (!c.env.ENGINE || c.res.status >= 500) return
    const sync = syncOutbox(c.env, nowOf(c.env), Date.now() + 3_000).catch((error) => logError('outbox_sync_failed', error))
    if (c.env.WAIT_UNTIL) c.env.WAIT_UNTIL(sync)
    else await sync
  })

  app.route('/api', askingRoutes())
  app.route('/api', sharingRoutes())
  app.route('/api', rulesRoutes())
  app.route('/api', attentionRoutes())
  app.route('/api/collections', collectionRoutes())
  app.route('/api/collections', sourceRoutes())
  app.route('/api/collections', knowledgeRoutes())
  app.route('/api/collections', historyRoutes())
  app.all('/api/*', () => {
    throw new ApiError('not_found', 'There is no such API route. GET /api/catalog lists them.')
  })

  app.onError((error, c) => {
    if (error instanceof ApiError) return error.toResponse()
    if (error instanceof EngineCallError) {
      logError('engine_call_failed', error, { status: error.status, code: error.code, route: c.req.routePath || 'unmatched' })
      return engineError(error).toResponse()
    }
    logError('unhandled_error', error, { method: c.req.method, route: c.req.routePath || 'unmatched' })
    return new ApiError('internal', 'Something went wrong. Try again in a minute.').toResponse()
  })
  return app
}
