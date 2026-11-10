// <app>.<domain>/settings/integrations (DESIGN.md §6): service accounts (API clients of the app) and stored credentials
// (secrets for outside services, used through the integration proxy). A secret appears once, right after it is made.
import { ChevronDown, KeyRound } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Notice, PostButton, SelectField, type Choice } from "@/components/forms"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { originOf } from "../context.ts"
import type { CustomRoleRow } from "../db/grants.ts"
import type { AuthScheme, IntegrationRow } from "../db/integrations.ts"
import type { ServiceAccountRow } from "../db/oauth.ts"
import type { MembershipRow } from "../db/orgs.ts"
import { grantChoices, grantLabel, grantValue } from "../orgs/access-forms.ts"
import type { Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { AppSettingsFrame, type AppFrame } from "./app-settings.tsx"
import { accountOf, page } from "./document.tsx"

const destructiveGhost = "text-destructive hover:bg-destructive/10 hover:text-destructive"
const disclosure = "inline-flex cursor-pointer items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"

export interface NewSecret {
  kind: "created" | "rotated"
  name: string
  clientId: string
  secret: string
}

export interface IntegrationsData extends AppFrame {
  accounts: ServiceAccountRow[]
  credentials: IntegrationRow[]
  /** This app's custom roles. */
  customRoles: CustomRoleRow[]
  /** GATEWAY_SECRET_KEY is set, so credentials can be stored. */
  sealing: boolean
  secret: NewSecret | null
}

const SCHEMES: Record<AuthScheme, string> = { bearer: "Bearer token", header: "Named header", basic: "Basic authentication" }
const SCHEME_CHOICES: Choice[] = (Object.keys(SCHEMES) as AuthScheme[]).map((scheme) => ({ value: scheme, label: SCHEMES[scheme] }))

function day(ms: number | null): string {
  return ms === null ? "Never" : new Date(ms).toISOString().slice(0, 10)
}

function hostsOf(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((host): host is string => typeof host === "string") : []
  } catch {
    return []
  }
}

