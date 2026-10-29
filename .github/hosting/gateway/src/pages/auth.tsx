// Account pages on the auth host: sign-up, sign-in, e-mail confirmation, resend, forgotten and reset passwords.
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { FieldSeparator } from "@/components/ui/field"
import { GoogleMark } from "@/components/brand"
import { ErrorSummary, Hidden, Notice, TextField, TurnstileWidget } from "@/components/forms"
import { AuthCard, proseLinks } from "@/components/layout"
import type { Context } from "../context.ts"
import { apexUrl, withReturnTo } from "../context.ts"
import { PASSWORD_MAX, PASSWORD_MIN } from "../validate.ts"
import type { Html } from "./html.ts"
import { page } from "./document.tsx"

export interface FormState {
  values?: { name?: string; email?: string }
  errors?: { name?: string | null; email?: string | null; password?: string | null; form?: string | null }
  returnTo?: string | null
  notice?: string | null
}

function GoogleOption({ ctx, returnTo, label }: { ctx: Context; returnTo: string | null | undefined; label: string }) {
  if (!ctx.config.google) return null
  return (
    <>
      <a className={cn(buttonVariants({ variant: "outline" }), "w-full")} href={withReturnTo("/auth/google/start", returnTo ?? null)}>
        <GoogleMark />
        {label}
      </a>
      <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">or</FieldSeparator>
    </>
  )
}

function Agreement({ ctx }: { ctx: Context }) {
  return (
    <p className={cn("text-sm text-muted-foreground", proseLinks)}>
      By creating an account you agree to the <a href={apexUrl(ctx, "/terms")}>Terms of use</a> and acknowledge the <a href={apexUrl(ctx, "/privacy")}>Privacy notice</a>.
    </p>
  )
}

function allErrors(state: FormState): (string | null | undefined)[] {
  const errors = state.errors ?? {}
  return [errors.form, errors.name, errors.email, errors.password]
}

function BackToSignIn() {
  return (
    <p>
      <a href="/login">Back to sign in</a>
    </p>
  )
}

export function signupPage(ctx: Context, state: FormState = {}): Html {
  const errors = state.errors ?? {}
  return page(ctx, { title: "Create an account", turnstile: true }, (
    <AuthCard
      title="Create an account"
      description="One account for every app on Insulin Apps."
      below={
        <p>
          Already have an account? <a href={withReturnTo("/login", state.returnTo ?? null)}>Sign in</a>
        </p>
      }
    >
      <ErrorSummary errors={allErrors(state)} />
      <GoogleOption ctx={ctx} returnTo={state.returnTo} label="Continue with Google" />
      <form method="post" action="/signup" className="flex flex-col gap-6">
        <TextField label="Name" name="name" value={state.values?.name} autoComplete="name" maxLength={100} error={errors.name} />
        <TextField
          label="Email address"
          name="email"
          type="email"
          value={state.values?.email}
          autoComplete="email"
          maxLength={254}
          error={errors.email}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          hint={`At least ${PASSWORD_MIN} characters.`}
          error={errors.password}
        />
        <TurnstileWidget siteKey={ctx.config.turnstile.siteKey} action="signup" />
        <Hidden name="return_to" value={state.returnTo} />
        <Agreement ctx={ctx} />
        <Button type="submit" className="w-full">
          Create account
        </Button>
      </form>
    </AuthCard>
  ))
}

export function checkInboxPage(ctx: Context, email: string): Html {
  return page(ctx, { title: "Check your inbox" }, (
    <AuthCard title="Check your inbox">
      <Notice kind="ok">
        We&apos;ve sent an email to <strong>{email}</strong>. Open the link in it to continue.
      </Notice>
      <p className={cn("text-sm text-muted-foreground", proseLinks)}>
        It can take a few minutes to arrive. If it doesn&apos;t, check your spam folder, or{" "}
        <a href="/resend-verification">ask for a new confirmation link</a>.
      </p>
    </AuthCard>
  ))
}

