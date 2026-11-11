// /apps/<app>/settings/integrations on the apex (DESIGN.md §6): stored credentials (secrets for outside services, used
// through the integration proxy), which the app's admins manage. The app's OAuth clients for API access have their own
// tab (api-access.tsx). A secret is never shown again.
import { ArrowRight, ChevronDown } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Notice, PostButton, SelectField, type Choice } from "@/components/forms"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { appSettingsPath } from "../context.ts"
import type { AuthScheme, IntegrationRow } from "../db/integrations.ts"
import type { MembershipRow } from "../db/orgs.ts"
import type { Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { AppSettingsFrame, type AppFrame } from "./app-settings.tsx"
import { accountOf, page } from "./document.tsx"

const destructiveGhost = "text-destructive hover:bg-destructive/10 hover:text-destructive"
const disclosure = "inline-flex cursor-pointer items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"

export interface IntegrationsData extends AppFrame {
  credentials: IntegrationRow[]
  /** GATEWAY_SECRET_KEY is set, so credentials can be stored. */
  sealing: boolean
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

/** Where the app's API clients went: their own tab, managed by the organization's owners and admins. */
function ApiClientsCard({ app }: { app: HostedApp }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>API clients</h2>
        </CardTitle>
        <CardDescription>
          Programs that call {app.title}&apos;s API use OAuth clients (client credentials). They are under API access, where the organization&apos;s
          owners and admins manage them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <a className={buttonVariants({ variant: "outline" })} href={appSettingsPath(app, "api")}>
          API access
          <ArrowRight />
        </a>
      </CardContent>
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
                          <form method="post" action={appSettingsPath(app, "integrations", `/credentials/${credential.id}`)} className="mt-3 flex flex-col gap-4">
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
                        <PostButton action={appSettingsPath(app, "integrations", `/credentials/${credential.id}/delete`)} fields={{ org_id: data.orgId }} variant="ghost" size="sm" className={destructiveGhost}>
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
            <form method="post" action={appSettingsPath(app, "integrations", "/credentials")} className="flex flex-col gap-4">
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
      {data.access.admin ? null : (
        <Notice>Only {app.title}&apos;s admins add, change and delete stored credentials. You can see what is connected.</Notice>
      )}
      <CredentialsCard data={data} app={app} />
      <ApiClientsCard app={app} />
    </AppSettingsFrame>
  ))
}
