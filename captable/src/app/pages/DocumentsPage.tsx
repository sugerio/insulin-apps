import { useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { WriteButton } from "../components/Actions.tsx";
import { DataTable, byNumber, byText, type Column } from "../components/DataTable.tsx";
import { DownloadError, TargetLabelsState, useAllDocuments, useCanDownload, useDownload, useTargetLabels, type TargetLabels } from "../components/Documents.tsx";
import { Badge, Banner, InlineError } from "../components/Feedback.tsx";
import { CreateFolderDialog, EditFolderDialog, UploadDocumentDialog } from "../components/flows/DocumentDialogs.tsx";
import { Icon } from "../components/Icon.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { activeLinks, fileTypeLabel, isPublishedResource, kindOptions, visibilityLabel } from "../lib/documents.ts";
import { DASH } from "../lib/format.ts";
import { documentKindLabel } from "../lib/labels.ts";
import { useCursorPages } from "../lib/useCursorPages.ts";
import { useResource } from "../lib/useResource.ts";

// Documents: folders on the left, the documents on the right, newest
// first, page by page. "All documents", a folder (Your documents, or a migrated template group) and a type filter are
// the server's own filters; Company resources (every holder sees them) are found among all documents. Upload, Create
// folder and the folder's Rename and Archive are owners' and admins'; each document opens its page, where it is
// edited, linked, versioned and shown to its holder. Nothing is ever deleted in the app.

type Dialog = { kind: "upload" } | { kind: "folder" } | { kind: "rename"; folder: api.DocumentCollection } | { kind: "archiveFolder"; folder: api.DocumentCollection };

const ALL = "all";
const RESOURCES = "resources";

function importedFolderDescription(source: api.ImportSource | null | undefined): string {
  if (source === "pulley") return "migrated from Pulley";
  if (source === "template") return "imported from the spreadsheet";
  return "imported";
}

export function DocumentsPage() {
  const { orgId, href, org } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get("folder") ?? ALL;
  const kind = params.get("kind") ?? "";
  const archived = params.get("archived") === "1";
  const collections = useResource((signal) => apiRequest(api.routes.listCollections, { params: { orgId }, signal }), [orgId]);
  const labels = useTargetLabels();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [generation, setGeneration] = useState(0);
  const close = () => setDialog(null);
  const changed = () => {
    setGeneration((value) => value + 1);
    collections.reload();
  };
  const go = (next: Record<string, string | null>) => {
    const search = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") search.delete(key);
      else search.set(key, value);
    }
    setParams(search);
  };
  const folders = collections.data?.items ?? [];
  const folder = folders.find((item) => item.id === view) ?? null;
  const own = folders.filter((item) => item.kind === "FOLDER" && (archived || item.archivedAt === null || item.id === view));
  const groups = folders.filter((item) => item.kind === "TEMPLATE_GROUP");
  const editable = folder !== null && folder.kind === "FOLDER" && folder.source === "app";
  const folderLink = (id: string, label: ReactNode, icon: "folder" | "users" = "folder") => (
    <Link key={id} to={`${href("documents")}?folder=${encodeURIComponent(id)}${archived ? "&archived=1" : ""}`} className={view === id ? "active" : undefined} aria-current={view === id ? "page" : undefined}>
      <Icon name={icon} /> {label}
    </Link>
  );
  const heading = view === RESOURCES ? "Company resources" : view === ALL ? "All documents" : folder?.name ?? "Folder";
  return (
    <Page title="Documents" crumbs={[["Company", href("company")], ["Documents"]]}>
      <Card>
        <PageHead
          title="Documents"
          sub="Stored with SHA-256 checksums and versions; nothing is deleted in the app."
          actions={
            <>
              <WriteButton label="Create folder" size="sm" onClick={() => setDialog({ kind: "folder" })} />
              <WriteButton label="Upload" icon="upload" kind="secondary" onClick={() => setDialog({ kind: "upload" })} />
            </>
          }
        />
        <div className="split-pane">
          <nav className="folder-list" aria-label="Folders">
            {folderLink(ALL, "All documents")}
            <div className="menu-label">Portal</div>
            {folderLink(RESOURCES, "Company resources", "users")}
            <div className="menu-label">Your documents</div>
            {collections.error !== undefined ? <InlineError what="the folders" error={collections.error} onRetry={collections.reload} inline />
              : !collections.data ? <p className="muted small" role="status" style={{ padding: "0 10px" }}>Loading the folders…</p> : null}
            {own.map((item) => folderLink(item.id, <>{item.name}{item.archivedAt !== null ? <> <Badge>Archived</Badge></> : null}</>))}
            {collections.data && !own.length ? <p className="small muted" style={{ padding: "0 10px" }}>No folders yet.</p> : null}
            {groups.length ? <div className="menu-label">Migrated templates</div> : null}
            {groups.map((item) => folderLink(item.id, item.name))}
          </nav>
          <div>
            <div className="card-h">
              <h2>{heading}</h2>
              {editable ? (
                <div className="row">
                  <WriteButton label="Rename" size="sm" ariaLabel={`Rename the folder ${folder.name}`} onClick={() => setDialog({ kind: "rename", folder })} />
                  <WriteButton label={folder.archivedAt === null ? "Archive" : "Restore"} size="sm" ariaLabel={`${folder.archivedAt === null ? "Archive" : "Restore"} the folder ${folder.name}`} onClick={() => setDialog({ kind: "archiveFolder", folder })} />
                </div>
              ) : null}
            </div>
            <TargetLabelsState labels={labels} />
            {folder && !editable ? <p className="small muted">{folder.kind === "TEMPLATE_GROUP"
              ? `A template group ${importedFolderDescription(org.importSource)}: read-only.`
              : `${importedFolderDescription(org.importSource).replace(/^./, (letter) => letter.toUpperCase())}: read-only.`}</p> : null}
            {view === RESOURCES ? (
              <ResourcesView key={generation} labels={labels} />
            ) : (
              <>
                <div className="row mb-8">
                  <label className="row small nowrap">
                    Type{" "}
                    <select className="inp" style={{ height: 32 }} aria-label="Filter by type" value={kind} onChange={(event) => go({ kind: event.target.value })}>
                      <option value="">All types</option>
                      {kindOptions().map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label className="row small nowrap"><input type="checkbox" className="cb" checked={archived} onChange={(event) => go({ archived: event.target.checked ? "1" : null })} /> Show archived</label>
                </div>
                <DocumentList key={`${view}|${kind}|${archived}|${generation}`} collectionId={view === ALL ? undefined : view} kind={kind || undefined} includeArchived={archived} labels={labels} />
              </>
            )}
            <p className="small muted mt-8">
              Holder visibility is set per document, on its page: on for the holder's own agreements, notices of exercise and certificates; off for everything else. A document linked to two or more holders is never shown in the portal.
            </p>
          </div>
        </div>
      </Card>
      {dialog?.kind === "upload" ? (
        <UploadDocumentDialog folders={folders} defaultFolderId={folder?.kind === "FOLDER" && folder.archivedAt === null ? folder.id : null} onClose={close}
          onDone={(stored) => { close(); changed(); navigate(href(`documents/${stored.id}`)); }} />
      ) : null}
      {dialog?.kind === "folder" ? (
        <CreateFolderDialog parent={editable && folder.archivedAt === null ? folder : null} onClose={close}
          onDone={(created) => { close(); changed(); go({ folder: created.id }); }} />
      ) : null}
      {dialog?.kind === "rename" ? <EditFolderDialog folder={dialog.folder} archive={false} onClose={close} onDone={() => { close(); changed(); }} /> : null}
      {dialog?.kind === "archiveFolder" ? <EditFolderDialog folder={dialog.folder} archive onClose={close} onDone={() => { close(); changed(); }} /> : null}
    </Page>
  );
}

/** The documents table: shared by a folder's pages and Company resources. */
function DocumentTable({ id, label, rows, labels, empty }: { id: string; label: string; rows: readonly api.Document[]; labels: TargetLabels; empty: ReactNode }) {
  const { href, format, org } = useWorkspace();
  const canDownload = useCanDownload();
  const { download, error, busy } = useDownload();
  const columns: Column<api.Document>[] = [
    {
      key: "name", label: "Name", className: "wrap", compare: byText((row) => row.filename),
      render: (row) => (
        <>
          <Icon name="file" /> <Link className="cell-link" to={href(`documents/${row.id}`)}>{row.filename}</Link>
          {row.archivedAt !== null ? <> <Badge>Archived</Badge></> : null}
          {row.description ? <div className="small muted">{row.description}</div> : null}
        </>
      ),
    },
    {
      key: "linked", label: "Linked to", className: "wrap",
      render: (row) => {
        const links = activeLinks(row);
        if (!links.length) return DASH;
        return links.slice(0, 2).map((link, index) => {
          const to = labels.to(link.targetType, link.targetId);
          const text = labels.label(link.targetType, link.targetId);
          return <span key={link.id}>{index ? ", " : ""}{to ? <Link to={to}>{text}</Link> : text}</span>;
        }).concat(links.length > 2 ? [<span key="more" className="small muted"> +{links.length - 2} more</span>] : []);
      },
    },
    { key: "type", label: "Type", render: (row) => <>{documentKindLabel(row.kind)} <span className="small muted">{fileTypeLabel(row)}</span></>, compare: byText((row) => documentKindLabel(row.kind)) },
    { key: "by", label: "Uploaded by", render: (row) => (row.importedFromPulley ? api.importSourceLabel(org.importSource) : row.uploadedBy ?? DASH) },
    { key: "on", label: "Uploaded on", render: (row) => format.date(format.localDate(row.createdAt)), compare: byNumber((row) => row.createdAt) },
    { key: "visible", label: "Visible to", render: (row) => visibilityLabel(row) },
    ...(canDownload ? [{
      key: "download", label: "", locked: true,
      render: (row: api.Document) => (
        <button type="button" className="btn btn-ghost btn-xs" disabled={busy === row.id} onClick={() => void download(row.id, row.filename)}>
          Download <span className="sr-only">{row.filename}</span>
        </button>
      ),
    }] : []),
  ];
  return (
    <>
      <DataTable id={id} label={label} rows={rows} rowKey={(row) => row.id} columns={columns} defaultSort={["on", "desc"]}
        search={(row) => `${row.filename} ${row.description ?? ""} ${activeLinks(row).map((link) => labels.label(link.targetType, link.targetId)).join(" ")}`}
        searchPlaceholder="Search the loaded documents…" empty={empty} />
      <DownloadError error={error} />
    </>
  );
}

/** One folder (or all documents), newest first, page by page from the server. */
function DocumentList({ collectionId, kind, includeArchived, labels }: { collectionId?: string; kind?: string; includeArchived: boolean; labels: TargetLabels }) {
  const { orgId } = useWorkspace();
  const pages = useCursorPages(
    (cursor, signal) => apiRequest(api.routes.listDocuments, {
      params: { orgId },
      query: { limit: 100, ...(cursor ? { cursor } : {}), ...(collectionId ? { collectionId } : {}), ...(kind ? { kind: kind as api.DocumentKind } : {}), ...(includeArchived ? { includeArchived: "true" } : {}) },
      signal,
    }),
    (item) => item.id,
  );
  if (!pages.loaded && pages.error !== undefined) return <InlineError what="the documents" error={pages.error} onRetry={pages.reload} />;
  if (!pages.loaded) return <p className="muted small" role="status">Loading documents…</p>;
  return (
    <>
      <DocumentTable id="documents" label="Documents" rows={pages.items} labels={labels} empty={kind ? "No documents of this type here." : "No documents here yet."} />
      {pages.nextCursor !== null ? (
        <div className="row mt-8">
          <button type="button" className="btn btn-ghost btn-sm" disabled={pages.loadingMore} onClick={() => void pages.loadMore()}>{pages.loadingMore ? "Loading…" : "Load more documents"}</button>
        </div>
      ) : null}
      {pages.moreError !== undefined ? <InlineError what="the next documents" error={pages.moreError} onRetry={() => void pages.loadMore()} /> : null}
    </>
  );
}

/** Company resources: published, unarchived documents with no holder link, which every holder sees. */
function ResourcesView({ labels }: { labels: TargetLabels }) {
  const { href } = useWorkspace();
  const all = useAllDocuments();
  if (all.data === undefined && all.error !== undefined) return <InlineError what="the documents" error={all.error} onRetry={all.reload} />;
  if (all.data === undefined) return <p className="muted small" role="status">Loading the company resources…</p>;
  return (
    <>
      <Banner kind="info" title="Every holder sees these in their portal">
        Publish a document, or stop showing one, from <Link to={href("stakeholder-portal")}>Stakeholder portal settings</Link>.
      </Banner>
      <DocumentTable id="documents-resources" label="Company resources" rows={all.data.filter(isPublishedResource)} labels={labels} empty="No company resources are published." />
    </>
  );
}
