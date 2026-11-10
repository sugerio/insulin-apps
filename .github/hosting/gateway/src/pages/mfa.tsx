// Two-step sign-in pages: the code prompt after the first factor, and Account → Security, where it is turned on (with a
// QR code for the authenticator app) and off, and recovery codes are made.
import qrcode from "qrcode-generator"
import { ArrowLeft, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ErrorSummary, Notice, PostButton, TextField } from "@/components/forms"
import { AuthCard, Container, PageHeader, proseLinks } from "@/components/layout"
import type { Context } from "../context.ts"
import type { MembershipRow } from "../db/orgs.ts"
import type { Session } from "../auth/session.ts"
import { groupedSecret } from "../auth/totp.ts"
import type { Html } from "./html.ts"
import { accountOf, page } from "./document.tsx"

/** A QR code as SVG paths (one per dark module, four modules of quiet zone), dark on light in either theme. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const qr = qrcode(0, "M")
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const quiet = 4
  let d = ""
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`
    }
  }
  const size = count + quiet * 2
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="size-52 shrink-0 rounded-lg border bg-white text-black"
    >
      <path fill="currentColor" d={d} />
    </svg>
  )
}

export function mfaChallengePage(ctx: Context, state: { error?: string | null }): Html {
  return page(ctx, { title: "Two-step sign-in" }, (
    <AuthCard title="Two-step sign-in" description="Enter the 6-digit code from your authenticator app.">
      <ErrorSummary errors={[state.error]} />
      <form method="post" action="/login/mfa" className="flex flex-col gap-6">
        <TextField
          label="Code"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={40}
          hint="Lost your phone? Enter one of your recovery codes instead."
          error={state.error}
        />
        <Button type="submit" className="w-full">
          Continue
        </Button>
      </form>
      <p className={cn("text-sm text-muted-foreground", proseLinks)}>
        <a href="/login">Back to sign in</a>
      </p>
    </AuthCard>
  ))
}

/** No open challenge in this browser: it expired, was answered, or had too many wrong codes. */
export function mfaExpiredPage(ctx: Context, text = "This sign-in has expired or was already used. Sign in again to get a new code prompt."): Html {
  return page(ctx, { title: "Sign in again" }, (
    <AuthCard title="Sign in again" description={text}>
      <a className={cn(buttonVariants(), "w-full")} href="/login">
        Sign in
      </a>
    </AuthCard>
  ))
}

/** The secret can't be read (GATEWAY_SECRET_KEY missing or changed): app codes can't be checked, so nobody gets in with one. */
export function mfaUnavailablePage(ctx: Context): Html {
  return page(ctx, { title: "Codes can't be checked" }, (
    <AuthCard
      title="Codes can't be checked right now"
      description="This site can't check authenticator codes at the moment, so it can't sign you in with one. Use one of your recovery codes, or try again later."
    >
      <a className={cn(buttonVariants({ variant: "outline" }), "w-full")} href="/login/mfa">
        Enter a recovery code
      </a>
    </AuthCard>
  ))
}

