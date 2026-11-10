// The privacy notice and the terms of use, on the apex. DRAFT wording for the owner's legal review: it describes what
// the gateway and the apps actually do; keep it in step with the code (cookies, retention, processors, deletion).
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { ContactLink } from "@/components/contact"
import { Container, proseLinks } from "@/components/layout"
import type { Context } from "../context.ts"
import { apexUrl } from "../context.ts"
import { SESSION_COOKIE } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { page } from "./document.tsx"

const UPDATED = "10 November 2026"

/** Readable running text: a measure of about 70 characters, relaxed leading, spaced headings and lists. */
const PROSE = cn(
  "flex flex-col gap-4 text-[0.9375rem] leading-7 text-pretty",
  "[&_h2]:mt-6 [&_h2]:text-xl [&_h2]:leading-snug [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5 [&_li]:pl-1 [&_li::marker]:text-muted-foreground",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8125rem] [&_code]:break-words",
  proseLinks
)

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Container width="prose" className="py-10 sm:py-16">
      <article className={cn(PROSE, "max-w-[70ch]")}>
        <header className="mb-2 flex flex-col gap-2 border-b pb-6">
          <div className="text-3xl font-semibold tracking-tight sm:text-4xl">
            <h1>{title}</h1>
          </div>
          <p className="text-sm text-muted-foreground">Last updated {UPDATED}</p>
        </header>
        {children}
      </article>
    </Container>
  )
}

function ContactSection({ ctx }: { ctx: Context }) {
  return (
    <>
      <h2 id="contact">Contact</h2>
      <p>
        Questions or requests: <ContactLink ctx={ctx} />.
        {ctx.config.supportEmail
          ? null
          : " Issues there are public: don't post personal data in them. For a request about your own data, open an issue asking for a private way to reach us, without including the data itself."}
      </p>
    </>
  )
}

