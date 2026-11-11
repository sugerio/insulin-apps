// /apps/<app>/settings/api on the apex (DESIGN.md §5.3): the app's OAuth clients (client credentials, stored as service
// accounts), how a program gets a token and calls the API, and, for the organization's owners and admins, creating,
// changing, rotating and deleting clients. A secret appears once, right after it is made; the list never shows one.
import { ChevronDown, KeyRound } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Notice, PostButton, SelectField, TextField } from "@/components/forms"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { appSettingsPath, originOf } from "../context.ts"
import type { CustomRoleRow } from "../db/grants.ts"
import type { ServiceAccountRow } from "../db/oauth.ts"
import type { MembershipRow } from "../db/orgs.ts"
import { grantChoices, grantLabel, grantValue } from "../orgs/access-forms.ts"
import type { Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { AppSettingsFrame, appSettingsShell, type AppFrame } from "./app-settings.tsx"
import { page } from "./document.tsx"

const destructiveGhost = "text-destructive hover:bg-destructive/10 hover:text-destructive"
const disclosure = "inline-flex cursor-pointer items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
const codeBlock = "overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs select-all"

export interface NewSecret {
  kind: "created" | "rotated"
  name: string
  clientId: string
  secret: string
  /** After a rotation: until when the previous secret keeps working. */
  previousExpiresAt: number | null
  /** The rotation pushed out a previous secret that was still valid. */
  replacedPrevious: boolean
}

export interface ApiAccessData extends AppFrame {
  /** An OWNER or ADMIN of the organization: may create, change, rotate and delete clients. */
  manage: boolean
  clients: ServiceAccountRow[]
  /** This app's custom roles. */
  customRoles: CustomRoleRow[]
  secret: NewSecret | null
}

function day(ms: number | null): string {
  return ms === null ? "Never" : new Date(ms).toISOString().slice(0, 10)
}

function moment(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`
}

function hasPrevious(ctx: Context, client: ServiceAccountRow): boolean {
  return client.previous_secret_hash !== null && (client.previous_secret_expires_at ?? 0) > ctx.now
}

/** The token endpoint and the app's API, as a program reaches them. */
function endpoints(ctx: Context, app: HostedApp) {
  return { tokenUrl: `${originOf(ctx, ctx.config.domain)}/oauth/token`, resource: originOf(ctx, app.host) }
}

/** The two requests a program makes: a token, then the API with it. */
function curlExample(ctx: Context, app: HostedApp, clientId = "<client_id>"): string {
  const { tokenUrl, resource } = endpoints(ctx, app)
  return `# 1. Get an access token (it lasts an hour)
curl -s -u '${clientId}:<client_secret>' \\
  -d grant_type=client_credentials \\
  -d resource=${resource} \\
  ${tokenUrl}

# 2. Call ${app.title}'s API with it
curl -s -H 'Authorization: Bearer <access_token>' \\
  ${resource}/api/catalog`
}

/** The secret, once: how to use it, and that it won't be shown again. */
function SecretCard({ ctx, app, secret }: { ctx: Context; app: HostedApp; secret: NewSecret }) {
  return (
    <Alert role="status">
      <KeyRound />
      <AlertTitle>{secret.kind === "created" ? `${secret.name} is ready` : `${secret.name} has a new secret`}: copy the secret now</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 text-card-foreground">
        <p>It isn&apos;t shown again.</p>
        {secret.kind === "rotated" && secret.previousExpiresAt !== null ? (
          <p>
            The previous secret keeps working until {moment(secret.previousExpiresAt)}, so a running program can switch over, and tokens already issued
            keep working until they expire, within the hour. To end the previous secret sooner, use Revoke previous secret now.
            {secret.replacedPrevious ? " The secret before it stopped working now, with its tokens: at most two secrets work at a time." : ""}
          </p>
        ) : null}
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
        <pre className={codeBlock}><code>{curlExample(ctx, app, secret.clientId)}</code></pre>
      </AlertDescription>
    </Alert>
  )
}

/** How a program gets a token and calls the API. */
function UsageCard({ ctx, app }: { ctx: Context; app: HostedApp }) {
  const { tokenUrl, resource } = endpoints(ctx, app)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Calling {app.title}&apos;s API</h2>
        </CardTitle>
        <CardDescription>
          A program gets an access token with its client id and secret (OAuth client credentials), then sends it with each request to{" "}
          {app.title}&apos;s API. Tokens last an hour and reach only the app&apos;s API, never people, roles or integrations.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Token URL</dt>
          <dd><code className="font-mono break-all select-all">{tokenUrl}</code></dd>
          <dt className="text-muted-foreground">Grant type</dt>
          <dd><code className="font-mono">grant_type=client_credentials</code>, with the client id and secret as HTTP Basic authentication</dd>
          <dt className="text-muted-foreground">Resource</dt>
          <dd><code className="font-mono break-all select-all">resource={resource}</code></dd>
        </dl>
        <pre className={codeBlock}><code>{curlExample(ctx, app)}</code></pre>
        <p className="text-muted-foreground">
          <code className="font-mono">/api/catalog</code> lists the endpoints the client&apos;s role may use, where {app.title} publishes one.
        </p>
      </CardContent>
    </Card>
  )
}

function SecretStatus({ ctx, app, data, client }: { ctx: Context; app: HostedApp; data: ApiAccessData; client: ServiceAccountRow }) {
  const previous = hasPrevious(ctx, client)
  return (
    <div className="flex flex-col gap-2">
      <div>{client.secret_rotated_at === null ? "Not rotated" : `Rotated ${day(client.secret_rotated_at)}`}</div>
      {previous ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-muted-foreground">The previous secret works until {moment(client.previous_secret_expires_at!)}.</p>
          {data.manage ? (
            <PostButton action={appSettingsPath(app, "api", `/clients/${client.id}/revoke-previous`)} fields={{ org_id: data.orgId }} variant="outline" size="sm">
              Revoke previous secret now<span className="sr-only"> for {client.name}</span>
            </PostButton>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ClientsCard({ ctx, app, data }: { ctx: Context; app: HostedApp; data: ApiAccessData }) {
  const roles = grantChoices(app, data.customRoles, false)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>OAuth clients</h2>
        </CardTitle>
        <CardDescription>
          Programs that call {app.title}&apos;s API in {data.orgName}, each with a role here like a person&apos;s. Rotate secret makes a new secret and keeps
          the previous one working for 24 hours, so a running program can switch over; Delete ends a client and its tokens at once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.clients.length ? (
          <Table>
            <TableCaption className="sr-only">OAuth clients of {app.title}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Role</TableHead>
                <TableHead scope="col" className="max-md:hidden">Last used</TableHead>
                <TableHead scope="col">Secret</TableHead>
                {data.manage ? <TableHead scope="col"><span className="sr-only">Actions</span></TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.clients.map((client) => (
                <TableRow key={client.id}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="font-medium">{client.name}</div>
                    <code className="font-mono text-xs break-all text-muted-foreground select-all">{client.client_id}</code>
                    <div className="text-xs text-muted-foreground">Created {day(client.created_at)}</div>
                    {data.manage ? (
                      <details className="group mt-2">
                        <summary className={disclosure}>
                          Edit<span className="sr-only"> {client.name}</span>
                          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                        </summary>
                        <form method="post" action={appSettingsPath(app, "api", `/clients/${client.id}`)} className="mt-3 flex flex-col gap-4">
                          <input type="hidden" name="org_id" defaultValue={data.orgId} />
                          <TextField id={`client-${client.id}-name`} label="Name" name="name" value={client.name} maxLength={80} autoComplete="off" />
                          <SelectField id={`client-${client.id}-role`} label="Role" name="role" choices={roles} selected={grantValue(client)} />
                          <div>
                            <Button type="submit" variant="outline" size="sm">Save</Button>
                          </div>
                        </form>
                      </details>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top"><Badge variant="outline">{grantLabel(client)}</Badge></TableCell>
                  <TableCell className="align-top text-muted-foreground max-md:hidden">{day(client.last_used_at)}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <SecretStatus ctx={ctx} app={app} data={data} client={client} />
                  </TableCell>
                  {data.manage ? (
                    <TableCell className="align-top">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <PostButton action={appSettingsPath(app, "api", `/clients/${client.id}/rotate`)} fields={{ org_id: data.orgId }} variant="outline" size="sm">
                          Rotate secret<span className="sr-only"> for {client.name}</span>
                        </PostButton>
                        <PostButton action={appSettingsPath(app, "api", `/clients/${client.id}/delete`)} fields={{ org_id: data.orgId }} variant="ghost" size="sm" className={destructiveGhost}>
                          Delete<span className="sr-only"> {client.name}</span>
                        </PostButton>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No OAuth clients yet.</p>
        )}
      </CardContent>
      {data.manage ? (
        <CardFooter className="flex-col items-stretch gap-4 border-t">
          <h3 className="text-sm font-semibold">New OAuth client</h3>
          <form method="post" action={appSettingsPath(app, "api", "/clients")} className="grid gap-4 sm:grid-cols-[1fr_13rem_auto] sm:items-end">
            <input type="hidden" name="org_id" defaultValue={data.orgId} />
            <TextField id="new-client-name" label="Name" name="name" maxLength={80} autoComplete="off" />
            <SelectField id="new-client-role" label="Role" name="role" choices={roles} selected="VIEWER" />
            <Button type="submit">Create</Button>
          </form>
        </CardFooter>
      ) : null}
    </Card>
  )
}

export function apiAccessPage(ctx: Context, session: Session, app: HostedApp, data: ApiAccessData, orgs: readonly MembershipRow[]): Html {
  return page(ctx, { title: `API access · ${app.title}`, shell: appSettingsShell(ctx, session, app, data, orgs, "api") }, (
    <AppSettingsFrame ctx={ctx} app={app} data={data}>
      {data.secret ? <SecretCard ctx={ctx} app={app} secret={data.secret} /> : null}
      {data.manage ? null : (
        <Notice>Only the owners and admins of {data.orgName} create, change, rotate and delete OAuth clients. You can see which exist.</Notice>
      )}
      <ClientsCard ctx={ctx} app={app} data={data} />
      <UsageCard ctx={ctx} app={app} />
    </AppSettingsFrame>
  ))
}