export interface SecurityState {
  /** GATEWAY_SECRET_KEY is set: two-step sign-in can be turned on. */
  available: boolean
  /** Turning it on asks for the password; an account without one needs a recent sign-in instead. */
  needsPassword: boolean
  enabledAt: number | null
  /** A secret being set up: its key and otpauth URI, for the QR code. */
  setup: { secret: string; uri: string } | null
  recoveryLeft: number
  /** Recovery codes just made: shown this once. */
  newCodes?: string[] | null
  notice?: string | null
  errors?: { setup?: string | null; regenerate?: string | null; disable?: string | null; form?: string | null }
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en", { dateStyle: "medium", timeZone: "UTC" })
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle>
          <h2>Your recovery codes</h2>
        </CardTitle>
        <CardDescription>
          Save these now, somewhere safe and away from your phone: they&apos;re shown only this once. Each one signs you in a single time if
          you can&apos;t use your authenticator app. Making new ones replaces them all.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul aria-label="Recovery codes" className="grid gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm sm:grid-cols-2">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

export function securityPage(ctx: Context, session: Session, state: SecurityState, orgs?: readonly MembershipRow[]): Html {
  const errors = state.errors ?? {}
  const enabled = state.enabledAt !== null
  return page(ctx, { title: "Security", user: accountOf(session, orgs) }, (
    <Container width="prose" className="flex flex-col gap-6 py-10 sm:py-12">
      <a
        href="/account"
        className="-mb-2 inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeft className="size-4" />
        Account
      </a>
      <PageHeader
        title="Security"
        description={
          <>
            Two-step sign-in for <strong className="text-foreground">{session.user.email}</strong>.
          </>
        }
      />
      {state.notice ? <Notice kind="ok">{state.notice}</Notice> : null}
      <ErrorSummary errors={[errors.form, errors.setup, errors.regenerate, errors.disable]} />
      {state.newCodes?.length ? <RecoveryCodes codes={state.newCodes} /> : null}

      {enabled ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <h2>Two-step sign-in</h2>
                <Badge>
                  <ShieldCheck />
                  On
                </Badge>
              </CardTitle>
              <CardDescription>
                On since {formatDate(state.enabledAt!)}. Signing in with your password, Google or single sign-on also asks for a code from your
                authenticator app. You have {state.recoveryLeft === 1 ? "1 recovery code" : `${state.recoveryLeft} recovery codes`} left.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form method="post" action="/account/security/recovery-codes" className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <TextField
                    id="field-regenerate-code"
                    label="Code from your authenticator app"
                    name="code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={10}
                    hint="Making new recovery codes replaces the ones you have."
                    error={errors.regenerate}
                  />
                </div>
                <Button type="submit" variant="outline">
                  Make new recovery codes
                </Button>
              </form>
            </CardContent>
          </Card>
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">
                <h2>Turn off two-step sign-in</h2>
              </CardTitle>
              <CardDescription>Your password or Google alone will sign you in again, and your other sessions are signed out.</CardDescription>
            </CardHeader>
            <CardContent>
              <form method="post" action="/account/security/disable" className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <TextField
                    id="field-disable-code"
                    label="Code from your app, or a recovery code"
                    name="code"
                    autoComplete="one-time-code"
                    maxLength={40}
                    error={errors.disable}
                  />
                </div>
                <Button type="submit" variant="destructive">
                  Turn off
                </Button>
              </form>
            </CardContent>
          </Card>
        </>
      ) : state.setup ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Set up your authenticator app</h2>
            </CardTitle>
            <CardDescription>
              Scan the QR code with an authenticator app (such as Google Authenticator, Microsoft Authenticator, 1Password or Authy), or type
              the key into it. Then enter the 6-digit code it shows.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <QrCode text={state.setup.uri} label="QR code for your authenticator app" />
              <div className="flex min-w-0 flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">Key, if you can&apos;t scan the code</span>
                <code className="rounded-md bg-muted px-2 py-1 font-mono text-sm break-all">{groupedSecret(state.setup.secret)}</code>
                <span className="text-muted-foreground">Time-based, 6 digits, every 30 seconds.</span>
              </div>
            </div>
            <form method="post" action="/account/security/enable" className="flex flex-col gap-4">
              <TextField label="Code from your app" name="code" autoComplete="one-time-code" inputMode="numeric" maxLength={10} error={errors.setup} />
              {state.needsPassword ? (
                <TextField id="field-enable-password" label="Your password" name="password" type="password" autoComplete="current-password" maxLength={200} />
              ) : null}
              <div>
                <Button type="submit">Turn on</Button>
              </div>
            </form>
          </CardContent>
          <CardFooter>
            <PostButton action="/account/security/cancel" variant="ghost" size="sm">
              Cancel setup
            </PostButton>
          </CardFooter>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <h2>Two-step sign-in</h2>
              <Badge variant="outline">Off</Badge>
            </CardTitle>
            <CardDescription>
              {state.available
                ? "Protect your account with a code from an authenticator app on your phone, asked for after your password, Google or single sign-on."
                : "Two-step sign-in isn't available on this site right now."}
            </CardDescription>
          </CardHeader>
          {state.available ? (
            <CardFooter>
              <form method="post" action="/account/security/setup" className="flex w-full flex-col gap-4">
                {state.needsPassword ? (
                  <TextField id="field-setup-password" label="Your password" name="password" type="password" autoComplete="current-password" maxLength={200}
                    hint="To make sure it's you, not someone using a session left open." />
                ) : (
                  <p className="text-sm text-muted-foreground">Your account has no password, so this works within ten minutes of signing in.</p>
                )}
                <div>
                  <Button type="submit">Set up two-step sign-in</Button>
                </div>
              </form>
            </CardFooter>
          ) : null}
        </Card>
      )}
    </Container>
  ))
}
