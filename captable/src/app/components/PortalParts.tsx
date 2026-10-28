import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "#shared";
import { saveFile } from "../api/request.ts";
import { describeError, isApiError } from "../lib/errors.ts";
import type { Resource } from "../lib/useResource.ts";
import { formatDate, formatDaysLeft } from "../lib/format.ts";
import { SECURITY_STATUS_LABELS, SECURITY_STATUS_TONES, documentKindLabel } from "../lib/labels.ts";
import { useDocumentTitle } from "../lib/useDocumentTitle.ts";
import { useDisplay } from "./Display.tsx";
import { Badge, Pending, ResourceView } from "./Feedback.tsx";
import { Icon } from "./Icon.tsx";
import { Breadcrumbs } from "./Page.tsx";
import { PortalNotServed, usePortal } from "./PortalWorkspace.tsx";

// Pieces every portal page shares: the page frame with its breadcrumb, status badges, deadlines and the document list.

export function PortalPage({ title, crumb, children }: { title: string; crumb?: string; children: ReactNode }) {
  const portal = usePortal();
  useDocumentTitle(portal.preview ? `Preview — ${title}` : title);
  // Inside the admin preview the admin page already frames it: no second page padding.
  return (
    <section className={portal.preview ? "portal-page" : "page"}>
      {crumb ? <Breadcrumbs items={[[portal.orgName, portal.href()], [crumb]]} /> : null}
      {children}
      <PortalFooter />
    </section>
  );
}

export function StatusBadge({ status }: { status: api.PortalSecurity["status"] }) {
  return <Badge tone={SECURITY_STATUS_TONES[status]}>{SECURITY_STATUS_LABELS[status]}</Badge>;
}

/** "Feb 28, 2027 (130 days)", bold, with the time left counted from the org's today. */
export function Deadline({ date, note }: { date: string; note?: ReactNode }) {
  const { today } = useDisplay();
  return (
    <>
      <b>{formatDate(date)}</b> <span className="muted small">({formatDaysLeft(today, date)}){note ? <> {note}</> : null}</span>
    </>
  );
}

/** Saves one of the holder's documents through the audited portal download route; never rendered inline. */
function useDocumentDownload() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (document: api.PortalDocument) => {
    setBusy(document.id);
    setError(null);
    try {
      await saveFile(api.routes.downloadPortalDocument, { params: { id: document.id } }, document.filename);
    } catch (cause) {
      setError(`${document.filename}: ${describeError(cause)}`);
    } finally {
      setBusy(null);
    }
  };
  return { download, error, busy };
}

/**
 * A document as a download, named by its filename or by `label` (disabled in the admin preview, where every portal
 * action is).
 */
export function DocumentLink({ document, label, className = "btn-link" }: { document: api.PortalDocument; label?: string; className?: string }) {
  const { preview } = usePortal();
  const { download, error, busy } = useDocumentDownload();
  const name = label ?? document.filename;
  if (preview) return <span title="Disabled in the preview">{name}</span>;
  return (
    <>
      <button type="button" className={className} disabled={busy === document.id} onClick={() => void download(document)}>{name}</button>
      {error ? <span className="err-inline" role="alert"> {error}</span> : null}
    </>
  );
}

/** The company's designated privacy notice, once How to exercise (which names it) has loaded; else null. */
export function usePrivacyNotice(): api.PortalDocument | null {
  return usePortal().howTo.data?.privacyNotice ?? null;
}

/**
 * File cards: name, kind and date. The company's designated privacy notice comes first and
 * says so, so a holder looking for it under Documents finds it.
 */
export function DocumentCards({ documents, empty = "No documents." }: { documents: readonly api.PortalDocument[]; empty?: string }) {
  const { format } = useDisplay();
  const privacyNotice = usePrivacyNotice();
  if (documents.length === 0) return <p className="muted small">{empty}</p>;
  const isNotice = (document: api.PortalDocument) => document.id === privacyNotice?.id;
  const ordered = [...documents.filter(isNotice), ...documents.filter((document) => !isNotice(document))];
  return (
    <div className="stack-8">
      {ordered.map((document) => (
        <div className="attach" key={document.id}>
          <div className="a-n">
            <Icon name="file" />
            <DocumentLink document={document} />
            {isNotice(document) ? <Badge tone="teal">Privacy notice</Badge> : null}
          </div>
          <div className="a-m">{documentKindLabel(document.kind)} · {format.date(format.localDate(document.createdAt))}</div>
        </div>
      ))}
    </div>
  );
}

/** A link within the portal: to the holder's own page, or to the same page of the admin preview. */
export function PortalLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const { href } = usePortal();
  return <Link className={className} to={href(to)}>{children}</Link>;
}

/**
 * A resource of one of the holder's companies: its data, loading or error. A 404 is the portal saying it doesn't serve
 * the caller here: PortalNotServed checks /api/me before saying anything about access. In the admin
 * preview a 404 means the preview route didn't answer, which says nothing about access, so it is shown as such.
 */
export function PortalResourceView<T>({ resource, what, children }: { resource: Resource<T>; what: string; children: (data: T) => ReactNode }) {
  const portal = usePortal();
  if (resource.data === undefined && isApiError(resource.error, "not_found")) {
    if (!portal.preview) return <PortalNotServed what={what} onRetry={resource.reload} />;
    return (
      <div className="card error-state" role="alert">
        <p className="b-title">{what} isn't available in the preview right now</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={resource.reload}>Try again</button>
      </div>
    );
  }
  return <ResourceView resource={resource}>{children}</ResourceView>;
}

/** The company contact and the privacy notice link, at the bottom of every portal page. */
function PortalFooter() {
  const portal = usePortal();
  return (
    <footer className="portal-foot">
      <Icon name="mail" />
      <span>
        Questions about your equity?{" "}
        <Pending resource={portal.howTo} what="the company contact" inline>
          {({ companyContact: contact }) => (contact
            ? <>{contact.name} · <span className="email">{contact.email}</span></>
            : <>Contact {portal.orgName}'s equity team.</>)}
        </Pending>
      </span>
      <span className="spacer" />
      <PrivacyNotice />
    </footer>
  );
}

/**
 * Counsel's privacy notice (counsel provides the text), the company resource the org designates in
 * `settings.portal.privacyNoticeDocumentId`: it opens through the audited portal download route (in the preview, as
 * every document there, it is disabled). Until one is designated the footer says so; it never writes notice text.
 */
function PrivacyNotice() {
  const portal = usePortal();
  const { data } = portal.howTo;
  // Loading or failed: the company contact beside it already says so, and "not yet published" would be a guess.
  if (data === undefined) return null;
  if (data.privacyNotice === null) return <span className="muted small">Privacy notice not yet published</span>;
  return <DocumentLink document={data.privacyNotice} label="Privacy notice" className="btn-link privacy-link" />;
}
