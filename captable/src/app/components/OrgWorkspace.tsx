import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { Outlet, useParams } from "react-router";
import { api, engine } from "#shared";
import { apiRequest } from "../api/request.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { createFormatter, type Formatter } from "../lib/format.ts";
import { orgWriteRestriction, type OrgWriteRestriction } from "../lib/org.ts";
import { useResource } from "../lib/useResource.ts";
import { DisplayContext, type Display } from "./Display.tsx";
import { ErrorState, Loading } from "./Feedback.tsx";
import { ToastProvider } from "./Toast.tsx";
import { UnsettledGuard } from "./UnsettledGuard.tsx";

// What every admin page of the company needs to know about the person and the company: their access (OWNER and ADMIN
// write, EDITOR reads), whether personal data is shown, which stakeholders are their own (no
// writes on one's own holdings), and the company's display settings. The access comes from /api/me; the company
// record is fetched once, and no page renders until it has: every figure is formatted with the company's decimals and
// time zone, never with defaults standing in for settings that haven't arrived or failed to load.

export interface Workspace {
  orgId: string;
  name: string;
  legalName: string;
  today: string;
  access: api.MeResponse["access"];
  /** An owner or admin, in a company that accepts changes. */
  canWrite: boolean;
  /** An editor: no write buttons and a "Read-only" badge. */
  readOnly: boolean;
  canSeePii: boolean;
  /** Why this company refuses all writes; null when its state permits them. */
  writeRestriction: OrgWriteRestriction | null;
  org: api.Org;
  /** Reads the company again (after a write to its profile or settings); the shown one stays until the new one arrives. */
  reloadOrg(): void;
  format: Formatter;
  isOwn(stakeholderId: string | null | undefined): boolean;
  href(path: string): string;
}

const WorkspaceContext = createContext<Workspace | null>(null);

/** What the shell needs from the workspace below it: whether writes are allowed in the org on screen ("+ New"). */
export interface ShellWriteState {
  orgId: string;
  canWrite: boolean;
}
/** Provided by the app shell; the workspace publishes its resolved write access into it. */
export const ShellWriteContext = createContext<((state: ShellWriteState | null) => void) | null>(null);

export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside OrgWorkspace");
  return value;
}

/** The admin workspace when there is one (shared components also render in the holder portal, where there isn't). */
export function useOptionalWorkspace(): Workspace | null {
  return useContext(WorkspaceContext);
}

/**
 * Renders its children as if no admin workspace were around: the holder's portal inside the admin's preview, which
 * must look exactly like the holder's own view (no read-only badge, no admin defaults).
 */
export function OutsideWorkspace({ children }: { children: ReactNode }) {
  return <WorkspaceContext value={null}>{children}</WorkspaceContext>;
}

export function useFormat(): Formatter {
  return useWorkspace().format;
}

export function OrgWorkspace({ children }: { children?: ReactNode }) {
  const me = useMe();
  const { orgId = "" } = useParams();
  const company = me.company?.id === orgId ? me.company : null;
  const orgResource = useResource((signal) => apiRequest(api.routes.getOrg, { params: { orgId }, signal }), [orgId], company !== null);
  const org = orgResource.data;
  const value = useMemo<Workspace | null>(() => {
    if (!company || !org) return null;
    const writeRestriction = orgWriteRestriction(org.status);
    const own = new Set(me.portal.matches.filter((match) => match.orgId === orgId).map((match) => match.stakeholderId));
    // The company's local date, from its time zone at the server's clock (/api/me's serverTime).
    const today = engine.orgToday(org.timezone, me.serverTime);
    return {
      orgId,
      name: org.displayName,
      legalName: org.legalName,
      today,
      access: me.access,
      canWrite: me.access === "admin_rw" && writeRestriction === null,
      readOnly: me.access === "admin_ro",
      canSeePii: me.pii,
      writeRestriction,
      org,
      reloadOrg: orgResource.reload,
      format: createFormatter(org.settings.display, org.timezone, today),
      isOwn: (stakeholderId) => stakeholderId !== null && stakeholderId !== undefined && own.has(stakeholderId),
      href: (path) => `/companies/${orgId}/${path.replace(/^\//, "")}`,
    };
  }, [me, company, org, orgId, orgResource.reload]);
  const display = useMemo<Display | null>(() => (value ? { format: value.format, today: value.today } : null), [value]);
  const publish = useContext(ShellWriteContext);
  const canWrite = value?.canWrite ?? false;
  useEffect(() => {
    if (!publish) return;
    publish({ orgId, canWrite });
    return () => publish(null);
  }, [publish, orgId, canWrite]);
  if (!company) return null;
  // The company record carries the display settings and time zone every page needs: wait for it.
  if (!value || !display) {
    return (
      <section className="page">
        {orgResource.error !== undefined ? <ErrorState error={orgResource.error} onRetry={orgResource.reload} /> : <Loading label="Loading the company…" />}
      </section>
    );
  }
  return (
    <WorkspaceContext value={value}>
      <DisplayContext value={display}>
        {value.writeRestriction ? <div className="restriction-banner" role="status">{value.writeRestriction.text}</div> : null}
        <ToastProvider>
          <UnsettledGuard />
          {children ?? <Outlet />}
        </ToastProvider>
      </DisplayContext>
    </WorkspaceContext>
  );
}
