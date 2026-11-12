// /settings/oauth-clients (DESIGN.md §5.4): every OAuth client of the organization in one table, for its owners and
// admins: each app's clients for API access and everyone's AI agents, with who created each, when, when it was last
// used, and Revoke and Delete. No secret appears here, and none is rotated: that is the app's API access page.
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PostButton } from "@/components/forms"
import { proseLinks } from "@/components/layout"
import type { Context } from "../context.ts"
import { appSettingsPath } from "../context.ts"
import type { OrgGrantRow, OrgServiceAccountRow } from "../db/oauth.ts"
import { orgShell, type ShellData } from "../navigation.ts"
import { grantLabel } from "../orgs/access-forms.ts"
import type { Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { page } from "./document.tsx"
import { SettingsFrame, type OrgFrame } from "./settings.tsx"

const destructiveGhost = "text-destructive hover:bg-destructive/10 hover:text-destructive"

export interface OAuthClientsData extends OrgFrame {
  clients: OrgServiceAccountRow[]
  agents: OrgGrantRow[]
}

function day(ms: number | null): string {
  return ms === null ? "Never" : new Date(ms).toISOString().slice(0, 10)
}

/** A person as the list names them; a creator whose account is gone is said so. */
function person(name: string | null, email: string | null): string {
  if (!email) return "A deleted account"
  return name && name !== email ? `${name} (${email})` : email
}

/** One row of the table: an app's client for API access, or a person's AI agent. */
interface Row {
  key: string
  kind: "api" | "agent"
  id: string
  name: string
  detail: string
  app: string
  createdBy: string
  createdAt: number
  lastUsedAt: number | null
  revoked: { at: number; by: string } | null
  expiresAt: number | null
}

function rows(ctx: Context, data: OAuthClientsData): Row[] {
  const title = (name: string) => ctx.config.apps.find((app) => app.name === name)?.title ?? name
  const clients: Row[] = data.clients.map((client) => ({
    key: `api-${client.id}`, kind: "api", id: client.id, name: client.name, detail: client.client_id, app: `${title(client.app)} · ${grantLabel(client)}`,
    createdBy: person(client.created_by_name, client.created_by_email), createdAt: client.created_at, lastUsedAt: client.last_used_at,
    revoked: client.revoked_at === null ? null : { at: client.revoked_at, by: person(client.revoked_by_name, client.revoked_by_email) }, expiresAt: null,
  }))
  const agents: Row[] = data.agents.map((agent) => ({
    key: `agent-${agent.id}`, kind: "agent", id: agent.id, name: agent.client_name, detail: "Acts as the person who connected it", app: title(agent.app),
    createdBy: person(agent.user_name, agent.user_email), createdAt: agent.created_at, lastUsedAt: agent.last_used_at,
    revoked: agent.revoked_at === null ? null : { at: agent.revoked_at, by: person(agent.revoked_by_name, agent.revoked_by_email) }, expiresAt: agent.expires_at,
  }))
  return [...clients, ...agents].sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))
}

function Status({ row }: { row: Row }) {
  if (row.revoked) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Badge variant="destructive">Revoked</Badge>
        <span className="text-xs text-muted-foreground">{day(row.revoked.at)} by {row.revoked.by}</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="secondary">Active</Badge>
      {row.expiresAt !== null ? <span className="text-xs text-muted-foreground">Until {day(row.expiresAt)}</span> : null}
    </div>
  )
}

function ClientsTable({ ctx, data }: { ctx: Context; data: OAuthClientsData }) {
  const all = rows(ctx, data)
  if (!all.length) {
    return <p className="text-sm text-muted-foreground">No OAuth clients yet. They appear here when someone creates one on an app&apos;s API access page or connects an AI agent.</p>
  }
  return (
    <Table>
      <TableCaption className="sr-only">OAuth clients of {data.orgName}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Client</TableHead>
          <TableHead scope="col">Type</TableHead>
          <TableHead scope="col" className="max-md:hidden">Created by</TableHead>
          <TableHead scope="col" className="max-md:hidden">Last used</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {all.map((row) => {
          const base = `/orgs/${data.orgId}/oauth-clients/${row.kind === "api" ? "api" : "agents"}/${row.id}`
          return (
            <TableRow key={row.key}>
              <TableCell className="align-top whitespace-normal">
                <div className="font-medium break-words">{row.name}</div>
                {row.kind === "api"
                  ? <code className="font-mono text-xs break-all text-muted-foreground">{row.detail}</code>
                  : <div className="text-xs text-muted-foreground">{row.detail}</div>}
                <div className="text-xs text-muted-foreground">{row.app} · created {day(row.createdAt)}</div>
                <div className="text-xs text-muted-foreground md:hidden">By {row.createdBy} · last used {day(row.lastUsedAt)}</div>
              </TableCell>
              <TableCell className="align-top">
                <Badge variant="outline">{row.kind === "api" ? "API access" : "AI agent (MCP)"}</Badge>
              </TableCell>
              <TableCell className="align-top whitespace-normal break-words text-muted-foreground max-md:hidden">{row.createdBy}</TableCell>
              <TableCell className="align-top text-muted-foreground max-md:hidden">{day(row.lastUsedAt)}</TableCell>
              <TableCell className="align-top whitespace-normal"><Status row={row} /></TableCell>
              <TableCell className="align-top">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {row.revoked ? null : (
                    <PostButton action={`${base}/revoke`} variant="outline" size="sm">
                      Revoke<span className="sr-only"> {row.name}</span>
                    </PostButton>
                  )}
                  <PostButton action={`${base}/delete`} variant="ghost" size="sm" className={destructiveGhost}>
                    Delete<span className="sr-only"> {row.name}</span>
                  </PostButton>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export function oauthClientsPage(ctx: Context, session: Session, data: OAuthClientsData, shell: ShellData): Html {
  return page(ctx, { title: `OAuth clients · ${data.orgName}`, shell: orgShell(ctx, session, shell, "oauth-clients") }, (
    <SettingsFrame ctx={ctx} data={data}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>OAuth clients</h2>
          </CardTitle>
          <CardDescription>
            Every app&apos;s clients for API access and everyone&apos;s AI agents in {data.orgName}. Revoke ends a client&apos;s access at once and keeps it
            listed, marked revoked; Delete takes it off the list. A revoked AI agent stays listed until it would have expired, or its person leaves.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ClientsTable ctx={ctx} data={data} />
          <p className={`text-sm text-muted-foreground ${proseLinks}`}>
            Secrets aren&apos;t shown here. A client&apos;s secret is shown once, when it is created or rotated on its app&apos;s API access page:{" "}
            {ctx.config.apps.map((app, index) => (
              <span key={app.name}>
                {index ? ", " : ""}
                <a href={appSettingsPath(app, "api")}>{app.title}</a>
              </span>
            ))}
            .
          </p>
        </CardContent>
      </Card>
    </SettingsFrame>
  ))
}
