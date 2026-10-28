import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "#shared";
import { saveFile } from "../api/request.ts";
import { describeError } from "../lib/errors.ts";
import { HOLDER_TARGETS, TARGET_TYPE_LABELS } from "../lib/documents.ts";
import { documentKindLabel } from "../lib/labels.ts";
import { useResource } from "../lib/useResource.ts";
import { apiRequest } from "../api/request.ts";
import { WriteButton } from "./Actions.tsx";
import { InlineError } from "./Feedback.tsx";
import { Icon } from "./Icon.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";
import { UploadDocumentDialog, type LinkIntent } from "./flows/DocumentDialogs.tsx";

// Documents linked to a record and the Attachments card of detail pages. Downloads go through the
// server's audited download route, which also counts as an export for read-only admins; read-only admins
// without PII access can't download (403 pii_access_required), so they aren't offered it. Each document opens its own
// page (Documents › the document), where its details, links, versions and visibility are managed.

/** Whether the admin may download documents: everyone but read-only admins without PII access. */
export function useCanDownload(): boolean {
  const { readOnly, canSeePii } = useWorkspace();
  return !readOnly || canSeePii;
}

export function useDownload() {
  const { orgId } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (id: string, filename: string) => {
    setBusy(id);
    setError(null);
    try {
      await saveFile(api.routes.downloadDocument, { params: { orgId, id } }, filename);
    } catch (cause) {
      setError(`${filename}: ${describeError(cause)}`);
    } finally {
      setBusy(null);
    }
  };
  return { download, error, busy };
}

export function DownloadError({ error }: { error: string | null }) {
  return error ? <p className="err-inline" role="alert">{error}</p> : null;
}

/** Every document, 200 at a time, for what the list can't filter on the server: company resources and their pickers. */
export function useAllDocuments(includeArchived = false) {
  const { orgId } = useWorkspace();
  return useResource(async (signal) => {
    const items: api.Document[] = [];
    let cursor: string | undefined;
    do {
      const page = await apiRequest(api.routes.listDocuments, {
        params: { orgId },
        query: { limit: 200, ...(cursor ? { cursor } : {}), ...(includeArchived ? { includeArchived: "true" } : {}) },
        signal,
      });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }, [orgId, includeArchived]);
}

export interface TargetLabels {
  /** What a link points at, in words: "OPT-1 · Daniel Achterberg", a holder's or a plan's name; the type while unknown. */
  label: (type: api.LinkTargetType, id: string) => string;
  /** The record's page in the workspace, if it has one. */
  to: (type: api.LinkTargetType, id: string) => string | null;
  /** The holder of a security, once the securities are read. */
  holderOfSecurity: (securityId: string) => string | undefined;
  /** A stakeholder's name, once the stakeholders are read. */
  holderName: (stakeholderId: string) => string | undefined;
  /** The lists are still being read. */
  loading: boolean;
  /** A list that couldn't be read (its links are named by their type), or undefined. */
  failure: unknown;
  reload: () => void;
}

/**
 * The names behind document links, read once for a page (`enabled` false when there is nothing to name): each list
 * that fails leaves its links named by type, and TargetLabelsState says so.
 */
export function useTargetLabels(enabled = true): TargetLabels {
  const { orgId, href } = useWorkspace();
  const lists = useResource(async (signal) => {
    const settled = await Promise.allSettled([
      apiRequest(api.routes.listSecurities, { params: { orgId }, signal }),
      apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }),
      apiRequest(api.routes.listStockPlans, { params: { orgId }, signal }),
      apiRequest(api.routes.listStockClasses, { params: { orgId }, signal }),
      apiRequest(api.routes.listValuations, { params: { orgId }, signal }),
    ]);
    const [securities, stakeholders, plans, classes, valuations] = settled.map((result) => (result.status === "fulfilled" ? result.value.items : [])) as [
      api.Security[], api.Stakeholder[], api.StockPlan[], api.StockClass[], api.Valuation[],
    ];
    const failure: unknown = settled.find((result) => result.status === "rejected")?.reason;
    return { securities, stakeholders, plans, classes, valuations, failure };
  }, [orgId], enabled);
  return useMemo(() => {
    const data = lists.data;
    const securities = new Map((data?.securities ?? []).map((item) => [item.id, item]));
    const names = new Map<string, string>([
      ...(data?.stakeholders ?? []).map((item) => [item.id, item.displayName] as const),
      ...(data?.plans ?? []).map((item) => [item.id, item.name] as const),
      ...(data?.classes ?? []).map((item) => [item.id, item.name] as const),
      ...(data?.valuations ?? []).map((item) => [item.id, item.name] as const),
    ]);
    const holders = new Map((data?.stakeholders ?? []).map((item) => [item.id, item.displayName]));
    const PAGES: Partial<Record<api.LinkTargetType, string>> = {
      security: "securities", stakeholder: "stakeholders", stock_plan: "equity-plans", stock_class: "share-classes", valuation: "compliance/409a", exercise_request: "exercise-requests",
    };
    return {
      label: (type, id) => {
        if (type === "security") {
          const security = securities.get(id);
          return security ? `${security.displayId} · ${security.stakeholderName}` : TARGET_TYPE_LABELS.security;
        }
        // A transaction has no name or page of its own: its short id tells two apart.
        if (type === "transaction") return `Transaction ${id.slice(0, 8)}`;
        return names.get(id) ?? TARGET_TYPE_LABELS[type];
      },
      to: (type, id) => (PAGES[type] ? href(`${PAGES[type]}/${id}`) : null),
      holderOfSecurity: (securityId) => securities.get(securityId)?.stakeholderId,
      holderName: (stakeholderId) => holders.get(stakeholderId),
      loading: lists.loading,
      failure: data?.failure ?? lists.error,
      reload: lists.reload,
    } satisfies TargetLabels;
  }, [lists.data, lists.error, lists.loading, lists.reload, href]);
}

