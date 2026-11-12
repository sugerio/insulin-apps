// Enterprise single sign-on (DESIGN.md §7): the owners' settings page (/settings/sso), "Sign in with SSO" (/sso), and
// the pages a sign-in through an identity provider shows on the way.
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { ErrorSummary, Hidden, Notice, PostButton, SelectField, TextField } from "@/components/forms"
import { AuthCard, proseLinks } from "@/components/layout"
import type { Session } from "../auth/session.ts"
import type { Context } from "../context.ts"
import { withReturnTo } from "../context.ts"
import { orgShell, type ShellData } from "../navigation.ts"
import type { ScimTokenRow, SsoConnectionRow, SsoDomainRow } from "../db/sso.ts"
import type { Html } from "./html.ts"
import { page } from "./document.tsx"
import { SettingsFrame, type OrgFrame } from "./settings.tsx"

const destructiveGhost = "text-destructive hover:bg-destructive/10 hover:text-destructive"

export interface SsoPageData extends OrgFrame {
  domains: SsoDomainRow[]
  connection: SsoConnectionRow | null
  details: { entityId: string; acsUrl: string; metadataUrl: string; redirectUri: string; scimUrl: string } | null
  tokens: ScimTokenRow[]
  /** A SCIM token just created, shown this once. */
  newToken: string | null
  secretKeyReady: boolean
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** A value to copy into the identity provider's settings. */
function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm font-medium">{label}</dt>
      <dd>
        <code className="block rounded-md border bg-muted px-3 py-2 text-xs break-all">{value}</code>
      </dd>
    </div>
  )
}

