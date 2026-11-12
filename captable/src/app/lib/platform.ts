import { createContext, useEffect, useState } from "react";
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
  /** The platform's origin, when the gateway says it. */
  apex: link,
  /** The app's settings pages, when the gateway gives them. */
  settings: z.object({ users: link, integrations: link, api: link, connectAi: link }).nullable().optional(),
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

/** The account the shell read, for the pages inside it. */
export const PlatformAccountContext = createContext<PlatformAccount | null | undefined>(undefined);

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
  { key: "users", label: "People", setting: "users", link: "members" },
  { key: "integrations", label: "Integrations", setting: "integrations", link: "integrations" },
  { key: "api", label: "API access", setting: "api", link: "api" },
  { key: "connect-ai", label: "Connect AI", setting: "connectAi", link: "connectAi" },
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number]["key"];

const APP_SETTINGS_PAGE = /^\/apps\/([a-z0-9-]+)\/settings\/(?:users|integrations|api|connect-ai)\/?$/;

/** The app's name on the platform: from a settings page the gateway gave (`/apps/<app>/settings/...`), else its host's first label. */
function appName(account: PlatformAccount): string {
  for (const given of [...Object.values(account.settings ?? {}), account.links.members, account.links.integrations, account.links.connectAi]) {
    const url = httpUrl(given);
    const name = url ? APP_SETTINGS_PAGE.exec(new URL(url).pathname)?.[1] : undefined;
    if (name) return name;
  }
  const labels = window.location.hostname.split(".");
  return labels.length >= 3 && /^[a-z0-9-]+$/.test(labels[0]!) ? labels[0]! : "captable";
}

/** The platform's origin (the apex): as the gateway says it, else from the links it gave. */
export function apexOrigin(account: PlatformAccount): string | null {
  const any = httpUrl(account.apex) ?? httpUrl(account.links.apps) ?? httpUrl(account.links.organizations) ?? httpUrl(account.links.account);
  return any ? new URL(any).origin : null;
}

/**
 * Where each settings page is: the gateway's `settings`, else its link, else the page's address on the apex
 * (`<apex>/apps/<app>/settings/<page>`). Without the platform's account there is no address to give.
 */
export function settingsLinks(account: PlatformAccount | null | undefined): { key: SettingsPage; label: string; href: string | null }[] {
  const apex = account ? apexOrigin(account) : null;
  const app = account ? appName(account) : null;
  return SETTINGS_PAGES.map(({ key, label, setting, link }) => {
    const fromSettings = account ? httpUrl(account.settings?.[setting]) : null;
    const given = account ? httpUrl(account.links[link]) : null;
    // The people link points at the organization's page when the gateway sees no access to the app: use the app's.
    const usable = given && (link !== "members" || APP_SETTINGS_PAGE.test(new URL(given).pathname)) ? given : null;
    return { key, label, href: fromSettings ?? usable ?? (apex && app ? `${apex}/apps/${app}/settings/${key}` : null) };
  });
}

/** Cap Table's public docs on the apex (`<apex>/docs/captable/`), or null without the platform's account. */
export function publicDocsLink(account: PlatformAccount | null | undefined): string | null {
  const apex = account ? apexOrigin(account) : null;
  return apex ? `${apex}/docs/captable/` : null;
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