/** A labelled input with its own id, for pages with several forms (TextField's ids follow the field name). */
function Field({ id, label, name, value, type = "text", required = true, hint, maxLength, autoComplete = "off" }: {
  id: string; label: string; name: string; value?: string | null; type?: "text" | "password" | "url"; required?: boolean; hint?: string; maxLength?: number; autoComplete?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} type={type} required={required} defaultValue={value ?? undefined} maxLength={maxLength} autoComplete={autoComplete}
        aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? <p id={`${id}-hint`} className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** The secret, once: how to use it, and that it won't be shown again. */
function SecretCard({ ctx, app, secret }: { ctx: Context; app: HostedApp; secret: NewSecret }) {
  const tokenUrl = `${originOf(ctx, ctx.config.domain)}/oauth/token`
  const api = `${originOf(ctx, app.host)}/api/`
  return (
    <Alert role="status">
      <KeyRound />
      <AlertTitle>{secret.kind === "created" ? `${secret.name} is ready` : `${secret.name} has a new secret`}: copy the secret now</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 text-card-foreground">
        <p>It isn&apos;t shown again. {secret.kind === "rotated" ? "The old secret and the tokens made with it stopped working." : ""}</p>
        <dl className="grid gap-2">
          <div>
            <dt className="text-muted-foreground">Client id</dt>
            <dd><code className="font-mono break-all select-all">{secret.clientId}</code></dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Client secret</dt>
            <dd><code className="font-mono break-all select-all">{secret.secret}</code></dd>
          </div>
        </dl>
        <p>Get a token (it lasts an hour), then call {app.title}&apos;s API with it:</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{`curl -u '${secret.clientId}:<secret>' -d grant_type=client_credentials ${tokenUrl}
curl -H 'Authorization: Bearer <access_token>' ${api}...`}</pre>
      </AlertDescription>
    </Alert>
  )
}

function AccountsCard({ data, app }: { data: IntegrationsData; app: HostedApp }) {
  const admin = data.access.admin
  const roles = grantChoices(app, data.customRoles, false)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Service accounts</h2>
        </CardTitle>
        <CardDescription>
          Programs that call {app.title}&apos;s API in {data.orgName}, each with a role here like a person&apos;s. They get tokens with their client id and
          secret; tokens reach only the app&apos;s API, never people, roles or integrations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.accounts.length ? (
          <Table>
            <TableCaption className="sr-only">Service accounts of {app.title}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Role</TableHead>
                <TableHead scope="col" className="max-md:hidden">Last used</TableHead>
                {admin ? <TableHead scope="col"><span className="sr-only">Actions</span></TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.accounts.map((account) => (
                <TableRow key={account.id}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="font-medium">{account.name}</div>
                    <code className="font-mono text-xs break-all text-muted-foreground">{account.client_id}</code>
                    <div className="text-xs text-muted-foreground">Created {day(account.created_at)}</div>
                    {admin ? (
                      <details className="group mt-2">
                        <summary className={disclosure}>
                          Edit<span className="sr-only"> {account.name}</span>
                          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                        </summary>
                        <form method="post" action={`/settings/integrations/service-accounts/${account.id}`} className="mt-3 flex flex-col gap-4">
                          <input type="hidden" name="org_id" defaultValue={data.orgId} />
                          <Field id={`account-${account.id}-name`} label="Name" name="name" value={account.name} maxLength={80} />
                          <SelectField id={`account-${account.id}-role`} label="Role" name="role" choices={roles} selected={grantValue(account)} />
                          <div>
                            <Button type="submit" variant="outline" size="sm">Save</Button>
                          </div>
                        </form>
                      </details>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top"><Badge variant="outline">{grantLabel(account)}</Badge></TableCell>
                  <TableCell className="align-top text-muted-foreground max-md:hidden">{day(account.last_used_at)}</TableCell>
                  {admin ? (
                    <TableCell className="align-top">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <PostButton action={`/settings/integrations/service-accounts/${account.id}/rotate`} fields={{ org_id: data.orgId }} variant="outline" size="sm">
                          New secret<span className="sr-only"> for {account.name}</span>
                        </PostButton>
                        <PostButton action={`/settings/integrations/service-accounts/${account.id}/delete`} fields={{ org_id: data.orgId }} variant="ghost" size="sm" className={destructiveGhost}>
                          Delete<span className="sr-only"> {account.name}</span>
                        </PostButton>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No service accounts yet.</p>
        )}
      </CardContent>
      {admin ? (
        <CardFooter className="flex-col items-stretch gap-4 border-t">
          <h3 className="text-sm font-semibold">New service account</h3>
          <form method="post" action="/settings/integrations/service-accounts" className="grid gap-4 sm:grid-cols-[1fr_13rem_auto] sm:items-end">
            <input type="hidden" name="org_id" defaultValue={data.orgId} />
            <Field id="new-account-name" label="Name" name="name" maxLength={80} />
            <SelectField id="new-account-role" label="Role" name="role" choices={roles} selected="VIEWER" />
            <Button type="submit">Create</Button>
          </form>
        </CardFooter>
      ) : null}
    </Card>
  )
}

/** The fields of a stored credential, empty for a new one. */
function CredentialFields({ idPrefix, credential }: { idPrefix: string; credential?: IntegrationRow }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-name`} label="Name" name="name" value={credential?.name} maxLength={80} />
        <Field id={`${idPrefix}-base`} label="Base URL" name="base_url" type="url" value={credential?.base_url} maxLength={500}
          hint="https only. The app's calls to this credential's key go here." />
      </div>
      <Field id={`${idPrefix}-hosts`} label="Other hosts (optional)" name="allowed_hosts" required={false} value={credential ? hostsOf(credential.allowed_hosts).join(", ") : ""}
        hint="Other host names the app may call with this credential, separated by commas." />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField id={`${idPrefix}-scheme`} label="Send the secret as" name="auth_scheme" choices={SCHEME_CHOICES} selected={credential?.auth_scheme ?? "bearer"} />
        <Field id={`${idPrefix}-header`} label="Header name (for a named header)" name="header_name" required={false} value={credential?.header_name} maxLength={64} />
      </div>
      <Field id={`${idPrefix}-secret`} label={credential ? "New secret (leave empty to keep the current one)" : "Secret"} name="secret" type="password"
        required={!credential} autoComplete="new-password" hint="For basic authentication, user:password. It's encrypted and never shown again." />
    </>
  )
}

function CredentialsCard({ data, app }: { data: IntegrationsData; app: HostedApp }) {
  const admin = data.access.admin
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Stored credentials</h2>
        </CardTitle>
        <CardDescription>
          Secrets for outside services that {app.title} calls by key, with <code className="font-mono">integrationFetch(key)</code>. Insulin Apps keeps each secret
          encrypted and adds it to the app&apos;s requests, so the app never sees it, and sends them only to the hosts listed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.credentials.length ? (
          <Table>
            <TableCaption className="sr-only">Stored credentials of {app.title}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Key</TableHead>
                <TableHead scope="col">Service</TableHead>
                <TableHead scope="col" className="max-md:hidden">Last used</TableHead>
                {admin ? <TableHead scope="col"><span className="sr-only">Actions</span></TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.credentials.map((credential) => {
                const hosts = hostsOf(credential.allowed_hosts)
                return (
                  <TableRow key={credential.id}>
                    <TableCell className="align-top whitespace-normal">
                      <code className="font-mono font-medium">{credential.key}</code>
                      <div className="text-xs text-muted-foreground">{credential.name}</div>
                      {admin && data.sealing ? (
                        <details className="group mt-2">
                          <summary className={disclosure}>
                            Edit<span className="sr-only"> {credential.key}</span>
                            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                          </summary>
                          <form method="post" action={`/settings/integrations/credentials/${credential.id}`} className="mt-3 flex flex-col gap-4">
                            <input type="hidden" name="org_id" defaultValue={data.orgId} />
                            <CredentialFields idPrefix={`credential-${credential.id}`} credential={credential} />
                            <div>
                              <Button type="submit" variant="outline" size="sm">Save</Button>
                            </div>
                          </form>
                        </details>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <div className="break-all">{credential.base_url}</div>
                      {hosts.length ? <div className="text-xs text-muted-foreground">Also: {hosts.join(", ")}</div> : null}
                      <div className="text-xs text-muted-foreground">
                        {SCHEMES[credential.auth_scheme]}{credential.header_name ? ` (${credential.header_name})` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="align-top text-muted-foreground max-md:hidden">{day(credential.last_used_at)}</TableCell>
                    {admin ? (
                      <TableCell className="text-right align-top">
                        <PostButton action={`/settings/integrations/credentials/${credential.id}/delete`} fields={{ org_id: data.orgId }} variant="ghost" size="sm" className={destructiveGhost}>
                          Delete<span className="sr-only"> {credential.key}</span>
                        </PostButton>
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No stored credentials yet.</p>
        )}
      </CardContent>
      {admin ? (
        <CardFooter className="flex-col items-stretch gap-4 border-t">
          <h3 className="text-sm font-semibold">New stored credential</h3>
          {data.sealing ? (
            <form method="post" action="/settings/integrations/credentials" className="flex flex-col gap-4">
              <input type="hidden" name="org_id" defaultValue={data.orgId} />
              <Field id="new-credential-key" label="Key" name="key" maxLength={40} hint={`The name ${app.title} uses for it: lower-case letters, digits, - and _.`} />
              <CredentialFields idPrefix="new-credential" />
              <div>
                <Button type="submit">Save credential</Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Stored credentials aren&apos;t set up on this site yet: the operator hasn&apos;t configured the key that encrypts them.
            </p>
          )}
        </CardFooter>
      ) : null}
    </Card>
  )
}

export function integrationsPage(ctx: Context, session: Session, app: HostedApp, data: IntegrationsData, orgs?: readonly MembershipRow[]): Html {
  return page(ctx, { title: `Integrations · ${app.title}`, user: accountOf(session, orgs) }, (
    <AppSettingsFrame ctx={ctx} app={app} data={data} tab="integrations">
      {data.secret ? <SecretCard ctx={ctx} app={app} secret={data.secret} /> : null}
      {data.access.admin ? null : (
        <Notice>Only {app.title}&apos;s admins add, change and delete integrations. You can see what is connected.</Notice>
      )}
      <AccountsCard data={data} app={app} />
      <CredentialsCard data={data} app={app} />
    </AppSettingsFrame>
  ))
}

