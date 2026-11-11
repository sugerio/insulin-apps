// The pages of connecting an AI agent (DESIGN.md §5.2): the consent page, the step back to the agent, and the problems
// shown instead of sending the browser anywhere.
import { TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { SelectField } from "@/components/forms"
import { AuthCard } from "@/components/layout"
import type { Session } from "../auth/session.ts"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import type { MembershipRow } from "../db/orgs.ts"
import { htmlResponse } from "../http/response.ts"
import type { Html } from "./html.ts"
import { accountOf, page } from "./document.tsx"
import { messagePage } from "./status.tsx"

export interface ConsentData {
  requestToken: string
  clientName: string
  app: HostedApp
  redirectUri: string
  loopback: boolean
  orgs: { id: string; name: string; label: string }[]
  selected: string
}

/** Where the browser goes back to, as people read it: the host and port, or the whole address for a hosted connector. */
function destination(uri: string): string {
  const url = new URL(uri)
  return url.protocol === "http:" ? url.host : `${url.origin}${url.pathname}`
}

export function consentPage(ctx: Context, session: Session, data: ConsentData, orgs?: readonly MembershipRow[]): Html {
  return page(ctx, { title: `Connect ${data.clientName}`, user: accountOf(session, orgs) }, (
    <AuthCard
      title={`Allow ${data.clientName} to use ${data.app.title} as you?`}
      description={`It will read and change what you can in ${data.app.title}, with your role there, for 30 days or until you disconnect it under Account → AI agents or on ${data.app.title}'s Connect AI page.`}
    >
      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">App asking</dt>
          <dd className="font-medium">{data.clientName} <span className="font-normal text-muted-foreground">(the name it gave itself)</span></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Returns to</dt>
          <dd className="font-medium break-all">{destination(data.redirectUri)}</dd>
        </div>
      </dl>
      {data.loopback ? (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            It returns to a program on this computer. Any program running here could listen on that address, so allow it only if you just
            started connecting {data.clientName} yourself.
          </AlertDescription>
        </Alert>
      ) : null}
      <form method="post" action="/oauth/authorize/decision" className="flex flex-col gap-4">
        <input type="hidden" name="request" defaultValue={data.requestToken} />
        <SelectField
          label="Organization"
          name="org_id"
          choices={data.orgs.map((org) => ({ value: org.id, label: `${org.name} (${org.label})` }))}
          selected={data.selected}
          hint={`The agent works in this organization only, with your role in ${data.app.title} shown in brackets.`}
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" name="decision" value="allow" className="sm:flex-1">
            Allow
          </Button>
          <Button type="submit" name="decision" value="deny" variant="outline" className="sm:flex-1">
            Deny
          </Button>
        </div>
      </form>
    </AuthCard>
  ))
}

/**
 * Back to the agent with its code or error. A redirect after a form POST to another origin is blocked by the CSP's
 * `form-action 'self'`, so this is a page that continues with a meta refresh and a link.
 */
export function oauthContinuePage(ctx: Context, target: string, clientName: string): Response {
  return htmlResponse(page(ctx, { title: "Continue", refreshTo: target }, (
    <AuthCard title={`Back to ${clientName}`} description="If nothing happens, use the button. You can close this tab once the agent says it's connected.">
      <a className={cn(buttonVariants(), "w-full")} href={target}>
        Continue to {clientName}
      </a>
    </AuthCard>
  )))
}

export function oauthProblemPage(ctx: Context, status: number, title: string, text: string, session?: Session): Response {
  return messagePage(ctx, status, title, <p>{text}</p>, session ? { user: accountOf(session) } : {})
}
