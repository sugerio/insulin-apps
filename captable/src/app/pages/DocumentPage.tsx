import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { apiRequest } from "../api/request.ts";
import { ActionsMenu, OwnRecordScope, WriteButton } from "../components/Actions.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { DownloadError, linkHolderName, TargetLabelsState, useCanDownload, useDownload, useTargetLabels } from "../components/Documents.tsx";
import { Badge, Banner, Pending, ResourceView } from "../components/Feedback.tsx";
import {
  AddLinkDialog, ArchiveDocumentDialog, EditDocumentDialog, MoveDocumentDialog, NewVersionDialog, RevokeLinkDialog, VisibilityDialog,
} from "../components/flows/DocumentDialogs.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead, SectionTitle } from "../components/Page.tsx";
import { activeLinks, fileTypeLabel, LINK_ROLE_LABELS, linkedHolders, portalUseOf, TARGET_TYPE_LABELS, visibilityLabel, visibilityRule } from "../lib/documents.ts";
import { DASH, formatBytes } from "../lib/format.ts";
import { documentKindLabel } from "../lib/labels.ts";
import { useResource } from "../lib/useResource.ts";

// One document: its details, who sees it in the portal, its links (append-only;
// a link is revoked once, with a reason) and its versions. Owners and admins write; holder visibility follows the
// links: the linked holder's portal for one holder, nobody for several, and every holder for a company resource,
// published from the portal settings.

type Dialog =
  | { kind: "edit" } | { kind: "move" } | { kind: "link" } | { kind: "version" } | { kind: "archive" }
  | { kind: "visibility"; next: boolean; holderLabel: string }
  | { kind: "revoke"; link: api.DocumentLink; label: string };

export function DocumentPage() {
  const { orgId, href } = useWorkspace();
  const { documentId = "" } = useParams();
  const detail = useResource((signal) => apiRequest(api.routes.getDocument, { params: { orgId, id: documentId }, signal }), [orgId, documentId]);
  const [generation, setGeneration] = useState(0);
  const title = detail.data?.filename ?? "Document";
  return (
    <Page title={title} crumbs={[["Documents", href("documents")], [title]]}>
      <ResourceView resource={detail} notFound="This document does not exist." notFoundBack={{ to: href("documents"), label: "Back to Documents" }}>
        {(data) => <DocumentBody key={generation} document={data} onChanged={() => { setGeneration((value) => value + 1); detail.reload(); }} />}
      </ResourceView>
    </Page>
  );
}

