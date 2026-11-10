// Custom roles (DESIGN.md §2.3): only the organization's OWNERs create, change and delete them, each for one app and
// from that app's permission catalog. Every write re-checks the OWNER role in its own statement.
import type { Context } from '../context.ts'
import type { HostedApp } from '../config.ts'
import { newId } from '../crypto.ts'
import {
  customRoleUse, deleteCustomRole as removeCustomRole, findCustomRole, insertCustomRole, listCustomRoles,
  updateCustomRole as saveCustomRole,
} from '../db/grants.ts'
import { field } from '../http/request.ts'
import { log } from '../log.ts'
import { notFoundPage } from '../pages/status.tsx'
import { canManageCustomRoles, knownPermissions } from '../roles.ts'
import { ROLE_DESCRIPTION_MAX, checkRoleName, cleanText, truncate } from '../validate.ts'
import { actorChanged, backTo, memberOf, notAllowed, renderRoles } from './orgs.ts'

type Checked = { name: string; description: string; permissions: string[] } | { problem: string }

function checkForm(ctx: Context, app: HostedApp): Checked {
  const name = checkRoleName(field(ctx.form, 'name'))
  if ('problem' in name) return name
  const description = truncate(cleanText(field(ctx.form, 'description')), ROLE_DESCRIPTION_MAX)
  const permissions = knownPermissions(app, ctx.form.getAll('permission')).map((permission) => permission.key)
  if (!permissions.length) return { problem: 'Choose at least one permission.' }
  return { name: name.name, description, permissions }
}

async function nameTaken(ctx: Context, orgId: string, app: string, name: string, except: string | null): Promise<boolean> {
  const roles = await listCustomRoles(ctx.config.db, orgId)
  return roles.some((role) => role.app === app && role.id !== except && role.name.toLowerCase() === name.toLowerCase())
}

export async function createCustomRole(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canManageCustomRoles(membership.role)) return notAllowed(ctx, session)
  const problem = (error: string, status = 400) => renderRoles(ctx, session, membership, { error, status })
  const app = ctx.config.apps.find((candidate) => candidate.name === field(ctx.form, 'app'))
  if (!app || !app.permissions.length) return problem('Choose an app that has permissions to choose from.')
  const checked = checkForm(ctx, app)
  if ('problem' in checked) return problem(checked.problem)
  if (await nameTaken(ctx, membership.org_id, app.name, checked.name, null)) return problem(`${app.title} already has a role called "${checked.name}".`, 409)
  const id = newId()
  if (!(await insertCustomRole(ctx.config.db, { id, orgId: membership.org_id, app: app.name, ...checked, actorId: session.user.id, now: ctx.now }))) {
    return (await actorChanged(ctx, session, membership)) ?? problem(`${app.title} already has a role called "${checked.name}".`, 409)
  }
  log('custom_role_created', { org: membership.org_id, role: id, app: app.name, by: session.user.id })
  return backTo(ctx, 'roles', membership.org_id, 'role-created')
}

export async function updateCustomRole(ctx: Context, [orgId, roleId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canManageCustomRoles(membership.role)) return notAllowed(ctx, session)
  const role = await findCustomRole(ctx.config.db, membership.org_id, roleId!)
  const app = role ? ctx.config.apps.find((candidate) => candidate.name === role.app) : undefined
  if (!role || !app) return notFoundPage(ctx)
  const problem = (error: string, status = 400) => renderRoles(ctx, session, membership, { error, status })
  const checked = checkForm(ctx, app)
  if ('problem' in checked) return problem(checked.problem)
  if (await nameTaken(ctx, membership.org_id, app.name, checked.name, role.id)) return problem(`${app.title} already has a role called "${checked.name}".`, 409)
  if (!(await saveCustomRole(ctx.config.db, { id: role.id, orgId: membership.org_id, ...checked, actorId: session.user.id, now: ctx.now }))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('custom_role_updated', { org: membership.org_id, role: role.id, by: session.user.id })
  return backTo(ctx, 'roles', membership.org_id, 'role-updated')
}

export async function deleteCustomRole(ctx: Context, [orgId, roleId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canManageCustomRoles(membership.role)) return notAllowed(ctx, session)
  const db = ctx.config.db
  const role = await findCustomRole(db, membership.org_id, roleId!)
  if (!role) return notFoundPage(ctx)
  const inUse = 'This role is still given to people, invitations or service accounts. Give them another role first.'
  if ((await customRoleUse(db, membership.org_id, ctx.now)).get(role.id)) return renderRoles(ctx, session, membership, { error: inUse, status: 409 })
  if (!(await removeCustomRole(db, membership.org_id, role.id, session.user.id, ctx.now))) {
    return (await actorChanged(ctx, session, membership)) ?? renderRoles(ctx, session, membership, { error: inUse, status: 409 })
  }
  log('custom_role_deleted', { org: membership.org_id, role: role.id, by: session.user.id })
  return backTo(ctx, 'roles', membership.org_id, 'role-deleted')
}
