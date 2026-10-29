// The account page: change name, set or change the password, delete the account.
import { Fragment } from "react"
import { CircleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ErrorSummary, Notice, TextField } from "@/components/forms"
import { AuthCard, Container, PageHeader, proseLinks } from "@/components/layout"
import type { Context } from "../context.ts"
import { apexUrl } from "../context.ts"
import type { MembershipRow } from "../db/orgs.ts"
import type { Session } from "../auth/session.ts"
import { NAME_MAX, PASSWORD_MAX, PASSWORD_MIN } from "../validate.ts"
import type { Html } from "./html.ts"
import { accountOf, page } from "./document.tsx"

export interface AccountState {
  notice?: string | null
  errors?: { name?: string | null; current?: string | null; password?: string | null; delete?: string | null }
  blockingOrgs?: { id: string; name: string }[]
}

export function accountPage(ctx: Context, session: Session, state: AccountState = {}, orgs?: readonly MembershipRow[]): Html {
  const errors = state.errors ?? {}
  const user = session.user
  const blocking = state.blockingOrgs ?? []
  return page(ctx, { title: "Account", user: accountOf(session, orgs) }, (
    <Container width="prose" className="flex flex-col gap-6 py-10 sm:py-12">
      <PageHeader
        title="Account"
        description={
          <>
            Signed in as <strong className="text-foreground">{user.email}</strong>.
          </>
        }
      />
      {state.notice ? <Notice kind="ok">{state.notice}</Notice> : null}
      <ErrorSummary errors={[errors.name, errors.current, errors.password, errors.delete]} />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Name</h2>
          </CardTitle>
          <CardDescription>Shown to the other members of your organizations and in the apps.</CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" action="/account/name" className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <TextField label="Name" name="name" value={user.name} autoComplete="name" maxLength={NAME_MAX} error={errors.name} />
            </div>
            <Button type="submit" variant="outline">
              Save name
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{user.hasPassword ? "Change password" : "Set a password"}</h2>
          </CardTitle>
          {user.hasPassword ? null : (
            <CardDescription>You sign in with Google. Set a password to sign in with your email address as well.</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <form method="post" action="/account/password" className="flex flex-col gap-6">
            <input type="text" name="username" defaultValue={user.email} autoComplete="username" hidden />
            {user.hasPassword ? (
              <TextField
                label="Current password"
                name="current_password"
                type="password"
                autoComplete="current-password"
                maxLength={PASSWORD_MAX}
                error={errors.current}
              />
            ) : null}
            <TextField
              label="New password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              hint={`At least ${PASSWORD_MIN} characters. Saving it signs you out on your other devices.`}
              error={errors.password}
            />
            <div>
              <Button type="submit" variant="outline">
                Save password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">
            <h2>Delete account</h2>
          </CardTitle>
          <CardDescription className={proseLinks}>
            This deletes your account, signs you out everywhere, and deletes every organization where you are the only
            member. Apps keep the data they stored for those organizations, but nobody can reach it again. See the{" "}
            <a href={apexUrl(ctx, "/privacy")}>Privacy notice</a> for details.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {blocking.length ? (
            <Alert variant="destructive" className={cn("[&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4")}>
              <CircleAlert />
              <AlertDescription>
                <p>
                  You&apos;re the only owner of{" "}
                  {blocking.map((org, index) => (
                    <Fragment key={org.id}>
                      {index ? ", " : ""}
                      <a href={`/orgs/${org.id}`}>{org.name}</a>
                    </Fragment>
                  ))}
                  , which {blocking.length === 1 ? "has" : "have"} other members. Make another member an owner, or remove the other
                  members, first.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
          <form method="post" action="/account/delete" className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <TextField
                label="Type your email address to confirm"
                name="confirm"
                type="email"
                autoComplete="off"
                maxLength={254}
                error={errors.delete}
              />
            </div>
            <Button type="submit" variant="destructive">
              Delete my account
            </Button>
          </form>
        </CardContent>
      </Card>
    </Container>
  ))
}

export function accountDeletedPage(ctx: Context): Html {
  return page(ctx, { title: "Account deleted", user: null }, (
    <AuthCard title="Your account was deleted" description="Thank you for using Insulin Apps.">
      <a className={cn(buttonVariants({ variant: "outline" }), "w-full")} href={apexUrl(ctx)}>
        See all apps
      </a>
    </AuthCard>
  ))
}
