import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Outlet, useParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { useAuth } from "../auth/AuthProvider.tsx";
import { isApiError } from "../lib/errors.ts";
import { createFormatter } from "../lib/format.ts";
import { useResource, type Resource } from "../lib/useResource.ts";
import { DisplayContext, type Display } from "./Display.tsx";
import { Loading, ResourceView } from "./Feedback.tsx";
import { Icon } from "./Icon.tsx";
import { Page } from "./Page.tsx";
import { OutsideWorkspace, useWorkspace } from "./OrgWorkspace.tsx";

// The holder portal's frame. Every portal page reads the caller's own holdings from the
// allowlisted payloads, parsed with the strict portal schemas by the typed client, so an unexpected key fails the page
// instead of reaching it. The admin's "Preview as stakeholder" renders the very same pages from the preview
// routes, which answer with the same payloads, with every portal action disabled.

/** Where a portal's pages get their data: the holder's own portal routes, or the admin preview's twins of them. */
export interface PortalSource {
  /** Changes when the source does (another company, another previewed stakeholder). */
  key: string;
  security(securityId: string, signal: AbortSignal): Promise<api.PortalSecurityDetail>;
  documents(signal: AbortSignal): Promise<api.PortalDocumentList>;
}

export interface PortalScope {
  orgId: string;
  orgName: string;
  /** The caller's records in this org (one per matched stakeholder: an individual and their trust are separate). */
  holdings: readonly api.PortalHolding[];
  /** Set in the admin preview: the holder being previewed. Actions are disabled there. */
  preview: { stakeholderName: string } | null;
  /** A portal path below this org's portfolio ("" for the overview). */
  href(path?: string): string;
  source: PortalSource;
  /** How to exercise for this company, loaded once per portal: its page, and the company contact in the footer. */
  howTo: Resource<api.HowToExercise>;
}

const PortalContext = createContext<PortalScope | null>(null);

export function usePortal(): PortalScope {
  const value = useContext(PortalContext);
  if (!value) throw new Error("usePortal must be used inside the portal");
  return value;
}

/** Holders see the default display settings: the portal payloads carry no org settings (quantities keep their digits). */
export function portalDisplay(today: string): Display {
  return { format: createFormatter(api.DEFAULT_ORG_SETTINGS.display, undefined, today), today };
}

