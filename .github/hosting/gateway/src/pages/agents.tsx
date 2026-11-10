// Account → AI agents: the MCP clients the person connected, each to one app in one organization.
import { ArrowLeft } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Notice, PostButton } from "@/components/forms"
import { Container, PageHeader } from "@/components/layout"
import type { Context } from "../context.ts"
import { appUrl } from "../context.ts"
import type { UserGrantRow } from "../db/oauth.ts"
import type { MembershipRow } from "../db/orgs.ts"
import type { Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { accountOf, page } from "./document.tsx"

function day(ms: number | null): string {
  return ms === null ? "Not yet" : new Date(ms).toISOString().slice(0, 10)
}

export function agentsPage(ctx: Context, session: Session, grants: UserGrantRow[], notice: string | null, orgs?: readonly MembershipRow[]): Html {
  const example = ctx.config.apps[0]
  return page(ctx, { title: "AI agents", user: accountOf(session, orgs) }, (
    <Container width="prose" className="flex flex-col gap-6 py-10 sm:py-12">
      <a
        href="/account"
        className="-mb-2 inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeft className="size-4" />
        Account
      </a>
      <PageHeader
        title="AI agents"
        description="Claude, Codex, Gemini, opencode and other MCP clients you connected. Each one uses one app in one organization as you, with your role there, for 30 days."
      />
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Connected agents</h2>
          </CardTitle>
          <CardDescription>{grants.length ? "Disconnect one to stop it at once." : "You haven't connected an agent yet."}</CardDescription>
        </CardHeader>
        {grants.length ? (
          <CardContent>
            <Table>
              <TableCaption className="sr-only">Your connected AI agents</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Agent</TableHead>
                  <TableHead scope="col">App</TableHead>
                  <TableHead scope="col" className="max-sm:hidden">Last used</TableHead>
                  <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((grant) => {
                  const app = ctx.config.apps.find((candidate) => candidate.name === grant.app)
                  return (
                    <TableRow key={grant.id}>
                      <TableCell className="whitespace-normal">
                        <div className="font-medium">{grant.client_name}</div>
                        <div className="text-xs text-muted-foreground">Connected {day(grant.created_at)}, until {day(grant.expires_at)}</div>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <div>{app?.title ?? grant.app}</div>
                        <div className="text-xs text-muted-foreground">{grant.org_name}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground max-sm:hidden">{day(grant.last_used_at)}</TableCell>
                      <TableCell className="text-right">
                        <PostButton action={`/account/agents/${grant.id}/disconnect`} variant="outline" size="sm">
                          Disconnect<span className="sr-only"> {grant.client_name}</span>
                        </PostButton>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        ) : null}
      </Card>
      {example ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Connect an agent</h2>
            </CardTitle>
            <CardDescription>
              Each app has its own MCP server. Add it to your agent; the agent opens this site to sign you in and asks you to allow it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{`claude mcp add --transport http ${example.name} ${appUrl(ctx, example, "/mcp")}
codex mcp add ${example.name} --url ${appUrl(ctx, example, "/mcp")}`}</pre>
            <p className="text-muted-foreground">
              Other apps work the same way, at <code className="font-mono">/mcp</code> on their own address.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </Container>
  ))
}