function DomainsCard({ data }: { data: SsoPageData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Domains</h2>
        </CardTitle>
        <CardDescription>
          Single sign-on and SCIM work for addresses in your verified domains only. Prove a domain is yours with a DNS TXT record; one
          organization at a time can hold it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {data.domains.length ? (
          <Table>
            <TableCaption className="sr-only">Domains of {data.orgName}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Domain</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.domains.map((domain) => (
                <TableRow key={domain.domain}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="font-medium">{domain.domain}</div>
                    {domain.verified_at === null ? (
                      <dl className="mt-2 flex flex-col gap-2">
                        <Copyable label="TXT record name" value={`_insulin-apps.${domain.domain}`} />
                        <Copyable label="TXT record value" value={`insulin-apps-verification=${domain.token}`} />
                      </dl>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top">
                    {domain.verified_at === null ? <Badge variant="outline">Waiting for the DNS record</Badge> : <Badge variant="secondary">Verified</Badge>}
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {domain.verified_at === null ? (
                        <PostButton action={`/orgs/${data.orgId}/sso/domains/verify`} fields={{ domain: domain.domain }} variant="outline" size="sm">
                          Verify<span className="sr-only"> {domain.domain}</span>
                        </PostButton>
                      ) : null}
                      <PostButton action={`/orgs/${data.orgId}/sso/domains/remove`} fields={{ domain: domain.domain }} variant="ghost" size="sm" className={destructiveGhost}>
                        Remove<span className="sr-only"> {domain.domain}</span>
                      </PostButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No domains yet.</p>
        )}
        <form method="post" action={`/orgs/${data.orgId}/sso/domains`} className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <TextField label="Add a domain" name="domain" autoComplete="off" maxLength={253} hint="The part of your work addresses after the @, such as example.com." />
          <Button type="submit" variant="outline">
            Add domain
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function Checkbox({ id, name, label, hint, checked }: { id: string; name: string; label: string; hint: string; checked: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" name={name} defaultChecked={checked} className="mt-0.5 size-4 shrink-0 accent-primary" aria-describedby={`${id}-hint`} />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        <span id={`${id}-hint`} className="block text-muted-foreground">
          {hint}
        </span>
      </label>
    </div>
  )
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      {children}
    </fieldset>
  )
}

function ConnectionCard({ data }: { data: SsoPageData }) {
  const connection = data.connection
  const certificates = connection?.saml_certificates ? (JSON.parse(connection.saml_certificates) as string[]).length : 0
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Identity provider</h2>
        </CardTitle>
        <CardDescription>
          Connect your organization&apos;s identity provider with SAML 2.0 or OpenID Connect. People with an address in a verified domain then
          sign in there; someone who isn&apos;t a member yet joins with the role you choose. The identity provider asks for whatever it
          requires, its own second factor included. Afterwards, anyone who has turned on two-step sign-in for their Insulin Apps account
          also enters a code from their authenticator app, or a recovery code, before they are signed in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action={`/orgs/${data.orgId}/sso/connection`} className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Protocol"
              name="protocol"
              choices={[{ value: "saml", label: "SAML 2.0" }, { value: "oidc", label: "OpenID Connect" }]}
              selected={connection?.protocol ?? "saml"}
            />
            <SelectField
              label="Role for new members"
              name="default_role"
              choices={[{ value: "VIEWER", label: "Viewer" }, { value: "EDITOR", label: "Editor" }]}
              selected={connection?.default_role ?? "VIEWER"}
              hint="Owners and admins change it later on the People page."
            />
          </div>
          <Fieldset legend="SAML 2.0">
            <TextField label="Identity provider entity ID (issuer)" name="saml_entity_id" value={connection?.saml_entity_id} required={false} maxLength={500} />
            <TextField label="Identity provider sign-in URL" name="saml_sso_url" value={connection?.saml_sso_url} required={false} maxLength={2000} hint="Its single sign-on URL for the HTTP-Redirect binding." />
            <Field>
              <FieldLabel htmlFor="field-saml_certificate">Signing certificate</FieldLabel>
              <Textarea id="field-saml_certificate" name="saml_certificate" rows={5} aria-describedby="field-saml_certificate-hint" className="font-mono text-xs" />
              <FieldDescription id="field-saml_certificate-hint">
                {certificates
                  ? `${certificates === 1 ? "One certificate is" : "Two certificates are"} saved. Paste new ones (one or two, PEM) to replace them, or leave this empty to keep them.`
                  : "Paste the certificate the identity provider signs with, in PEM form. During a rotation, paste both."}
              </FieldDescription>
            </Field>
          </Fieldset>
          <Fieldset legend="OpenID Connect">
            <TextField label="Issuer" name="oidc_issuer" value={connection?.oidc_issuer} required={false} maxLength={500} hint="Such as https://login.example.com; its discovery document must be at /.well-known/openid-configuration." />
            <TextField label="Client ID" name="oidc_client_id" value={connection?.oidc_client_id} required={false} maxLength={500} />
            <TextField
              label="Client secret"
              name="oidc_client_secret"
              type="password"
              autoComplete="off"
              required={false}
              maxLength={2000}
              hint={
                !data.secretKeyReady
                  ? "Client secrets can't be stored until the operator sets GATEWAY_SECRET_KEY."
                  : connection?.oidc_client_secret
                    ? "A secret is saved. Leave this empty to keep it."
                    : "Stored encrypted and never shown again."
              }
            />
          </Fieldset>
          <div className="flex flex-col gap-4">
            <Checkbox id="sso-enabled" name="enabled" label="Turn single sign-on on" hint="Shows your identity provider to people who choose Sign in with SSO." checked={connection?.enabled === 1} />
            <Checkbox
              id="sso-required"
              name="require_sso"
              label="Require single sign-on for the verified domains"
              hint="Password, Google, password reset and sign-up are then refused for those addresses."
              checked={connection?.require_sso === 1}
            />
          </div>
          <div>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </CardContent>
      {connection ? (
        <CardFooter className="border-t">
          <PostButton action={`/orgs/${data.orgId}/sso/connection/delete`} variant="ghost" className={destructiveGhost}>
            Delete the connection
          </PostButton>
        </CardFooter>
      ) : null}
    </Card>
  )
}

function DetailsCard({ data }: { data: SsoPageData }) {
  const details = data.details
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>What your identity provider needs</h2>
        </CardTitle>
        <CardDescription>
          {details ? "Enter these in your identity provider's app settings for Insulin Apps." : "Save the connection (it can stay off) to get the addresses your identity provider needs."}
        </CardDescription>
      </CardHeader>
      {details ? (
        <CardContent>
          <dl className="flex flex-col gap-3">
            {data.connection?.protocol === "oidc" ? (
              <Copyable label="Redirect URI (sign-in redirect URL)" value={details.redirectUri} />
            ) : (
              <>
                <Copyable label="Entity ID (audience)" value={details.entityId} />
                <Copyable label="Assertion consumer service (ACS) URL" value={details.acsUrl} />
                <Copyable label="Metadata URL" value={details.metadataUrl} />
                <Copyable label="Name ID format" value="Email address" />
              </>
            )}
          </dl>
        </CardContent>
      ) : null}
    </Card>
  )
}

function ScimCard({ ctx, data }: { ctx: Context; data: SsoPageData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>SCIM provisioning</h2>
        </CardTitle>
        <CardDescription>
          Your identity provider can add people (with the role for new members) and remove them, for addresses in your verified domains. Roles
          stay managed on the People page.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl>
          <Copyable label="SCIM base URL" value={data.details?.scimUrl ?? `${ctx.scheme}//${ctx.config.domain}${ctx.portSuffix}/scim/v2`} />
        </dl>
        {data.newToken ? (
          <Notice kind="ok">
            <span className="flex flex-col gap-2">
              <span>Copy this token into your identity provider now. It won&apos;t be shown again.</span>
              <code className="block rounded-md border bg-muted px-3 py-2 text-xs break-all text-foreground">{data.newToken}</code>
            </span>
          </Notice>
        ) : null}
        {data.tokens.length ? (
          <Table>
            <TableCaption className="sr-only">SCIM tokens</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Token</TableHead>
                <TableHead scope="col" className="max-sm:hidden">
                  Created
                </TableHead>
                <TableHead scope="col">Last used</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">{token.name}</TableCell>
                  <TableCell className="text-muted-foreground max-sm:hidden">{day(token.created_at)}</TableCell>
                  <TableCell className="text-muted-foreground">{token.last_used_at ? day(token.last_used_at) : "Never"}</TableCell>
                  <TableCell className="text-right">
                    <PostButton action={`/orgs/${data.orgId}/sso/scim-tokens/${token.id}/revoke`} variant="ghost" size="sm" className={destructiveGhost}>
                      Revoke<span className="sr-only"> {token.name}</span>
                    </PostButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No SCIM tokens yet.</p>
        )}
        <form method="post" action={`/orgs/${data.orgId}/sso/scim-tokens`} className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <TextField label="New token name" name="name" autoComplete="off" maxLength={60} hint="The system that will use it, such as your identity provider." />
          <Button type="submit" variant="outline">
            Create token
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

export function ssoSettingsPage(ctx: Context, session: Session, data: SsoPageData, shell: ShellData): Html {
  return page(ctx, { title: `Single sign-on · ${data.orgName}`, shell: orgShell(ctx, session, shell, "sso") }, (
    <SettingsFrame ctx={ctx} data={data}>
      <DomainsCard data={data} />
      <ConnectionCard data={data} />
      <DetailsCard data={data} />
      <ScimCard ctx={ctx} data={data} />
    </SettingsFrame>
  ))
}

/** /sso: the work address, which finds the organization's identity provider. */
export function ssoStartPage(ctx: Context, state: { email?: string; returnTo?: string | null; error?: string | null } = {}): Html {
  return page(ctx, { title: "Sign in with SSO" }, (
    <AuthCard
      title="Sign in with SSO"
      description="If your organization signs in through its own identity provider, enter your work email address."
      below={
        <p>
          <a href={withReturnTo("/login", state.returnTo ?? null)}>Back to sign in</a>
        </p>
      }
    >
      <ErrorSummary errors={[state.error]} />
      <form method="post" action="/sso" className="flex flex-col gap-6">
        <TextField label="Work email address" name="email" type="email" value={state.email} autoComplete="username" maxLength={254} />
        <Hidden name="return_to" value={state.returnTo} />
        <Button type="submit" className="w-full">
          Continue
        </Button>
      </form>
    </AuthCard>
  ))
}

/** On to the identity provider: a page, since the CSP's form-action stops a cross-origin redirect after a form. */
export function ssoContinuePage(ctx: Context, target: string): Html {
  return page(ctx, { title: "Continue", refreshTo: target }, (
    <AuthCard title="Continue">
      <a className={cn(buttonVariants(), "w-full")} href={target}>
        Continue to your organization&apos;s sign-in
      </a>
    </AuthCard>
  ))
}

export function ssoFailedPage(ctx: Context, text: string): Html {
  return page(ctx, { title: "Single sign-on didn't work" }, (
    <AuthCard title="Single sign-on didn't work">
      <div className={cn("flex flex-col gap-4 text-sm text-muted-foreground", proseLinks)}>
        <p>{text}</p>
        <a className={cn(buttonVariants({ variant: "outline" }), "w-full")} href="/sso">
          Try again
        </a>
      </div>
    </AuthCard>
  ))
}

/** For an address whose organization requires its single sign-on. */
export function ssoRequiredPage(ctx: Context, email: string, returnTo: string | null): Html {
  const href = withReturnTo(`/sso?email=${encodeURIComponent(email)}`, returnTo)
  return page(ctx, { title: "Use single sign-on" }, (
    <AuthCard title="Use single sign-on">
      <div className={cn("flex flex-col gap-4 text-sm text-muted-foreground", proseLinks)}>
        <p>
          Your organization requires its own sign-in for <strong className="text-foreground">{email}</strong>, so passwords, Google and
          password resets aren&apos;t available for this address.
        </p>
        <a className={cn(buttonVariants(), "w-full")} href={href}>
          Sign in with SSO
        </a>
      </div>
    </AuthCard>
  ))
}