/** `/portfolio/:orgId/*`: the signed-in holder's own portfolio in one org. */
export function PortalWorkspace() {
  const { orgId = "" } = useParams();
  const overview = useResource((signal) => apiRequest(api.routes.getPortalOverview, { signal }), []);
  const howTo = useResource((signal) => apiRequest(api.routes.getHowToExercise, { params: { orgId }, signal }), [orgId]);
  const source = useMemo<PortalSource>(() => ({
    key: `holder:${orgId}`,
    security: (id, signal) => apiRequest(api.routes.getPortalSecurity, { params: { orgId, id }, signal }),
    documents: (signal) => apiRequest(api.routes.listPortalDocuments, { params: { orgId }, signal }),
  }), [orgId]);
  // The portal answers 404 to a caller it doesn't serve. Whether that is a loss of access or a page the
  // server can't serve right now is for /api/me to say: see PortalNotServed.
  if (overview.data === undefined && isApiError(overview.error, "not_found")) {
    return <section className="page"><PortalNotServed what="Your portfolio" onRetry={overview.reload} /></section>;
  }
  return (
    <ResourceView resource={overview}>
      {(data) => {
        const holdings = data.holdings.filter((holding) => holding.orgId === orgId);
        if (holdings.length === 0) return <section className="page"><PortalNotServed what="Your portfolio" onRetry={overview.reload} /></section>;
        return (
          <PortalFrame
            scope={{
              orgId,
              orgName: holdings[0]!.orgDisplayName,
              holdings,
              preview: null,
              href: (path = "") => `/portfolio/${orgId}${path ? `/${path.replace(/^\//, "")}` : ""}`,
              source,
              howTo,
            }}
            today={data.asOf}
          >
            <Outlet />
          </PortalFrame>
        );
      }}
    </ResourceView>
  );
}

const PREVIEW_UNAVAILABLE = "This portal preview isn't available. The stakeholder may not be in this company.";

/** `/companies/:orgId/stakeholders/:stakeholderId/preview/*`: the holder's exact portal view, inside the admin shell. */
export function PreviewWorkspace() {
  const workspace = useWorkspace();
  const { stakeholderId = "" } = useParams();
  const orgId = workspace.orgId;
  const preview = useResource((signal) => apiRequest(api.routes.previewAsStakeholder, { params: { orgId, id: stakeholderId }, signal }), [orgId, stakeholderId]);
  const howTo = useResource((signal) => apiRequest(api.routes.previewHowToExercise, { params: { orgId, id: stakeholderId }, signal }), [orgId, stakeholderId]);
  const source = useMemo<PortalSource>(() => ({
    key: `preview:${orgId}:${stakeholderId}`,
    security: (securityId, signal) => apiRequest(api.routes.previewPortalSecurity, { params: { orgId, id: stakeholderId, securityId }, signal }),
    documents: (signal) => apiRequest(api.routes.previewPortalDocuments, { params: { orgId, id: stakeholderId }, signal }),
  }), [orgId, stakeholderId]);
  const name = preview.data?.holdings.find((holding) => holding.stakeholderId === stakeholderId)?.stakeholderName ?? "Stakeholder";
  const base = workspace.href(`stakeholders/${stakeholderId}/preview`);
  return (
    <Page title={`Preview — ${name}`} crumbs={[["Stakeholders", workspace.href("stakeholders")], [name, workspace.href(`stakeholders/${stakeholderId}`)], ["Preview"]]}>
      {/* The server answers 404 when the stakeholder isn't one of this company's. */}
      <ResourceView resource={preview} notFound={PREVIEW_UNAVAILABLE} notFoundBack={{ to: workspace.href("stakeholders"), label: "Back to stakeholders" }}>
        {(data) => {
          const holdings = data.holdings.filter((holding) => holding.orgId === orgId && holding.stakeholderId === stakeholderId);
          return (
            <>
              <div className="preview-banner" role="note">
                <Icon name="eye" />
                <div>
                  You are previewing the portal as <b>{name}</b>. Every portal action is disabled.{" "}
                  <Link to={base}>Portfolio</Link> · <Link to={`${base}/how-to-exercise`}>How to exercise</Link> · <Link to={`${base}/documents`}>Documents</Link>
                </div>
              </div>
              <div className="preview-frame">
                <PortalFrame
                  scope={{
                    orgId,
                    orgName: holdings[0]?.orgDisplayName ?? workspace.name,
                    holdings: holdings.length ? holdings : [{ orgId, orgDisplayName: workspace.name, stakeholderId, stakeholderName: name, securities: [] }],
                    preview: { stakeholderName: name },
                    href: (path = "") => `${base}${path ? `/${path.replace(/^\//, "")}` : ""}`,
                    source,
                    howTo,
                  }}
                  today={data.asOf}
                >
                  <Outlet />
                </PortalFrame>
              </div>
            </>
          );
        }}
      </ResourceView>
    </Page>
  );
}

function PortalFrame({ scope, today, children }: { scope: PortalScope; today: string; children: ReactNode }) {
  const display = useMemo(() => portalDisplay(today), [today]);
  // In the preview the pages render outside the admin workspace, so nothing of the admin's shell leaks into them.
  return (
    <OutsideWorkspace>
      <PortalContext value={scope}>
        <DisplayContext value={display}>{children}</DisplayContext>
      </PortalContext>
    </OutsideWorkspace>
  );
}

/**
 * The portal answered 404 for a company the holder is matched in. It answers 404 to a caller it no longer serves,
 * so /api/me is read again first: when the match is gone, the portal guard sends the holder to the
 * no-access page; when it is still there, the server can't serve this page right now, which is no loss of access, so
 * the page says that and offers to try again instead of claiming the holder has no access.
 */
export function PortalNotServed({ what, onRetry }: { what: string; onRetry: () => void }) {
  const { refresh } = useAuth();
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let live = true;
    void refresh().finally(() => {
      if (live) setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [refresh]);
  if (!checked) return <Loading label="Checking your access…" />;
  return (
    <div className="card error-state" role="alert">
      <p className="b-title">{what} isn't available right now</p>
      <p>Your access hasn't changed, but Cap Table couldn't show this page. Try again in a moment; if it keeps happening, contact your company's equity team.</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Try again</button>
    </div>
  );
}