export function privacyPage(ctx: Context): Html {
  const domain = ctx.config.domain
  const oauthCookie = "__Host-insulin_oauth"
  const mfaCookie = "__Host-insulin_mfa"
  const ssoCookie = "__Host-insulin_sso"
  return page(ctx, { title: "Privacy notice" }, (
    <LegalPage title="Privacy notice">
      <p>
        This notice explains what Insulin Apps at {domain} and its subdomains (the &quot;service&quot;) collects, why, who processes
        it, and how to delete it. The service hosts open-source apps for organizations and their members.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your account:</strong> your name and email address, and whether and when you confirmed the address.
        </li>
        <li>
          <strong>Your password, as a hash only:</strong> we store a salted PBKDF2-SHA256 hash, never the password itself. If you sign
          in with Google instead, we store your Google account id and the name and email address Google shares with us. We ask
          Google only for your basic profile and email address, not for access to your other Google data.
        </li>
        <li>
          <strong>Cookies:</strong> <code>{SESSION_COOKIE}</code> keeps you signed in across the service&apos;s sites for 30 days,
          renewed while you use it. <code>{oauthCookie}</code> carries a Google sign-in, <code>{mfaCookie}</code> the code step of
          two-step sign-in, and <code>{ssoCookie}</code> a single sign-on, each for up to 10 minutes. We store only a hash of the
          session cookie&apos;s value.
        </li>
        <li>
          <strong>Two-step sign-in, if you turn it on:</strong> your authenticator app&apos;s secret, encrypted, when you turned it on,
          the last code time accepted and how many wrong codes were entered in a row, and your recovery codes as hashes only. If
          your organization&apos;s single sign-on first signs in an account that has its own password or Google link, we note
          when, to tell you once.
        </li>
        <li>
          <strong>Organizations:</strong> the organizations you create or join, your role in each (or the apps you were given and
          your role in each), the custom roles owners define, and invitations: the email addresses people invite, the access
          offered, who sent the invitation, and whether it was accepted.
        </li>
        <li>
          <strong>Single sign-on, if your organization sets it up:</strong> the email domains it claimed and their verification
          records, its identity provider&apos;s settings (an OIDC client secret encrypted), SCIM tokens as hashes only, and which
          people its identity provider added, with that provider&apos;s id for them. When you sign in that way, the identity
          provider sends us your email address and name.
        </li>
        <li>
          <strong>AI agents and API access:</strong> the AI agents (MCP clients) you connect: the name and return address each
          gave itself, and each permission you allowed (you, the organization, the app, when it was allowed and last used).
          Service accounts that an app&apos;s admins create: their name, role, who created them and when they were last used.
          Tokens and client secrets are stored as hashes only. Credentials for outside services that admins store for an app
          are encrypted and never shown again.
        </li>
        <li>
          <strong>What you enter into the apps:</strong> each app stores the data you put in it for your organization. Apps also
          receive your account id, name, email address and role, and may keep them to show who did what (for example, Cap
          Table&apos;s audit trail) and to match people to their records.
        </li>
        <li>
          <strong>Email records:</strong> for each email we send, a one-way hash of the recipient&apos;s address, the kind of email
          and the time, so we can limit how many emails one address receives.
        </li>
        <li>
          <strong>Your IP address, briefly:</strong> used to rate-limit sign-in, sign-up and other account requests, and sent to
          Cloudflare Turnstile with the bot check. We don&apos;t store it in our database.
        </li>
      </ul>
      <p>
        Our application logs record events with account and organization ids and, when something fails, the type of failure. We
        don&apos;t write passwords, tokens, cookies, email addresses or error messages to them.
      </p>

      <h2>Why we collect it</h2>
      <ul>
        <li>To create your account, confirm your email address, sign you in and keep you signed in.</li>
        <li>
          To send the emails the service needs: confirmation links, password resets, invitations, and a notice when someone tries
          to sign up with your address.
        </li>
        <li>To let organizations work together: membership, roles, custom roles, invitations and single sign-on.</li>
        <li>To let the AI agents you connect, and the service accounts admins create, use the apps with the access given.</li>
        <li>To run the apps you use for your organization.</li>
        <li>To limit abuse of the service: rate limits, the bot check and email limits.</li>
      </ul>
      <p>We process this data to provide the service you ask for, and in our legitimate interest in limiting abuse of it.</p>

      <h2>Who processes it</h2>
      <ul>
        <li>
          <strong>Cloudflare</strong> runs the service and the apps (Cloudflare Workers), stores their data (Cloudflare D1), runs the
          bot check on our forms (Cloudflare Turnstile) and delivers our emails (Cloudflare Email Service). See{" "}
          <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare&apos;s privacy policy</a>.
        </li>
        <li>
          <strong>Google</strong>, only if you choose &quot;Continue with Google&quot;: Google then knows you signed in to the service.
          See <a href="https://policies.google.com/privacy">Google&apos;s privacy policy</a>.
        </li>
        <li>
          <strong>Other members of your organizations:</strong> everyone with an organization role sees the names, email addresses
          and access of the organization&apos;s members, and everyone who can use an app sees who else can use it; admins and owners
          see pending invitations. What you enter in an app is visible to your organization&apos;s members according to that
          app&apos;s roles.
        </li>
        <li>
          <strong>Your organization&apos;s identity provider</strong>, if it uses single sign-on, which knows when you sign in. To
          verify a domain we look up its DNS record through Cloudflare&apos;s DNS-over-HTTPS service.
        </li>
        <li>
          <strong>The AI agents you connect</strong>, and the company that runs each one: what an agent reads from an app with your
          access goes to it, under that company&apos;s terms. Disconnect an agent at any time on your account&apos;s AI agents page.
        </li>
        <li>
          <strong>Outside services an app&apos;s admins connect</strong>: the app&apos;s requests to them carry what the app sends,
          with the stored credential.
        </li>
      </ul>

      <h2>What we don&apos;t do</h2>
      <p>No ads, no selling or renting of personal data, no analytics or tracking cookies, and no marketing emails.</p>

      <h2>How long we keep it</h2>
      <p>
        Data is not reset. We keep your account until you delete it, and an organization&apos;s records, including its invitations,
        until the organization is deleted. Confirmation links expire after 24 hours and password-reset links after 1 hour;
        sessions end when you sign out, when your password changes, or after 30 days without use. A permission you give an AI
        agent lasts 30 days, unless you disconnect it or leave the organization first; its tokens last an hour (sign-in codes 60
        seconds). A sign-in step waiting for a code, a single sign-on or your decision on an agent lasts 10 minutes. An agent
        that registered but was never allowed is deleted after a day. Recovery codes last until you replace them or turn
        two-step sign-in off.
      </p>
      <p>
        Expired sessions, used or expired links, expired sign-in steps and agent tokens, and email records older than two days
        are deleted automatically, a small batch at a time, as the service handles account activity. On a quiet day they can stay a little longer before they are removed.
      </p>

      <h2>Deleting your data</h2>
      <ul>
        <li>
          On your <a href={apexUrl(ctx, "/account")}>account page</a>, choose <strong>Delete my account</strong>. This deletes your
          account, your sessions and your memberships, and every organization where you are the only member, with its
          invitations.
        </li>
        <li>
          If you are the only owner of an organization that has other members, make another member an owner, or remove the other
          members, before deleting your account.
        </li>
        <li>
          Owners can delete an organization from its page. This removes it, its memberships and its invitations from Insulin Apps
          sign-in. Data that apps stored for that organization stays in the apps&apos; databases but can no longer be reached by
          anyone, because the organization&apos;s id is never issued again. To remove app data, delete it in the app first, or
          contact us.
        </li>
        <li>To decline an invitation you received, use the Decline button on the invitation or on your home page.</li>
        <li>
          To disconnect an AI agent, use <a href={apexUrl(ctx, "/account/agents")}>AI agents</a> on your account. To turn two-step
          sign-in off, which deletes its secret and recovery codes, use <a href={apexUrl(ctx, "/account/security")}>Security</a>.
        </li>
      </ul>

      <h2>Children</h2>
      <p>The service is not intended for children. Don&apos;t use it if you are under 16.</p>

      <h2>Changes to this notice</h2>
      <p>We may update this notice as the service changes. The date at the top shows the latest version.</p>

      <ContactSection ctx={ctx} />
      <p>
        <a href={apexUrl(ctx, "/terms")}>Terms of use</a>
      </p>
    </LegalPage>
  ))
}