export function loginPage(ctx: Context, state: FormState = {}): Html {
  const errors = state.errors ?? {}
  return page(ctx, { title: "Sign in", turnstile: true }, (
    <AuthCard
      title="Sign in"
      description="Welcome back to Insulin Apps."
      below={
        <>
          <p>
            New here? <a href={withReturnTo("/signup", state.returnTo ?? null)}>Create an account</a>
            {ctx.config.google ? ". Continuing with Google also creates an account if you don't have one" : ""}.
          </p>
          {ctx.config.google ? <Agreement ctx={ctx} /> : null}
        </>
      }
    >
      {state.notice ? <Notice kind="ok">{state.notice}</Notice> : null}
      <ErrorSummary errors={[errors.form, errors.email, errors.password]} />
      <GoogleOption ctx={ctx} returnTo={state.returnTo} label="Continue with Google" />
      <form method="post" action="/login" className="flex flex-col gap-6">
        <TextField
          label="Email address"
          name="email"
          type="email"
          value={state.values?.email}
          autoComplete="username"
          maxLength={254}
          error={errors.email}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={PASSWORD_MAX}
          error={errors.password}
          labelAside={
            <a className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href="/forgot-password">
              Forgot your password?
            </a>
          }
        />
        <TurnstileWidget siteKey={ctx.config.turnstile.siteKey} action="login" />
        <Hidden name="return_to" value={state.returnTo} />
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </AuthCard>
  ))
}

/** Correct password, unconfirmed address: say so (only the account's owner can see this) and offer a new link. */
export function confirmFirstPage(ctx: Context, email: string, state: FormState = {}): Html {
  return page(ctx, { title: "Confirm your email first", turnstile: true }, (
    <AuthCard
      title="Confirm your email first"
      description={
        <>
          Open the confirmation link we emailed to <strong>{email}</strong>. If you can&apos;t find it, we can send a new one.
        </>
      }
    >
      <ErrorSummary errors={[state.errors?.form]} />
      <form method="post" action="/resend-verification" className="flex flex-col gap-6">
        <Hidden name="email" value={email} />
        <TurnstileWidget siteKey={ctx.config.turnstile.siteKey} action="resend" />
        <Hidden name="return_to" value={state.returnTo} />
        <Button type="submit" className="w-full">
          Send a new link
        </Button>
      </form>
    </AuthCard>
  ))
}

export function verifyEmailPage(ctx: Context, token: string, email: string): Html {
  return page(ctx, { title: "Confirm your email" }, (
    <AuthCard
      title="Confirm your email"
      description={
        <>
          Confirm <strong>{email}</strong> to finish setting up your account. You&apos;ll be signed in.
        </>
      }
    >
      <form method="post" action="/verify-email">
        <Hidden name="token" value={token} />
        <Button type="submit" className="w-full">
          Confirm my email
        </Button>
      </form>
    </AuthCard>
  ))
}

export function linkInvalidPage(ctx: Context, kind: "verify" | "reset"): Html {
  return page(ctx, { title: "Link expired" }, (
    <AuthCard title="This link has expired or was already used" description="Links in our emails work once, for a limited time.">
      <div className="flex flex-col gap-2 sm:flex-row">
        <a className={cn(buttonVariants(), "sm:flex-1")} href={kind === "verify" ? "/resend-verification" : "/forgot-password"}>
          {kind === "verify" ? "Ask for a new confirmation link" : "Ask for a new reset link"}
        </a>
        <a className={cn(buttonVariants({ variant: "outline" }), "sm:flex-1")} href="/login">
          Sign in
        </a>
      </div>
    </AuthCard>
  ))
}