/** Says when the names behind links are still loading, or couldn't all be read (those links show their type). */
export function TargetLabelsState({ labels }: { labels: TargetLabels }) {
  if (labels.loading) return <p className="muted small" role="status">Loading the names of the linked records…</p>;
  if (labels.failure !== undefined) return <InlineError what="the names of some linked records (they show their type)" error={labels.failure} onRetry={labels.reload} />;
  return null;
}

/** The holder a link resolves to, as a name, when the browser knows it. */
export function linkHolderName(labels: TargetLabels, link: Pick<api.DocumentLink, "targetType" | "targetId">): string | undefined {
  if (!HOLDER_TARGETS.has(link.targetType)) return undefined;
  if (link.targetType === "stakeholder") return labels.holderName(link.targetId);
  if (link.targetType === "security") {
    const holder = labels.holderOfSecurity(link.targetId);
    return holder ? labels.holderName(holder) : undefined;
  }
  return undefined;
}

/** The documents linked to one record, newest first, from `GET …/documents?targetType=&targetId=`. */
export function LinkedDocuments({ targetType, targetId, showVisibility = false, limit = 50 }: { targetType: api.LinkTargetType; targetId: string; showVisibility?: boolean; limit?: number }) {
  const { orgId, format, href, org } = useWorkspace();
  const canDownload = useCanDownload();
  const resource = useResource(
    (signal) => apiRequest(api.routes.listDocuments, { params: { orgId }, query: { targetType, targetId, limit }, signal }),
    [orgId, targetType, targetId, limit],
  );
  const { download, error, busy } = useDownload();
  if (!resource.data && resource.error !== undefined) return <InlineError what="the documents" error={resource.error} onRetry={resource.reload} />;
  if (!resource.data) return <p className="muted small" role="status">Loading documents…</p>;
  const documents = resource.data.items.filter((document) => document.archivedAt === null);
  if (documents.length === 0) return <p className="muted small">No documents.</p>;
  return (
    <>
      <div className="tbl-scroll">
        <table className="tbl" aria-label="Documents">
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Uploaded on</th>
              <th scope="col">Uploaded by</th>
              {showVisibility ? <th scope="col">Visible to holder</th> : null}
              {canDownload ? <th scope="col"><span className="sr-only">Download</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => (
              <tr key={document.id}>
                <td><Icon name="file" /> <Link to={href(`documents/${document.id}`)}>{document.filename}</Link></td>
                <td>{format.date(format.localDate(document.createdAt))}</td>
                <td>{document.importedFromPulley ? api.importSourceLabel(org.importSource) : document.uploadedBy ?? "—"}</td>
                {showVisibility ? <td>{document.holderVisible ? "Yes" : "No"}</td> : null}
                {canDownload ? (
                  <td className="right">
                    <button type="button" className="btn btn-ghost btn-xs" disabled={busy === document.id} onClick={() => void download(document.id, document.filename)}>
                      Download <span className="sr-only">{document.filename}</span>
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DownloadError error={error} />
    </>
  );
}

/**
 * The right column's Attachments card: file cards from the record's own document references, and Upload. Upload is a
 * write: it is hidden from read-only admins and on an admin's own holdings (OwnRecordScope), and left out entirely
 * where nothing may be attached (migrated history: `upload={false}`). It stores the file and links it to the record.
 */
export function Attachments({ documents, upload = true, link, onUploaded }: { documents: readonly api.DocumentRef[]; upload?: boolean; link?: LinkIntent; onUploaded?: () => void }) {
  const { href } = useWorkspace();
  const canDownload = useCanDownload();
  const { download, error, busy } = useDownload();
  const [open, setOpen] = useState(false);
  return (
    <>
      {documents.length ? (
        documents.map((document) => (
          <div className="attach" key={document.id}>
            <div className="a-n">
              <Icon name="file" />
              {canDownload ? (
                <button type="button" className="btn-link" disabled={busy === document.id} onClick={() => void download(document.id, document.filename)}>
                  {document.filename}
                </button>
              ) : <span>{document.filename}</span>}
            </div>
            <div className="a-m">{documentKindLabel(document.kind)} · <Link to={href(`documents/${document.id}`)}>Details<span className="sr-only"> of {document.filename}</span></Link></div>
          </div>
        ))
      ) : (
        <p className="muted small">No attachments.</p>
      )}
      <DownloadError error={error} />
      {upload && link ? (
        <div className="row mt-8">
          <WriteButton label="Upload" icon="upload" size="sm" ariaLabel={`Upload a document for ${link.label}`} onClick={() => setOpen(true)} />
        </div>
      ) : null}
      {open && link ? <UploadDocumentDialog link={link} title={`Upload a document for ${link.label}`} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onUploaded?.(); }} /> : null}
    </>
  );
}