export function termsPage(ctx: Context): Html {
  const domain = ctx.config.domain
  return page(ctx, { title: "Terms of use" }, (
    <LegalPage title="Terms of use">
      <p>
        These terms apply to Insulin Apps at {domain} and its subdomains (the &quot;service&quot;). By creating an account or using the
        service you agree to them.
      </p>

      <h2>The service, provided as is</h2>
      <p>
        Insulin Apps hosts open-source apps that organizations use to work together. It is provided &quot;as is&quot; and &quot;as
        available&quot;, without warranties of any kind and with no guarantee of uptime or availability. Keep your own copies of
        anything you can&apos;t afford to lose. We may change, pause or end the service, or any app on it, at any time.
      </p>

      <h2>Your account</h2>
      <p>
        Give accurate details, keep your password to yourself, and tell us if you think someone else is using your account. You
        are responsible for what happens in your account and in the organizations you manage, including who you invite and the
        roles you give.
      </p>

      <h2>Acceptable use</h2>
      <p>Don&apos;t use the service to:</p>
      <ul>
        <li>send spam, including invitations to people who don&apos;t expect them;</li>
        <li>store or share illegal, harmful or infringing content;</li>
        <li>
          attack or probe the service or other people: no scanning, load testing, password guessing, malware, or getting around
          rate limits, bot checks or access controls;
        </li>
        <li>create accounts automatically, impersonate others, or harass anyone.</li>
      </ul>

      <h2>Suspension and removal</h2>
      <p>
        We may suspend or delete accounts, organizations and data, with or without notice, if they break these terms or put the
        service or its users at risk.
      </p>

      <h2>Open-source code</h2>
      <p>
        The source code of the apps and of this service is published under the MIT License in the project&apos;s public repository;
        that license governs the code. These terms cover only the hosted service.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent the law allows, we are not liable for any loss or damage arising from your use of the service,
        including lost data, profits or business. Nothing in these terms limits liability that cannot be limited by law.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms. The date at the top shows the latest version; continuing to use the service means you accept
        the updated terms.
      </p>

      <ContactSection ctx={ctx} />
      <p>
        <a href={apexUrl(ctx, "/privacy")}>Privacy notice</a>
      </p>
    </LegalPage>
  ))
}
