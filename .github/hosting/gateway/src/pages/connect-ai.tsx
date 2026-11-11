// /apps/<app>/settings/connect-ai on the apex (DESIGN.md §5.2): the app's MCP server, copy-ready setup for each AI
// client, the person's own agents for this app in the organization, and, for the organization's owners and admins,
// everyone's. No script runs here, so commands are selectable blocks rather than copy buttons.
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PostButton } from "@/components/forms"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { appSettingsPath, appUrl } from "../context.ts"
import type { AppGrantRow, GrantRow } from "../db/oauth.ts"
import type { MembershipRow } from "../db/orgs.ts"
import type { Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { AppSettingsFrame, type AppFrame } from "./app-settings.tsx"
import { accountOf, page } from "./document.tsx"

const codeBlock = "overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs select-all"

export interface ConnectAiData extends AppFrame {
  /** The person's own live agents for this app in the organization. */
  own: GrantRow[]
  /** Everyone's, for an OWNER or ADMIN of the organization; null for anyone else. */
  everyone: AppGrantRow[] | null
}

function day(ms: number | null): string {
  return ms === null ? "Not yet" : new Date(ms).toISOString().slice(0, 10)
}

/** A command or address to copy: a selectable block, named by the heading of its card. */
function Code({ children }: { children: string }) {
  return (
    <pre className={codeBlock}>
      <code>{children}</code>
    </pre>
  )
}

function ClientCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">{children}</CardContent>
    </Card>
  )
}

/**
 * Setup for each client. Checked against each tool's own documentation and `--help` (November 2026): Claude Code
 * (`claude mcp add --transport http`, then /mcp), Codex CLI (`codex mcp add --url`, `codex mcp login`), Gemini CLI
 * (`gemini mcp add --transport http`, then /mcp auth), opencode (`opencode mcp add --url`, `opencode mcp auth`), and the
 * custom connectors of Claude.ai and ChatGPT, which take the address.
 */
