// Access as forms send it and pages show it. An organization role is `role`; specific-apps access is role APPS with one
// `app:<name>` field per app, whose value is '' (no access), ADMIN, EDITOR, VIEWER or `custom:<id>`.
import type { Choice } from '../components/forms.tsx'
import type { Config, HostedApp } from '../config.ts'
import type { CustomRoleRow, GrantInput, GrantRole } from '../db/grants.ts'
import { field } from '../http/request.ts'
import { APP_ROLES, APP_ROLE_LABELS, ROLE_LABELS, grantableRoles, isAppRole, isRole, type Role } from '../roles.ts'

export const CUSTOM_PREFIX = 'custom:'

export function grantField(app: HostedApp): string {
  return `app:${app.name}`
}

/** What a grant looks like to people: "Editor", or the custom role's name. */
export function grantLabel(grant: { role: GrantRole; custom_role_name: string | null }): string {
  return isAppRole(grant.role) ? APP_ROLE_LABELS[grant.role] : grant.custom_role_name ?? 'Custom role'
}

/** A grant as a form value. */
export function grantValue(grant: { role: GrantRole; custom_role_id: string | null }): string {
  return grant.role === 'CUSTOM' ? `${CUSTOM_PREFIX}${grant.custom_role_id}` : grant.role
}

/** The choices for one app: the built-in roles, then the app's custom roles; `none` adds "No access" first. */
export function grantChoices(app: HostedApp, customRoles: readonly CustomRoleRow[], none: boolean): Choice[] {
  return [
    ...(none ? [{ value: '', label: 'No access' }] : []),
    ...APP_ROLES.map((role) => ({ value: role, label: APP_ROLE_LABELS[role] })),
    ...customRoles.filter((role) => role.app === app.name).map((role) => ({ value: `${CUSTOM_PREFIX}${role.id}`, label: `${role.name} (custom)` })),
  ]
}

/** One app's form value as a grant: null for no access, 'invalid' for anything else that isn't a choice. */
export function parseGrant(app: HostedApp, value: string, customRoles: readonly CustomRoleRow[]): GrantInput | null | 'invalid' {
  if (value === '') return null
  if (isAppRole(value)) return { app: app.name, role: value, customRoleId: null }
  if (value.startsWith(CUSTOM_PREFIX)) {
    const id = value.slice(CUSTOM_PREFIX.length)
    if (customRoles.some((role) => role.id === id && role.app === app.name)) return { app: app.name, role: 'CUSTOM', customRoleId: id }
  }
  return 'invalid'
}

export type ParsedAccess = { role: Role; grants: GrantInput[] } | { problem: string; status: number }

/**
 * The access a form asks for, checked against what `actor` may give: an organization role (and no app fields), or
 * specific apps with at least one app.
 */
export function parseAccessForm(config: Config, form: URLSearchParams, actor: Role, customRoles: readonly CustomRoleRow[]): ParsedAccess {
  const role = field(form, 'role')
  if (!isRole(role)) return { problem: 'Choose the access to give.', status: 400 }
  if (!grantableRoles(actor).includes(role)) return { problem: `Your role can't give ${ROLE_LABELS[role]} access.`, status: 403 }
  const grants: GrantInput[] = []
  for (const app of config.apps) {
    const grant = parseGrant(app, field(form, grantField(app)), customRoles)
    if (grant === 'invalid') return { problem: `Choose a role for ${app.title}.`, status: 400 }
    if (grant) grants.push(grant)
  }
  if (role !== 'APPS') {
    if (grants.length) return { problem: 'To give access app by app, choose "Specific apps" as the access.', status: 400 }
    return { role, grants }
  }
  if (!grants.length) return { problem: 'Choose at least one app, or give an organization role instead.', status: 400 }
  return { role, grants }
}

function titleOf(config: Config, name: string): string {
  return config.apps.find((app) => app.name === name)?.title ?? name
}

/** Short, for tables: "Owner", or "Cap Table: Editor · Ledger: Viewer". */
export function accessSummary(config: Config, role: Role, grants: readonly { app: string; role: GrantRole; custom_role_name: string | null }[]): string {
  if (role !== 'APPS') return ROLE_LABELS[role]
  if (!grants.length) return 'No apps'
  return grants.map((grant) => `${titleOf(config, grant.app)}: ${grantLabel(grant)}`).join(' · ')
}

/** In a sentence, after "join the organization": "as Admin", or "with access to Cap Table as Editor". */
export function accessPhrase(config: Config, role: Role, grants: readonly { app: string; role: GrantRole; custom_role_name: string | null }[]): string {
  if (role !== 'APPS') return `as ${ROLE_LABELS[role]}`
  const parts = grants.map((grant) => `${titleOf(config, grant.app)} as ${grantLabel(grant)}`)
  if (!parts.length) return 'with access to specific apps'
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `with access to ${list}`
}
