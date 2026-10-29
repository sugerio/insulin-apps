// The top bar of every gateway page: the mark and name, a link to Insulin, and the account controls (sign-in links,
// or the organization switcher and the account menu). Everything works without JavaScript: links, plain form POSTs
// and <details> menus (menu.tsx).
import { ArrowUpRight, Building2, Check, ChevronsUpDown, LogOut, Plus, UserRound, Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import type { ActiveOrg } from "../auth/session.ts"
import type { Context } from "../context.ts"
import { apexUrl, authUrl, withReturnTo } from "../context.ts"
import type { MembershipRow } from "../db/orgs.ts"
import { ROLE_LABELS } from "../roles.ts"
import { InsulinMark } from "./brand.tsx"
import { Menu, MenuContent, MenuLabel, MenuSeparator, MenuTrigger, menuItemClass } from "./menu.tsx"

export const INSULIN_URL = "https://www.insulin.dev"

/** Who is signed in, for the top bar. */
export interface HeaderAccount {
  name: string
  email: string
  /** The active organization, when known. */
  org?: ActiveOrg | null
  /** All of the user's organizations, when the page has them: the switcher then lists them. */
  orgs?: readonly MembershipRow[]
}

/** Up to two initials for the avatar: the first letters of the first two words of the name, else of the address. */
export function initials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = (words.length ? words.slice(0, 2) : [email]).map((word) => Array.from(word)[0] ?? "")
  return letters.join("").toLocaleUpperCase("en")
}

/** Where a top-bar form posts on this host: the auth host's own routes, else the reserved /__insulin/* ones. */
function signOutAction(ctx: Context): string {
  return ctx.site === "auth" ? "/logout" : "/__insulin/logout"
}

function SwitchOrgForm({ ctx, org }: { ctx: Context; org: MembershipRow }) {
  // The auth host switches with /orgs/switch and comes back to this page (a GET; after a POST, to the home page);
  // other hosts post to /__insulin/switch-org, which answers with a redirect to their home page.
  const auth = ctx.site === "auth"
  const back = auth && (ctx.request.method === "GET" || ctx.request.method === "HEAD") ? ctx.url.href : null
  return (
    <form method="post" action={auth ? "/orgs/switch" : "/__insulin/switch-org"}>
      <input type="hidden" name="org_id" defaultValue={org.org_id} />
      {back && <input type="hidden" name="return_to" defaultValue={back} />}
      <button type="submit" className={menuItemClass}>
        <span className="size-4" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{org.org_name}</span>
        <span className="text-xs text-muted-foreground">{ROLE_LABELS[org.role]}</span>
      </button>
    </form>
  )
}

function OrgSwitcher({ ctx, account, org }: { ctx: Context; account: HeaderAccount; org: ActiveOrg }) {
  return (
    <Menu name="top-bar">
      <MenuTrigger
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-w-[11rem] cursor-pointer sm:max-w-[18rem]")}
      >
        <Building2 />
        <span className="sr-only">Organization: </span>
        <span className="min-w-0 truncate">{org.name}</span>
        <Badge variant="secondary" className="hidden sm:inline-flex">
          {ROLE_LABELS[org.role]}
        </Badge>
        <ChevronsUpDown className="text-muted-foreground" />
      </MenuTrigger>
      <MenuContent className="w-72">
        <MenuLabel className="text-xs font-normal text-muted-foreground">Organizations</MenuLabel>
        {(account.orgs?.length ? account.orgs : [{ org_id: org.id, org_name: org.name, role: org.role, created_at: 0 }]).map((item) =>
          item.org_id === org.id ? (
            <div key={item.org_id} className={cn(menuItemClass, "hover:bg-transparent")} aria-current="true">
              <Check className="text-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{item.org_name}</span>
              <span className="text-xs text-muted-foreground">{ROLE_LABELS[item.role]}</span>
            </div>
          ) : (
            <SwitchOrgForm key={item.org_id} ctx={ctx} org={item} />
          )
        )}
        {account.orgs ? null : (
          <a className={menuItemClass} href={authUrl(ctx, "/")}>
            <ChevronsUpDown />
            Switch organization
          </a>
        )}
        <MenuSeparator />
        <a className={menuItemClass} href={authUrl(ctx, `/orgs/${org.id}`)}>
          <Users />
          Manage members
        </a>
        <a className={menuItemClass} href={authUrl(ctx, "/orgs/new")}>
          <Plus />
          Create an organization
        </a>
      </MenuContent>
    </Menu>
  )
}

function AccountMenu({ ctx, account }: { ctx: Context; account: HeaderAccount }) {
  return (
    <Menu name="top-bar">
      <MenuTrigger className="cursor-pointer rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <Avatar>
          <AvatarFallback className="bg-primary text-xs font-medium text-primary-foreground" aria-hidden="true">
            {initials(account.name, account.email)}
          </AvatarFallback>
        </Avatar>
        <span className="sr-only">Account menu for {account.name}</span>
      </MenuTrigger>
      <MenuContent className="w-64">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{account.name}</p>
          <p className="truncate text-xs text-muted-foreground">{account.email}</p>
        </div>
        <MenuSeparator />
        <a className={menuItemClass} href={authUrl(ctx, "/")}>
          <Building2 />
          Your organizations
        </a>
        <a className={menuItemClass} href={authUrl(ctx, "/account")}>
          <UserRound />
          Account
        </a>
        <MenuSeparator />
        {/* Sign-out posts to the page's own host, so the Origin check and the CSP's form-action both allow it. */}
        <form method="post" action={signOutAction(ctx)}>
          <button type="submit" className={menuItemClass}>
            <LogOut />
            Sign out
          </button>
        </form>
      </MenuContent>
    </Menu>
  )
}

function AccountControls({ ctx, account }: { ctx: Context; account: HeaderAccount | null }) {
  if (account) {
    return (
      <>
        {account.org ? <OrgSwitcher ctx={ctx} account={account} org={account.org} /> : null}
        <AccountMenu ctx={ctx} account={account} />
      </>
    )
  }
  const back = ctx.site === "apex" ? apexUrl(ctx) : null
  return (
    <>
      <a className={buttonVariants({ variant: "ghost", size: "sm" })} href={authUrl(ctx, withReturnTo("/login", back))}>
        Sign in
      </a>
      <a className={buttonVariants({ size: "sm" })} href={authUrl(ctx, withReturnTo("/signup", back))}>
        Create account
      </a>
    </>
  )
}

export function SiteHeader({ ctx, account }: { ctx: Context; account: HeaderAccount | null | undefined }) {
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">
        <a
          href={apexUrl(ctx)}
          className="flex shrink-0 items-center gap-2.5 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <InsulinMark />
          <span className="max-sm:sr-only">Insulin Apps</span>
        </a>
        <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
          <a className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "px-2 text-muted-foreground sm:px-3")} href={INSULIN_URL}>
            <span>
              <span className="max-md:hidden">Built with </span>Insulin
            </span>
            <ArrowUpRight />
          </a>
          {account === undefined ? null : (
            <nav aria-label="Account" className="flex min-w-0 items-center gap-1 sm:gap-2">
              <AccountControls ctx={ctx} account={account} />
            </nav>
          )}
        </div>
      </div>
    </header>
  )
}
