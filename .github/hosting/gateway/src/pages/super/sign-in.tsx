// The operator console's sign-in page and its failures (DESIGN.md §11.1): one button that goes to the platform's
// Google Workspace app. Nothing on it depends on who is asking.
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { AuthCard } from "@/components/layout"
import type { Context } from "../../context.ts"
import { superBarePage } from "./layout.tsx"

export function signInPage(ctx: Context): Response {
  void ctx
  return superBarePage("Sign in", 200, (
    <AuthCard
      title="Operator console"
      description="For Insulin Apps staff. Sign in with your company Google account; only members of the operators' group get in."
    >
      <a className={cn(buttonVariants(), "w-full")} href="/super/login">
        Sign in with Google Workspace
      </a>
    </AuthCard>
  ))
}

export function signInFailedPage(ctx: Context, status: number, text: string): Response {
  void ctx
  return superBarePage("Sign-in failed", status, (
    <AuthCard title="You weren't signed in">
      <p className="text-sm text-muted-foreground">{text}</p>
      <a className={cn(buttonVariants({ variant: "outline" }), "w-full")} href="/super">
        Back to the sign-in page
      </a>
    </AuthCard>
  ))
}
