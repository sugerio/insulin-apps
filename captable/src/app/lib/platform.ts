import { useEffect, useState } from "react";
import { z } from "zod";

// The Insulin Apps account around the app: on insulinapps.com the gateway answers `/__insulin/*` on the app's own host
// (the account bar uses the same endpoints): who is signed in, their organizations and the links to the platform's
// pages. Cap Table reads it for the organization switcher, the person's Account and Sign out, and the Settings links.
// Elsewhere (the Insulin console's frame, the local preview) there is no such account: the shell then shows the company
// and the console identity from /api/me, with nothing to switch or sign out of.

const link = z.string().nullable().optional();
const platformAccountSchema = z.object({
  user: z.object({ name: z.string(), email: z.string() }),
  organization: z.object({ id: z.string(), name: z.string(), roleLabel: z.string() }).nullable(),
  organizations: z.array(z.object({ id: z.string(), name: z.string(), roleLabel: z.string(), active: z.boolean() })),
  links: z.object({
    members: link,
    integrations: link,
    api: link,
    connectAi: link,
    organizations: link,
    account: link,
    apps: link,
  }),
});
export type PlatformAccount = z.infer<typeof platformAccountSchema>;

/** The page's navigation, in one place so tests can watch it (jsdom can't navigate). */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** An http(s) address, made absolute, or null for anything else (a `javascript:` link from a compromised answer). */
export function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Reads `/__insulin/me`; null when the page isn't served by the gateway (or is framed, as in the console). */
export async function loadPlatformAccount(signal?: AbortSignal): Promise<PlatformAccount | null> {
  if (window.top !== window.self) return null;
  try {
    const response = await fetch("/__insulin/me", { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
    if (!response.ok || !(response.headers.get("Content-Type") ?? "").includes("json")) return null;
    const parsed = platformAccountSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The account once it has been read: undefined while reading, null when there is none. */
export function usePlatformAccount(): PlatformAccount | null | undefined {
  const [account, setAccount] = useState<PlatformAccount | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void loadPlatformAccount(controller.signal).then((value) => {
      if (!controller.signal.aborted) setAccount(value);
    });
    return () => controller.abort();
  }, []);
  return account;
}

// An explicit referrer policy keeps a real Origin header on these POSTs, which the gateway checks.
function post(path: string, body: string, type: string): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    referrerPolicy: "strict-origin",
    headers: { Accept: "application/json", "Content-Type": type },
    body,
  });
}

/** Makes another of the person's organizations the active one, then opens the app's home in it. */
export async function switchOrganization(orgId: string): Promise<void> {
  const response = await post("/__insulin/switch-org", JSON.stringify({ orgId }), "application/json");
  if (!response.ok) throw new Error("The organization wasn't switched.");
  browser.assign("/");
}

/** Signs the person out of Insulin Apps, then follows the gateway to where it sends them. */
export async function signOut(): Promise<void> {
  const response = await post("/__insulin/logout", "", "application/x-www-form-urlencoded");
  if (!response.ok) throw new Error("The sign-out didn't go through.");
  const data = (await response.json().catch(() => null)) as { next?: unknown } | null;
  browser.assign(httpUrl(typeof data?.next === "string" ? data.next : null) ?? "/");
}

// ---------------------------------------------------------------------------
// The app's settings, which are the platform's pages on the apex (DESIGN.md §3)

export const SETTINGS_PAGES = [
  { key: "users", label: "People", link: "members" },
  { key: "integrations", label: "Integrations", link: "integrations" },
  { key: "api", label: "API access", link: "api" },
  { key: "connect-ai", label: "Connect AI", link: "connectAi" },
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number]["key"];

/** The app's name on the platform: from its people page (`/apps/<app>/settings/users`), else its host's first label. */
function appName(account: PlatformAccount): string {
  const members = httpUrl(account.links.members);
  const fromLink = members ? /^\/apps\/([a-z0-9-]+)\/settings\/users\/?$/.exec(new URL(members).pathname)?.[1] : undefined;
  if (fromLink) return fromLink;
  const labels = window.location.hostname.split(".");
  return labels.length >= 3 && /^[a-z0-9-]+$/.test(labels[0]!) ? labels[0]! : "captable";
}

/** The platform's origin (the apex), from the links it gave. */
export function apexOrigin(account: PlatformAccount): string | null {
  const any = httpUrl(account.links.apps) ?? httpUrl(account.links.account) ?? httpUrl(account.links.organizations);
  return any ? new URL(any).origin : null;
}

/**
 * Where each settings page is: the link the gateway gave, else the page's address on the apex
 * (`<apex>/apps/<app>/settings/<page>`). Without the platform's account there is no address to give.
 */
export function settingsLinks(account: PlatformAccount | null | undefined): { key: SettingsPage; label: string; href: string | null }[] {
  const apex = account ? apexOrigin(account) : null;
  const app = account ? appName(account) : null;
  return SETTINGS_PAGES.map(({ key, label, link }) => {
    const given = account ? httpUrl(account.links[link]) : null;
    // The people link points at the organization's page when the gateway sees no access to the app: use the app's.
    const usable = given && (link !== "members" || /\/apps\/[a-z0-9-]+\/settings\/users\/?$/.test(new URL(given).pathname)) ? given : null;
    return { key, label, href: usable ?? (apex && app ? `${apex}/apps/${app}/settings/${key}` : null) };
  });
}

/** Where to create another organization, on the apex. */
export function createOrganizationLink(account: PlatformAccount | null | undefined): string | null {
  const apex = account ? apexOrigin(account) : null;
  return apex ? `${apex}/orgs/new` : null;
}

/** Up to two initials: the first letters of the first two words of the name, else of the address. */
export function initials(name: string | null | undefined, email: string | null | undefined): string {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const source = words.length ? words.slice(0, 2) : [String(email ?? "")];
  return source.map((word) => Array.from(word)[0] ?? "").join("").toLocaleUpperCase("en") || "?";
}