function DocumentBody({ document, onChanged }: { document: api.DocumentDetail; onChanged: () => void }) {
  const workspace = useWorkspace();
  const { orgId, href, format, org } = workspace;
  const navigate = useNavigate();
  const labels = useTargetLabels(document.links.length > 0);
  // The folder's name, read only for a document filed in one (Move reads the folders itself).
  const collections = useResource((signal) => apiRequest(api.routes.listCollections, { params: { orgId }, signal }), [orgId], document.collectionId !== null);
  const canDownload = useCanDownload();
  const { download, error, busy } = useDownload();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const done = () => {
    close();
    onChanged();
  };
  const holders = linkedHolders(document, labels.holderOfSecurity);
  const rule = visibilityRule(holders);
  // A document about the admin's own holdings or record offers no write; until the holders of its
  // securities are known, a document linked to a security offers none either.
  const own = [...holders].some((holder) => workspace.isOwn(holder));
  const resolving = labels.loading && activeLinks(document).some((link) => link.targetType === "security");
  const archived = document.archivedAt !== null;

  const holderLink = activeLinks(document).find((link) => linkHolderName(labels, link) !== undefined);
  const holderLabel = holderLink ? linkHolderName(labels, holderLink)! : "the holder";
  const use = portalUseOf(org, document.id);
  const actions = own || resolving ? null : (
    <ActionsMenu
      items={[
        { label: "Edit details", icon: "edit", onSelect: () => setDialog({ kind: "edit" }) },
        { label: "Move to a folder", icon: "folder", onSelect: () => setDialog({ kind: "move" }) },
        { label: "Link to a record", icon: "plus", onSelect: () => setDialog({ kind: "link" }) },
        { label: "Upload new version", icon: "upload", onSelect: () => setDialog({ kind: "version" }) },
        "separator",
        { label: archived ? "Restore" : "Archive", icon: archived ? "refresh" : "x", danger: !archived, onSelect: () => setDialog({ kind: "archive" }) },
      ]}
    />
  );
  return (
    <OwnRecordScope own={own || resolving}>
      <Card>
        <PageHead
          title={document.filename}
          badges={
            <>
              <Badge tone="teal">{documentKindLabel(document.kind)}</Badge>
              {archived ? <Badge>Archived</Badge> : null}
              {document.importedFromPulley ? <Badge>{api.importSourceLabel(org.importSource)}</Badge> : null}
            </>
          }
          actions={
            <>
              {canDownload ? <Button type="button" variant="ghost" disabled={busy === document.id} onClick={() => void download(document.id, document.filename)}>Download</Button> : null}
              {actions}
            </>
          }
        />
        <DownloadError error={error} />
        {own && workspace.canWrite ? <Banner kind="info" title="About your own holdings">Admins never record writes on their own holdings — another admin must.</Banner> : null}
        {archived ? <Banner kind="info" title={`Archived on ${format.date(format.localDate(document.archivedAt!))}`}>It is out of the lists and the portal, and still stored with its checksum and links. Restore it to bring it back.</Banner> : null}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]">
          <div className="flex min-w-0 flex-col gap-3">
            <SectionTitle>Details</SectionTitle>
            <DescriptionList
              split
              rows={[
                ["Type", `${documentKindLabel(document.kind)} (${fileTypeLabel(document)})`],
                ["Description", document.description ?? DASH],
                ["Version label", document.versionLabel ?? DASH],
                ["Folder", document.collectionId ? (
                  <Pending resource={collections} what="the folder" inline>
                    {(data) => <Link className="font-medium underline-offset-4 hover:underline" to={`${href("documents")}?folder=${document.collectionId}`}>{data.items.find((folder) => folder.id === document.collectionId)?.name ?? "A folder"}</Link>}
                  </Pending>
                ) : "No folder"],
                ["Size", formatBytes(document.byteSize)],
                ["SHA-256", <span className="font-mono text-xs break-all">{document.sha256}</span>],
                ["Uploaded", `${format.dateTime(document.createdAt)}${document.importedFromPulley ? ` · ${api.importSourceLabel(org.importSource).toLowerCase()}` : document.uploadedBy ? ` by ${document.uploadedBy}` : ""}`],
                document.sourceCreatedAt !== null ? [`Created in ${api.importSourceName(org.importSource)}`, format.dateTime(document.sourceCreatedAt)] : null,
                document.supersedesDocumentId ? ["Supersedes", <Link to={href(`documents/${document.supersedesDocumentId}`)}>The previous version</Link>] : null,
              ]}
            />
            <SectionTitle>Links</SectionTitle>
            {document.links.length ? <TargetLabelsState labels={labels} /> : null}
            {document.links.length ? (
              <Table aria-label="Links">
                  <TableHeader><TableRow><TableHead scope="col">Record</TableHead><TableHead scope="col">Role</TableHead><TableHead scope="col">Added</TableHead><TableHead scope="col">Status</TableHead><TableHead scope="col"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
                  <TableBody>
                    {document.links.map((link) => {
                      const label = labels.label(link.targetType, link.targetId);
                      const to = labels.to(link.targetType, link.targetId);
                      return (
                        <TableRow key={link.id}>
                          <TableCell>{to ? <Link className="font-medium underline-offset-4 hover:underline" to={to}>{label}</Link> : label} <span className="text-xs text-muted-foreground">{TARGET_TYPE_LABELS[link.targetType]}</span></TableCell>
                          <TableCell>{LINK_ROLE_LABELS[link.role]}</TableCell>
                          <TableCell>{format.date(format.localDate(link.createdAt))}{link.createdBy ? <span className="text-xs text-muted-foreground"> · {link.createdBy}</span> : null}</TableCell>
                          <TableCell>
                            {link.revokedAt !== null ? <>Revoked on {format.date(format.localDate(link.revokedAt))}{link.revokeReason ? `: ${link.revokeReason}` : ""}</>
                              : "Active"}
                          </TableCell>
                          <TableCell className="text-right">
                            {link.revokedAt === null ? (
                              <WriteButton label="Revoke" size="xs" ariaLabel={`Revoke the link to ${label}`} onClick={() => setDialog({ kind: "revoke", link, label })} />
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
            ) : <p className="text-xs text-muted-foreground">Not linked to any record yet.</p>}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <SectionTitle>Visible in the portal</SectionTitle>
            <p className="text-sm font-semibold">{visibilityLabel(document)}</p>
            {archived ? <p className="text-xs text-muted-foreground">Archived documents aren't shown in the portal.</p> : null}
            {rule.kind === "holder" ? (
              <>
                <p className="text-xs">Linked to one holder: {holderLabel}. {document.holderVisible ? "They see it under Documents in their portal." : "Only admins see it now."}</p>
                <WriteButton label={document.holderVisible ? `Hide from ${holderLabel}` : `Show to ${holderLabel}`} size="sm"
                  onClick={() => setDialog({ kind: "visibility", next: !document.holderVisible, holderLabel })} />
              </>
            ) : rule.kind === "several" ? (
              <>
                <p className="text-xs">Linked to {rule.count} holders: a document linked to two or more holders is never shown in the portal.</p>
                {document.holderVisible ? <WriteButton label="Hide from the portal" size="sm" onClick={() => setDialog({ kind: "visibility", next: false, holderLabel: "the holders" })} /> : null}
              </>
            ) : (
              <p className="text-xs">
                No holder link{document.holderVisible && document.visibilityScope === "all_holders" ? ": a company resource every holder sees" : ""}{use ? `, used as ${use}` : ""}.{" "}
                Company resources are published from <Link className="font-medium underline underline-offset-4" to={href("stakeholder-portal")}>Stakeholder portal settings</Link>.
              </p>
            )}
            <SectionTitle>Versions</SectionTitle>
            {document.versions.length > 1 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {document.versions.map((version) => (
                  <li key={version.id}>
                    {version.id === document.id ? <b>This version</b> : <Link to={href(`documents/${version.id}`)}>{version.versionLabel ?? "Another version"}</Link>}
                    {version.versionLabel && version.id === document.id ? ` (${version.versionLabel})` : ""} <span className="text-xs text-muted-foreground">· {format.date(format.localDate(version.createdAt))}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-muted-foreground">Only this version. "Upload new version" keeps this one and its links.</p>}
          </div>
        </div>
      </Card>
      {dialog?.kind === "edit" ? <EditDocumentDialog document={document} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "move" ? <MoveDocumentDialog document={document} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "link" ? <AddLinkDialog document={document} holderOfSecurity={labels.holderOfSecurity} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "version" ? <NewVersionDialog document={document} onClose={close} onDone={(stored) => { close(); navigate(href(`documents/${stored.id}`)); }} /> : null}
      {dialog?.kind === "archive" ? <ArchiveDocumentDialog document={document} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "visibility" ? <VisibilityDialog document={document} next={dialog.next} scope="holder" holderLabel={dialog.holderLabel} onClose={close} onDone={done} /> : null}
      {dialog?.kind === "revoke" ? <RevokeLinkDialog document={document} link={dialog.link} targetLabel={dialog.label} onClose={close} onDone={done} /> : null}
    </OwnRecordScope>
  );
}