function ClientSetup({ app, url, domain }: { app: HostedApp; url: string; domain: string }) {
  const name = app.name
  const muted = "text-muted-foreground"
  return (
    <section aria-labelledby="clients-heading" className="flex flex-col gap-4">
      <h2 id="clients-heading" className="text-lg font-semibold">Set up your AI client</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <ClientCard title="Claude Code">
          <Code>{`claude mcp add --transport http ${name} ${url}`}</Code>
          <p className={muted}>
            Then run <code className="font-mono">/mcp</code> in Claude Code, choose <code className="font-mono">{name}</code> and sign in in the browser
            window it opens. Add <code className="font-mono">--scope user</code> to the command to have it in every project.
          </p>
        </ClientCard>
        <ClientCard title="Codex CLI">
          <Code>{`codex mcp add ${name} --url ${url}\ncodex mcp login ${name}`}</Code>
          <p className={muted}>The second command opens {domain} in your browser to sign in and allow it.</p>
        </ClientCard>
        <ClientCard title="Gemini CLI">
          <Code>{`gemini mcp add --transport http ${name} ${url}`}</Code>
          <p className={muted}>
            Then run <code className="font-mono">/mcp auth {name}</code> in Gemini CLI to sign in. The command adds it to the current project; add{" "}
            <code className="font-mono">--scope user</code> for every project.
          </p>
        </ClientCard>
        <ClientCard title="opencode">
          <Code>{`opencode mcp add ${name} --url ${url}\nopencode mcp auth ${name}`}</Code>
          <p className={muted}>The second command opens {domain} in your browser to sign in and allow it.</p>
        </ClientCard>
        <ClientCard title="Claude.ai and ChatGPT">
          <Code>{url}</Code>
          <p className={muted}>
            Claude.ai: Customize → Connectors → Add → Add custom connector; paste the address and connect. On Team and Enterprise plans an owner adds
            it under Organization settings → Connectors, and members then connect it.
          </p>
          <p className={muted}>
            ChatGPT: where your plan or workspace allows custom MCP servers (Plugins → Add custom MCP server), paste the address and choose OAuth to
            sign in.
          </p>
        </ClientCard>
      </div>
      <p className="text-sm text-muted-foreground">
        Any other MCP client works the same way: Streamable HTTP at the address above, with OAuth sign-in. Its sign-in has to return to the same computer
        (<code className="font-mono">http://localhost</code> or <code className="font-mono">127.0.0.1</code>), or to Claude.ai or ChatGPT.
      </p>
    </section>
  )
}

function ServerCard({ app, data, url, domain }: { app: HostedApp; data: ConnectAiData; url: string; domain: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{app.title}&apos;s MCP server</h2>
        </CardTitle>
        <CardDescription>Add this address to Claude, Codex, Gemini, opencode, ChatGPT or another AI agent that speaks MCP.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <Code>{url}</Code>
        <p>
          The first time the agent connects, it opens {domain} in your browser: you sign in, choose the organization, and allow it. It then acts
          as you in {app.title}, with your current role in that organization, for 30 days or until you disconnect it. In {data.orgName} your role is{" "}
          <Badge variant="outline">{data.access.label}</Badge>, so that is what the agent may do there.
        </p>
        <p className="text-muted-foreground">
          If your role changes, the agent&apos;s changes with it, and if you lose access, so does the agent. It uses {app.title}&apos;s own API only: it
          can&apos;t change people, roles, integrations or API access.
        </p>
      </CardContent>
    </Card>
  )
}

function OwnAgents({ app, data }: { app: HostedApp; data: ConnectAiData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Your agents</h2>
        </CardTitle>
        <CardDescription>
          {data.own.length
            ? `The agents you connected to ${app.title} in ${data.orgName}. Disconnect ends the agent's access at once.`
            : `You haven't connected an agent to ${app.title} in ${data.orgName} yet.`}{" "}
          Your agents for every app and organization are under <a className="underline underline-offset-4 hover:text-foreground" href="/account/agents">Account → AI agents</a>.
        </CardDescription>
      </CardHeader>
      {data.own.length ? (
        <CardContent>
          <Table>
            <TableCaption className="sr-only">Your agents for {app.title} in {data.orgName}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Agent</TableHead>
                <TableHead scope="col" className="max-sm:hidden">Connected</TableHead>
                <TableHead scope="col">Last used</TableHead>
                <TableHead scope="col" className="max-sm:hidden">Expires</TableHead>
                <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.own.map((grant) => (
                <TableRow key={grant.id}>
                  <TableCell className="font-medium whitespace-normal">{grant.client_name}</TableCell>
                  <TableCell className="text-muted-foreground max-sm:hidden">{day(grant.created_at)}</TableCell>
                  <TableCell className="text-muted-foreground">{day(grant.last_used_at)}</TableCell>
                  <TableCell className="text-muted-foreground max-sm:hidden">{day(grant.expires_at)}</TableCell>
                  <TableCell className="text-right">
                    <PostButton action={appSettingsPath(app, "connect-ai", `/agents/${grant.id}/disconnect`)} fields={{ org_id: data.orgId }} variant="outline" size="sm">
                      Disconnect<span className="sr-only"> {grant.client_name}</span>
                    </PostButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      ) : null}
    </Card>
  )
}

function EveryonesAgents({ app, data, everyone, session }: { app: HostedApp; data: ConnectAiData; everyone: AppGrantRow[]; session: Session }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Everyone&apos;s agents</h2>
        </CardTitle>
        <CardDescription>
          {everyone.length
            ? `The agents people in ${data.orgName} connected to ${app.title}, with who connected each. As an owner or admin you can disconnect any of them. Disconnect ends the agent's access at once.`
            : `Nobody in ${data.orgName} has connected an agent to ${app.title}.`}
        </CardDescription>
      </CardHeader>
      {everyone.length ? (
        <CardContent>
          <Table>
            <TableCaption className="sr-only">Everyone&apos;s agents for {app.title} in {data.orgName}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Connected by</TableHead>
                <TableHead scope="col">Agent</TableHead>
                <TableHead scope="col" className="max-md:hidden">Connected</TableHead>
                <TableHead scope="col" className="max-sm:hidden">Last used</TableHead>
                <TableHead scope="col" className="max-md:hidden">Expires</TableHead>
                <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {everyone.map((grant) => (
                <TableRow key={grant.id}>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                      {grant.user_name}
                      {grant.user_id === session.user.id ? <Badge variant="secondary">You</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{grant.user_email}</div>
                  </TableCell>
                  <TableCell className="whitespace-normal">{grant.client_name}</TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">{day(grant.created_at)}</TableCell>
                  <TableCell className="text-muted-foreground max-sm:hidden">{day(grant.last_used_at)}</TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">{day(grant.expires_at)}</TableCell>
                  <TableCell className="text-right">
                    <PostButton action={appSettingsPath(app, "connect-ai", `/agents/${grant.id}/disconnect`)} fields={{ org_id: data.orgId }} variant="outline" size="sm">
                      Disconnect<span className="sr-only"> {grant.client_name} of {grant.user_name}</span>
                    </PostButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      ) : null}
    </Card>
  )
}

export function connectAiPage(ctx: Context, session: Session, app: HostedApp, data: ConnectAiData, orgs?: readonly MembershipRow[]): Html {
  const url = appUrl(ctx, app, "/mcp")
  return page(ctx, { title: `Connect AI · ${app.title}`, user: accountOf(session, orgs) }, (
    <AppSettingsFrame ctx={ctx} app={app} data={data} tab="connect-ai">
      <ServerCard app={app} data={data} url={url} domain={ctx.config.domain} />
      <ClientSetup app={app} url={url} domain={ctx.config.domain} />
      <OwnAgents app={app} data={data} />
      {data.everyone ? <EveryonesAgents app={app} data={data} everyone={data.everyone} session={session} /> : null}
    </AppSettingsFrame>
  ))
}