export function resendPage(ctx: Context, state: FormState & { done?: boolean } = {}): Html {
  if (state.done) {
    return page(ctx, { title: "Check your inbox" }, (
      <AuthCard title="Check your inbox" below={<BackToSignIn />}>
        <Notice kind="ok">If an account with that email address still needs confirming, we&apos;ve sent it a new link.</Notice>
      </AuthCard>
    ))
  }
  return page(ctx, { title: "Resend confirmation", turnstile: true }, (
    <AuthCard
      title="Get a new confirmation link"
      description="Enter the email address you signed up with."
      below={<BackToSignIn />}
    >
      <ErrorSummary errors={[state.errors?.form, state.errors?.email]} />
      <form method="post" action="/resend-verification" className="flex flex-col gap-6">
        <TextField
          label="Email address"
          name="email"
          type="email"
          value={state.values?.email}
          autoComplete="email"
          maxLength={254}
          error={state.errors?.email}
        />
        <TurnstileWidget siteKey={ctx.config.turnstile.siteKey} action="resend" />
        <Hidden name="return_to" value={state.returnTo} />
        <Button type="submit" className="w-full">
          Send link
        </Button>
      </form>
    </AuthCard>
  ))
}

export function forgotPage(ctx: Context, state: FormState & { done?: boolean } = {}): Html {
  if (state.done) {
    return page(ctx, { title: "Check your inbox" }, (
      <AuthCard title="Check your inbox" below={<BackToSignIn />}>
        <Notice kind="ok">
          If there is an account with that email address, we&apos;ve sent it a link to choose a new password. The link expires
          in 1 hour.
        </Notice>
      </AuthCard>
    ))
  }
  return page(ctx, { title: "Forgot your password", turnstile: true }, (
    <AuthCard
      title="Forgot your password?"
      description="Enter your email address and we'll send you a link to choose a new password. This also works if you've only signed in with Google so far."
      below={<BackToSignIn />}
    >
      <ErrorSummary errors={[state.errors?.form, state.errors?.email]} />
      <form method="post" action="/forgot-password" className="flex flex-col gap-6">
        <TextField
          label="Email address"
          name="email"
          type="email"
          value={state.values?.email}
          autoComplete="email"
          maxLength={254}
          error={state.errors?.email}
        />
        <TurnstileWidget siteKey={ctx.config.turnstile.siteKey} action="forgot" />
        <Button type="submit" className="w-full">
          Send link
        </Button>
      </form>
    </AuthCard>
  ))
}

export function resetPage(ctx: Context, token: string, email: string, error: string | null = null): Html {
  return page(ctx, { title: "Choose a new password" }, (
    <AuthCard
      title="Choose a new password"
      description={
        <>
          For <strong>{email}</strong>. Choosing a new password signs you out everywhere else.
        </>
      }
    >
      <ErrorSummary errors={[error]} />
      <form method="post" action="/reset-password" className="flex flex-col gap-6">
        <Hidden name="token" value={token} />
        <input type="text" name="username" defaultValue={email} autoComplete="username" hidden />
        <TextField
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          hint={`At least ${PASSWORD_MIN} characters.`}
          error={error}
        />
        <Button type="submit" className="w-full">
          Save password
        </Button>
      </form>
    </AuthCard>
  ))
}

export function signedOutPage(ctx: Context): Html {
  return page(ctx, { title: "Signed out", user: null }, (
    <AuthCard title="You're signed out">
      <div className="flex flex-col gap-2 sm:flex-row">
        <a className={cn(buttonVariants(), "sm:flex-1")} href="/login">
          Sign in again
        </a>
        <a className={cn(buttonVariants({ variant: "outline" }), "sm:flex-1")} href={apexUrl(ctx)}>
          See all apps
        </a>
      </div>
    </AuthCard>
  ))
}

export const MAIL_FAILED = "We couldn't send the email right now. Please try again in a few minutes."
export const TURNSTILE_FAILED = "Please complete the security check and try again."
export const RATE_LIMITED = "Too many attempts. Please wait a minute and try again."
