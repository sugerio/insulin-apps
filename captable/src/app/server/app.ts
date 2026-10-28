import { Hono, type MiddlewareHandler } from 'hono'
import { requestConfig } from './lib/config.ts'
import { resolveCurrentIdentity } from './lib/identity.ts'
import { ApiError, logError, notFound } from './lib/http.ts'
import { accessMeetsMinimum } from './lib/access/resolve.ts'
import { requireSameOrigin } from './middleware/same-origin.ts'
import { securityHeaders } from './middleware/security-headers.ts'
import { commandRoutes } from './routes/commands.ts'
import { documentRoutes, portalDocumentRoutes } from './routes/documents.ts'
import { ledgerAdminRoutes, ledgerWriteRoutes } from './routes/ledger-admin.ts'
import { meRoutes } from './routes/me.ts'
import { orgRoutes as orgWriteRoutes } from './routes/orgs.ts'
import { paymentInstructionRoutes } from './routes/payment-instructions.ts'
import { orgRoutes as orgReadRoutes, portalRoutes, readRoutes } from './routes/reads.ts'
import { reportRoutes } from './routes/reports.ts'
import { stakeholderRoutes } from './routes/stakeholders.ts'
import { orgAdminLinkRoutes } from './routes/admin.ts'
import { importRoutes } from './routes/imports.ts'
import type { AppDeps, AppEnv } from './types.ts'

export function createDeps(options: Partial<AppDeps> = {}): AppDeps {
  return {
    now: options.now ?? Date.now,
    runImportBatch: options.runImportBatch ?? ((db, statements) => db.batch(statements)),
  }
}

function hasWriteAccess(role: string): boolean {
  return role === 'OWNER' || role === 'ADMIN'
}

function isReadOnlyMutation(method: string, path: string): boolean {
  return method === 'POST' && /^\/api\/orgs\/[^/]+\/vesting-terms\/preview$/.test(path)
}

export function createApp(options: Partial<AppDeps> & { enforceSameOrigin?: boolean } = {}) {
  const deps = createDeps(options)
  const app = new Hono<AppEnv>()

  app.use('*', securityHeaders())
  app.use('*', async (c, next) => {
    c.set('config', requestConfig(c.req.raw))
    await next()
  })

  app.get('/api/health', (c) => c.json({ ok: true, service: 'cap-table' }))

  if (options.enforceSameOrigin ?? !import.meta.env.DEV) {
    app.use('/api/*', requireSameOrigin())
  }
  app.use('/api/*', async (c, next) => {
    const auth = await resolveCurrentIdentity(c.req.raw, c.env.DB, deps.now())
    if (!auth) {
      return c.json({ error: 'Open this app from the Insulin console' }, 401)
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
      && !isReadOnlyMutation(c.req.method, c.req.path)
      && hasWriteAccess(auth.consoleRole)
      && !auth.user.email) {
      throw new ApiError('forbidden', 'Add an e-mail address to your console profile before making changes')
    }
    c.set('auth', auth)
    await next()
  })

  const requireCompany: MiddlewareHandler<AppEnv> = async (c, next) => {
    const org = c.get('auth').orgAccess.get(c.req.param('orgId')!)
    if (!org) throw notFound('Company not found')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
      && !isReadOnlyMutation(c.req.method, c.req.path)
      && !accessMeetsMinimum(org.access, 'admin_rw')) {
      throw new ApiError('forbidden', 'You have view-only access')
    }
    c.set('org', org)
    await next()
  }
  app.use('/api/orgs/:orgId', requireCompany)
  app.use('/api/orgs/:orgId/*', requireCompany)

  app.use('/api/admin/*', async (c, next) => {
    if (!hasWriteAccess(c.get('auth').consoleRole)) {
      throw new ApiError('forbidden', 'Administrator access is required')
    }
    await next()
  })
  app.use('/api/import/*', async (c, next) => {
    if (!hasWriteAccess(c.get('auth').consoleRole)) {
      throw new ApiError('forbidden', 'Administrator access is required')
    }
    await next()
  })
  app.use('/api/portal/*', async (c, next) => {
    if (c.get('auth').portalMatches.length === 0) throw notFound()
    await next()
  })

  app.route('/api/me', meRoutes(deps))
  app.route('/api/import', importRoutes(deps))
  app.route('/api/orgs', orgWriteRoutes(deps))
  app.route('/api/orgs', orgReadRoutes())
  app.route('/api/orgs/:orgId', orgAdminLinkRoutes(deps))
  app.route('/api/orgs/:orgId/stakeholders', stakeholderRoutes(deps))
  app.route('/api/orgs/:orgId', documentRoutes(deps))
  app.route('/api/orgs/:orgId', paymentInstructionRoutes(deps))
  app.route('/api/orgs/:orgId', commandRoutes(deps))
  app.route('/api/orgs/:orgId', ledgerWriteRoutes(deps))
  app.route('/api/orgs/:orgId', readRoutes(deps))
  app.route('/api/orgs/:orgId', reportRoutes(deps))
  app.route('/api/portal', portalDocumentRoutes(deps))
  app.route('/api/portal', portalRoutes(deps))
  app.route('/api/admin', ledgerAdminRoutes(deps))
  app.all('/api/*', () => { throw notFound('Unknown API route') })

  app.onError((error, c) => {
    if (error instanceof ApiError) return error.toResponse()
    logError('unhandled_error', error, { method: c.req.method, route: c.req.routePath || 'unmatched' })
    return new ApiError('internal', 'Something went wrong').toResponse()
  })
  return app
}
