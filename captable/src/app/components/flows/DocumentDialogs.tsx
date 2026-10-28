import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import {
  activeLinks, HOLDER_TARGETS, kindOptions, LINK_ROLE_LABELS, linkedHolders, PICKABLE_TARGETS, portalUseOf, TARGET_TYPE_LABELS,
} from "../../lib/documents.ts";
import { fieldProblem, useWriteFlow } from "../../lib/flow.ts";
import { formatDate } from "../../lib/format.ts";
import { documentKindLabel } from "../../lib/labels.ts";
import { useResource } from "../../lib/useResource.ts";
import { DismissButton, Modal } from "../Dialog.tsx";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { ErrorFocus } from "../ErrorFocus.tsx";
import { InlineError } from "../Feedback.tsx";
import { SelectField, TextAreaField, TextField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// The document writes, owners and admins: details, the folder, links, new
// versions and archiving. Each write sends the version it read and is reviewed first; a lost answer is settled by
// reading the document again. Who sees a document in the portal: the one holder it is linked to (admins show or hide
// it), every holder for a company resource (published from the portal settings), nobody when two or more holders are
// linked.

/** After a lost answer: a recorded write moves the document's version on. */
async function documentUnchanged(orgId: string, id: string, version: number): Promise<"not_recorded" | "unknown"> {
  return (await apiRequest(api.routes.getDocument, { params: { orgId, id } })).version === version ? "not_recorded" : "unknown";
}

/** A version read again after a stale answer; the dialog rebuilds its request from it. */
function useDocumentVersion(document: api.Document) {
  const { orgId } = useWorkspace();
  const [version, setVersion] = useState(document.version);
  const refresh = async () => setVersion((await apiRequest(api.routes.getDocument, { params: { orgId, id: document.id } })).version);
  return { version, refresh };
}

/** What a record's Upload links the stored file to. */
export interface LinkIntent {
  target: api.LinkTarget;
  /** What the record is called, e.g. "OPT-1" or a holder's name. */
  label: string;
  roles: readonly api.DocumentLinkRole[];
  defaultRole: api.DocumentLinkRole;
  /** The type the upload starts with, e.g. a grant agreement for an option. */
  defaultKind?: api.DocumentKind;
  /** The one holder the record resolves to (a security's holder, the stakeholder), named in the dialog's words. */
  holderLabel?: string;
}

/** Every link role, in the contract's order. */
export const ALL_LINK_ROLES = Object.keys(LINK_ROLE_LABELS) as api.DocumentLinkRole[];

const SECURITY_AGREEMENTS: Record<api.SecurityFamily, api.DocumentKind> = {
  EQUITY_COMPENSATION: "GRANT_AGREEMENT", STOCK: "STOCK_PURCHASE_AGREEMENT", WARRANT: "WARRANT_AGREEMENT", CONVERTIBLE: "SAFE_AGREEMENT",
};

/** Upload for a security: its agreement by default, shown to its holder (the default for agreements). */
export function securityLinkIntent(security: Pick<api.Security, "id" | "displayId" | "family" | "stakeholderName">): LinkIntent {
  return {
    target: { type: "security", id: security.id }, label: security.displayId, roles: ALL_LINK_ROLES, defaultRole: "AGREEMENT",
    defaultKind: SECURITY_AGREEMENTS[security.family], holderLabel: security.stakeholderName,
  };
}

/** Upload for a stakeholder: an attachment by default. */
export function stakeholderLinkIntent(stakeholder: Pick<api.Stakeholder, "id" | "displayName">): LinkIntent {
  return { target: { type: "stakeholder", id: stakeholder.id }, label: stakeholder.displayName, roles: ALL_LINK_ROLES, defaultRole: "ATTACHMENT", defaultKind: "OTHER", holderLabel: stakeholder.displayName };
}

/** Upload for a 409A valuation: its report by default (no holder: admins only). */
export function valuationLinkIntent(valuation: Pick<api.Valuation, "id" | "name">): LinkIntent {
  return { target: { type: "valuation", id: valuation.id }, label: valuation.name, roles: ALL_LINK_ROLES, defaultRole: "REPORT", defaultKind: "VALUATION_REPORT" };
}

interface UploadDialogProps {
  title?: string;
  folders?: readonly api.DocumentCollection[];
  defaultFolderId?: string | null;
  defaultKind?: api.DocumentKind;
  /** Upload for a record: the stored document is then linked to it (a second, reviewed write). */
  link?: LinkIntent;
  onClose: () => void;
  onDone: (document: UploadedDocument) => void;
}

/**
 * "Upload": the type, the folder and, for a record, the link role are chosen; then the file, whose upload is reviewed
 * as exactly what it sends (DocumentUpload) and stored with one key. A record's link travels in the same request (the
 * contract's X-Link-Target, X-Link-Id and X-Link-Role), so the document and its link are recorded together and the
 * server applies the holder's default visibility (agreements, notices of exercise and certificates are shown to the
 * holder they are linked to). Choosing another type, folder or role after the review drops it: the upload is reviewed
 * again before it is sent.
 */
export function UploadDocumentDialog({ title = "Upload a document", folders = [], defaultFolderId = null, defaultKind, link, onClose, onDone }: UploadDialogProps) {
  const toast = useToast();
  const [kind, setKind] = useState<api.DocumentKind>(defaultKind ?? link?.defaultKind ?? "OTHER");
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? "");
  const [role, setRole] = useState<api.DocumentLinkRole>(link?.defaultRole ?? "ATTACHMENT");
  const [stored, setStored] = useState<api.Document | null>(null);
  const done = (document: api.Document) => {
    toast({ message: link ? `${document.filename} uploaded and linked to ${link.label}${document.holderVisible ? ` — visible to ${link.holderLabel ?? "the holder"}` : ""}` : `${document.filename} uploaded` });
    onDone({ id: document.id, filename: document.filename, byteSize: document.byteSize, sha256: document.sha256 });
  };
  // Once stored, the upload is recorded: closing the dialog any way reports it as Done does, so the page shows it.
  const close = stored ? () => done(stored) : onClose;
  return (
    <Modal title={title} onClose={close} footer={<>
      {stored ? null : <DismissButton onClick={onClose}>Cancel</DismissButton>}
      <button type="button" className="btn btn-primary" disabled={!stored} onClick={() => done(stored!)}>Done</button>
    </>}>
      <ErrorFocus>
        <div className="form">
          <div className="form-grid">
            <SelectField label="Type" value={kind} onChange={(value) => setKind(value as api.DocumentKind)} options={kindOptions()} disabled={stored !== null} />
            {folders.length ? (
              <SelectField label="Folder" value={folderId} onChange={setFolderId} disabled={stored !== null}
                options={[["", "No folder"], ...folders.filter((folder) => folder.kind === "FOLDER" && folder.archivedAt === null).map((folder) => [folder.id, folder.name] as const)]} />
            ) : null}
            {link ? <SelectField label={`Link to ${link.label} as`} value={role} onChange={(value) => setRole(value as api.DocumentLinkRole)} disabled={stored !== null} options={link.roles.map((item) => [item, LINK_ROLE_LABELS[item]] as const)} /> : null}
          </div>
          <DocumentUpload label="File" kind={kind} required value={stored ? { id: stored.id, filename: stored.filename, byteSize: stored.byteSize, sha256: stored.sha256 } : null}
            collectionId={folderId || null} link={link ? { target: link.target, role, label: link.label } : undefined}
            onChange={(document) => { if (!document) setStored(null); }} onStored={setStored} />
          <p className="small muted">
            The type and folder go with the file; the type can be changed later.
            {link ? <> It is linked to <b>{link.label}</b> in the same request{link.holderLabel ? ", and agreements, notices of exercise and certificates are shown to the holder" : ""}.</> : null}
          </p>
        </div>
      </ErrorFocus>
    </Modal>
  );
}

interface DocumentDialogProps {
  document: api.Document;
  onClose: () => void;
  onDone: (document: api.Document) => void;
}

const DETAIL_LABELS: Record<string, string> = { filename: "the name", kind: "the type", description: "the description", versionLabel: "the version label" };

/** "Edit details": the name, type, description and version label. */
export function EditDocumentDialog({ document, onClose, onDone }: DocumentDialogProps) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const current = useDocumentVersion(document);
  const [filename, setFilename] = useState(document.filename);
  const [kind, setKind] = useState<api.DocumentKind>(document.kind);
  const [description, setDescription] = useState(document.description ?? "");
  const [versionLabel, setVersionLabel] = useState(document.versionLabel ?? "");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const request = (): api.PatchDocumentRequestInput => ({
    version: current.version,
    ...(filename.trim() !== document.filename ? { filename: filename.trim() } : {}),
    ...(kind !== document.kind ? { kind } : {}),
    ...(description.trim() !== (document.description ?? "") ? { description: description.trim() || null } : {}),
    ...(versionLabel.trim() !== (document.versionLabel ?? "") ? { versionLabel: versionLabel.trim() || null } : {}),
  });
  const flow = useWriteFlow({
    request,
    preview: null,
    body: ({ request: frozen }) => frozen,
    send: (body, key) => apiRequest(api.routes.patchDocument, { params: { orgId, id: document.id }, body, idempotencyKey: key }),
    refresh: current.refresh,
    reconcile: ({ request: frozen }) => documentUnchanged(orgId, document.id, frozen.version),
    fields: { issue: (path) => (["filename", "kind", "description", "versionLabel"].includes(path) ? path : null) },
    onCommitted: (updated) => {
      toast({ message: "Document details saved" });
      onDone(updated);
    },
  });
  const set = (key: string, apply: () => void) => {
    apply();
    setErrors((previous) => ({ ...previous, [key]: undefined }));
  };
  const review = () => {
    const found: Record<string, string> = {};
    if (!filename.trim()) found.filename = "Enter the file name.";
    else if (filename.trim().length > 255) found.filename = "At most 255 characters.";
    if (description.trim().length > 2000) found.description = "At most 2,000 characters.";
    if (versionLabel.trim().length > 40) found.versionLabel = "At most 40 characters.";
    if (!Object.keys(found).length && Object.keys(request()).length === 1) found.filename = "Nothing has changed.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  const changes = flow.request ? Object.keys(flow.request).filter((key) => key !== "version").map((key) => DETAIL_LABELS[key]) : [];
  return (
    <FlowDialog title="Edit document details" flow={flow as never} onClose={onClose} onReview={review} confirmLabel="Save details"
      review={<div className="review-panel" aria-label="Review"><p>Save {changes.join(", ")} of <b>{document.filename}</b>.</p></div>}>
      <TextField label="File name" required value={filename} onChange={(value) => set("filename", () => setFilename(value))} error={errorOf("filename")} />
      <SelectField label="Type" value={kind} onChange={(value) => setKind(value as api.DocumentKind)} options={kindOptions()} error={errorOf("kind")} />
      <TextAreaField label="Description" value={description} onChange={(value) => set("description", () => setDescription(value))} error={errorOf("description")} />
      <TextField label="Version label" value={versionLabel} onChange={(value) => set("versionLabel", () => setVersionLabel(value))} placeholder="e.g. Executed" error={errorOf("versionLabel")} />
    </FlowDialog>
  );
}

/** "Move" (any time): the folder it is filed in. */
export function MoveDocumentDialog({ document, onClose, onDone }: DocumentDialogProps) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const current = useDocumentVersion(document);
  const collections = useResource((signal) => apiRequest(api.routes.listCollections, { params: { orgId }, signal }), [orgId]);
  const folders = collections.data?.items ?? [];
  const [folderId, setFolderId] = useState(document.collectionId ?? "");
  const flow = useWriteFlow({
    request: () => ({ version: current.version, collectionId: folderId || null }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.patchDocument, { params: { orgId, id: document.id }, body, idempotencyKey: key }),
    refresh: current.refresh,
    reconcile: ({ request }) => documentUnchanged(orgId, document.id, request.version),
    onCommitted: (updated) => {
      toast({ message: "Document moved" });
      onDone(updated);
    },
  });
  const name = (id: string) => folders.find((folder) => folder.id === id)?.name ?? "No folder";
  const unchanged = folderId === (document.collectionId ?? "");
  return (
    <FlowDialog title="Move to a folder" flow={flow as never} onClose={onClose} onReview={() => void flow.review()} confirmLabel="Move" confirmReady={!unchanged}
      review={<div className="review-panel" aria-label="Review"><p>{unchanged ? "It is already there: nothing to move." : <>Move <b>{document.filename}</b> from <b>{name(document.collectionId ?? "")}</b> to <b>{name(folderId)}</b>.</>}</p></div>}>
      {collections.error !== undefined ? <InlineError what="the folders" error={collections.error} onRetry={collections.reload} /> : (
        <SelectField label="Folder" value={folderId} onChange={setFolderId} disabled={!collections.data}
          options={[["", collections.data ? "No folder" : "Loading…"], ...folders.filter((folder) => folder.kind === "FOLDER" && (folder.archivedAt === null || folder.id === document.collectionId)).map((folder) => [folder.id, folder.name] as const)]} />
      )}
    </FlowDialog>
  );
}

/** "Archive" hides a document without deleting it (nothing is deleted in-app); "Restore" brings it back. */
export function ArchiveDocumentDialog({ document, onClose, onDone }: DocumentDialogProps) {
  const { orgId, org } = useWorkspace();
  const toast = useToast();
  const current = useDocumentVersion(document);
  const archive = document.archivedAt === null;
  const use = archive ? portalUseOf(org, document.id) : null;
  const flow = useWriteFlow({
    request: () => ({ version: current.version, archived: archive }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.patchDocument, { params: { orgId, id: document.id }, body, idempotencyKey: key }),
    refresh: current.refresh,
    reconcile: ({ request }) => documentUnchanged(orgId, document.id, request.version),
    onCommitted: (updated) => {
      toast({ message: archive ? `${document.filename} archived` : `${document.filename} restored` });
      onDone(updated);
    },
  });
  return (
    <FlowDialog title={archive ? "Archive the document" : "Restore the document"} flow={flow as never} onClose={onClose} onReview={() => void flow.review()} confirmLabel={archive ? "Archive" : "Restore"} danger={archive}
      review={
        <div className="review-panel" aria-label="Review">
          <p>{archive ? <>Archive <b>{document.filename}</b>: it leaves the lists and the portal but is never deleted; restore it any time.</> : <>Restore <b>{document.filename}</b> to the lists{document.holderVisible ? " and the portal" : ""}.</>}</p>
          {use ? <p className="small"><b>The portal settings use it as {use}.</b> Holders lose it until another one is picked in Stakeholder portal settings.</p> : null}
        </div>
      }>
      <p>{archive ? "Archived documents stay stored with their checksum and links." : "The document comes back with its links and visibility."}</p>
    </FlowDialog>
  );
}

/** The records a link can point at, loaded for the target type chosen. */
function useTargets(type: api.LinkTargetType) {
  const { orgId } = useWorkspace();
  return useResource(async (signal): Promise<(readonly [id: string, label: string])[]> => {
    switch (type) {
      case "security": return (await apiRequest(api.routes.listSecurities, { params: { orgId }, signal })).items.map((item) => [item.id, `${item.displayId} · ${item.stakeholderName}`] as const);
      case "stakeholder": return (await apiRequest(api.routes.listStakeholders, { params: { orgId }, signal })).items.map((item) => [item.id, item.displayName] as const);
      case "stock_plan": return (await apiRequest(api.routes.listStockPlans, { params: { orgId }, signal })).items.map((item) => [item.id, item.name] as const);
      case "stock_class": return (await apiRequest(api.routes.listStockClasses, { params: { orgId }, signal })).items.map((item) => [item.id, item.name] as const);
      case "valuation": return (await apiRequest(api.routes.listValuations, { params: { orgId }, signal })).items.map((item) => [item.id, item.name] as const);
      default: return [];
    }
  }, [orgId, type]);
}

/**
 * "Link to a record" (append-only). The server refuses a second holder on a holder-visible document (MULTIPLE_HOLDERS)
 * and any holder on a published company resource; both are said before anything is sent.
 */
export function AddLinkDialog({ document, holderOfSecurity, onClose, onDone }: DocumentDialogProps & { holderOfSecurity: (securityId: string) => string | undefined }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [type, setType] = useState<api.LinkTargetType>("security");
  const [targetId, setTargetId] = useState("");
  const [role, setRole] = useState<api.DocumentLinkRole>("ATTACHMENT");
  const [error, setError] = useState<string | undefined>();
  // A transaction is what a command recorded on a security: the security is chosen first, then one of its transactions.
  const [securityId, setSecurityId] = useState("");
  const transaction = type === "transaction";
  const targets = useTargets(transaction ? "security" : type);
  const timeline = useResource(
    (signal) => apiRequest(api.routes.getSecurityTimeline, { params: { orgId, id: securityId }, signal }),
    [orgId, securityId],
    transaction && securityId !== "",
  );
  const transactions = [...new Map((timeline.data?.items ?? [])
    .filter((entry) => entry.kind === "transaction" && entry.transactionId !== null)
    .map((entry) => [entry.transactionId!, `${formatDate(entry.effectiveDate)} · ${entry.summary}`] as const)).entries()];
  const label = (transaction ? transactions : targets.data ?? []).find(([id]) => id === targetId)?.[1] ?? "";
  const flow = useWriteFlow({
    request: () => ({ role, target: { type, id: targetId } as api.LinkTarget }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.addDocumentLink, { params: { orgId, id: document.id }, body, idempotencyKey: key }),
    reconcile: async ({ request }) => {
      const now = await apiRequest(api.routes.getDocument, { params: { orgId, id: document.id } });
      return activeLinks(now).some((link) => link.targetType === request.target.type && link.targetId === request.target.id) ? "unknown" : "not_recorded";
    },
    fields: { violation: (violation) => (violation.code === "MULTIPLE_HOLDERS" ? "target" : null) },
    onCommitted: (updated) => {
      toast({ message: `${document.filename} linked to ${label}` });
      onDone(updated);
    },
  });
  const holderTarget = HOLDER_TARGETS.has(type);
  const already = activeLinks(document).some((link) => link.targetType === type && link.targetId === targetId);
  const holdersAfter = targetId && holderTarget
    ? linkedHolders({ links: [...document.links, { id: "new", role, targetType: type, targetId, createdAt: 0, createdBy: null, revokedAt: null, revokeReason: null }] }, holderOfSecurity)
    : null;
  const review = () => {
    if (!targetId) setError("Choose the record to link.");
    else if (already) setError("The document is already linked to this record.");
    else if (holderTarget && document.holderVisible && document.visibilityScope === "all_holders") setError("Every holder sees this company resource: stop showing it to holders first (Stakeholder portal settings), then it can be linked to one holder.");
    else if (document.holderVisible && holdersAfter !== null && holdersAfter.size > 1) setError("A document holders can see is linked to one holder only. Hide it from the holder first, or upload a copy for the other holder.");
    else void flow.review();
  };
  return (
    <FlowDialog title="Link to a record" flow={flow as never} onClose={onClose} onReview={review} confirmLabel="Add link"
      review={<div className="review-panel" aria-label="Review"><p>Link <b>{document.filename}</b> to {transaction ? "the transaction" : TARGET_TYPE_LABELS[type].toLowerCase()} <b>{label}</b> as <b>{LINK_ROLE_LABELS[role]}</b>. A link can be revoked later, once, with a reason.{holdersAfter && holdersAfter.size > 1 ? " It will then be linked to two or more holders, so no holder will see it in the portal." : ""}</p></div>}>
      <div className="form-grid">
        <SelectField label="Record type" value={type} onChange={(value) => { setType(value as api.LinkTargetType); setTargetId(""); setSecurityId(""); setError(undefined); }} options={PICKABLE_TARGETS.map((item) => [item, TARGET_TYPE_LABELS[item]] as const)} />
        {targets.error !== undefined ? <InlineError what="the records" error={targets.error} onRetry={targets.reload} /> : transaction ? (
          <>
            <SelectField label="Security" required value={securityId} onChange={(value) => { setSecurityId(value); setTargetId(""); setError(undefined); }} placeholder={targets.data ? "Choose…" : "Loading…"} options={targets.data ?? []}
              error={securityId ? undefined : error ?? fieldProblem(flow.problem, "target")} />
            {!securityId ? null : timeline.error !== undefined ? <InlineError what="the security's transactions" error={timeline.error} onRetry={timeline.reload} /> : (
              <SelectField label="Transaction" required value={targetId} onChange={(value) => { setTargetId(value); setError(undefined); }} placeholder={timeline.data ? "Choose…" : "Loading…"} options={transactions}
                error={error ?? fieldProblem(flow.problem, "target")} />
            )}
          </>
        ) : (
          <SelectField label="Record" required value={targetId} onChange={(value) => { setTargetId(value); setError(undefined); }} placeholder={targets.data ? "Choose…" : "Loading…"} options={targets.data ?? []} error={error ?? fieldProblem(flow.problem, "target")} />
        )}
        <SelectField label="Role" value={role} onChange={(value) => setRole(value as api.DocumentLinkRole)} options={(Object.keys(LINK_ROLE_LABELS) as api.DocumentLinkRole[]).map((item) => [item, LINK_ROLE_LABELS[item]] as const)} />
      </div>
    </FlowDialog>
  );
}

/** "Revoke" a link (once, with a reason). */
export function RevokeLinkDialog({ document, link, targetLabel, onClose, onDone }: DocumentDialogProps & { link: api.DocumentLink; targetLabel: string }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const flow = useWriteFlow({
    request: () => ({ reason: reason.trim() }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.revokeDocumentLink, { params: { orgId, id: document.id, linkId: link.id }, body, idempotencyKey: key }),
    reconcile: async () => ((await apiRequest(api.routes.getDocument, { params: { orgId, id: document.id } })).links.find((item) => item.id === link.id)?.revokedAt === null ? "not_recorded" : "unknown"),
    fields: { issue: (path) => (path === "reason" ? "reason" : null), violation: (violation) => (violation.code === "LINK_PERMANENT" ? "reason" : null) },
    onCommitted: (updated) => {
      toast({ message: `Link to ${targetLabel} revoked` });
      onDone(updated);
    },
  });
  const review = () => {
    if (!reason.trim()) setError("A reason is required.");
    else if (reason.trim().length > 500) setError("At most 500 characters.");
    else void flow.review();
  };
  return (
    <FlowDialog title="Revoke the link" flow={flow as never} onClose={onClose} onReview={review} confirmLabel="Revoke link" danger
      review={<div className="review-panel" aria-label="Review"><p>Revoke the link to <b>{targetLabel}</b> ({LINK_ROLE_LABELS[link.role]}): “{reason.trim()}”. A link is revoked once and stays in the history.{document.holderVisible && HOLDER_TARGETS.has(link.targetType) ? " If no holder link is left, the document is hidden from the portal." : ""}</p></div>}>
      <TextAreaField label="Reason" required value={reason} onChange={(value) => { setReason(value); setError(undefined); }} placeholder="e.g. Linked to the wrong grant" error={error ?? fieldProblem(flow.problem, "reason")} />
    </FlowDialog>
  );
}

interface VisibilityProps extends DocumentDialogProps {
  next: boolean;
  /** "holder": the one holder it is linked to. "company": every holder (a company resource). */
  scope: "holder" | "company";
  holderLabel?: string;
  title?: string;
}

/** Shows or hides a document in the portal: the linked holder's, or every holder's for a company resource. */
export function VisibilityDialog({ document, next, scope, holderLabel = "the holder", title, onClose, onDone }: VisibilityProps) {
  const { orgId, org } = useWorkspace();
  const toast = useToast();
  const current = useDocumentVersion(document);
  const use = !next && scope === "company" ? portalUseOf(org, document.id) : null;
  const flow = useWriteFlow({
    request: () => ({ version: current.version, visible: next }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.setHolderVisibility, { params: { orgId, id: document.id }, body, idempotencyKey: key }),
    refresh: current.refresh,
    reconcile: ({ request }) => documentUnchanged(orgId, document.id, request.version),
    fields: { violation: (violation) => (violation.code === "MULTIPLE_HOLDERS" ? "visibility" : null) },
    onCommitted: (updated) => {
      toast({ message: scope === "company"
        ? (next ? `${document.filename} published — every holder sees it` : `${document.filename} is no longer shown to holders`)
        : (next ? `${document.filename} is visible to ${holderLabel}` : `${document.filename} is hidden from ${holderLabel}'s portal`) });
      onDone(updated);
    },
  });
  const heading = title ?? (scope === "company" ? (next ? "Publish to every holder" : "Stop showing to holders") : next ? "Show in the holder's portal" : "Hide from the portal");
  const confirm = scope === "company" ? (next ? "Publish" : "Stop showing") : next ? "Show to holder" : "Hide";
  const what = scope === "company"
    ? (next ? <>Every holder sees <b>{document.filename}</b> under Company resources in their portal. No e-mail is sent.</> : <><b>{document.filename}</b> leaves every holder's portal.</>)
    : (next ? <><b>{holderLabel}</b> sees <b>{document.filename}</b> under Documents in their portal. No e-mail is sent.</> : <><b>{document.filename}</b> leaves {holderLabel}'s portal.</>);
  const placed = fieldProblem(flow.problem, "visibility");
  return (
    <FlowDialog title={heading} flow={flow as never} onClose={onClose} onReview={() => void flow.review()} confirmLabel={confirm}
      review={
        <div className="review-panel" aria-label="Review">
          <p>{what}</p>
          {use ? <p className="small"><b>The portal settings use it as {use}.</b> Choose another one in Stakeholder portal settings.</p> : null}
        </div>
      }>
      <p className="small">
        {scope === "company"
          ? "A company resource has no holder link. Linking it to a holder later needs it hidden first."
          : next ? "Only the holder it is linked to sees it; a document linked to two or more holders is never visible." : "Admins keep seeing it."}
      </p>
      {placed ? <div className="err-inline" role="alert">{placed}</div> : null}
    </FlowDialog>
  );
}

/** "Upload new version": a new document that supersedes this one; the old one stays, with its links. */
export function NewVersionDialog({ document, onClose, onDone }: { document: api.Document; onClose: () => void; onDone: (stored: UploadedDocument) => void }) {
  const [stored, setStored] = useState<UploadedDocument | null>(null);
  const toast = useToast();
  return (
    <Modal title="Upload a new version" onClose={onClose} footer={<>
      <DismissButton onClick={onClose}>{stored ? "Close" : "Cancel"}</DismissButton>
      <button type="button" className="btn btn-primary" disabled={!stored} onClick={() => { toast({ message: `New version of ${document.filename} stored; the previous version is kept` }); onDone(stored!); }}>Open the new version</button>
    </>}>
      <ErrorFocus>
        <div className="form">
          <p className="small">The new file supersedes <b>{document.filename}</b> ({documentKindLabel(document.kind)}). The previous version stays, with its links and checksum; the new one starts without links.</p>
          <DocumentUpload label="New version" kind={document.kind} required value={stored} onChange={setStored} versionOf={document.id} collectionId={document.collectionId} />
        </div>
      </ErrorFocus>
    </Modal>
  );
}

/** "Create folder" under Your documents (or inside another folder). */
export function CreateFolderDialog({ parent, onClose, onDone }: { parent: api.DocumentCollection | null; onClose: () => void; onDone: (folder: api.DocumentCollection) => void }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const flow = useWriteFlow({
    request: () => ({ name: name.trim(), ...(parent ? { parentId: parent.id } : {}) }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.createCollection, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: async ({ request }) => ((await apiRequest(api.routes.listCollections, { params: { orgId } })).items.some((item) => item.name === request.name && item.archivedAt === null) ? "unknown" : "not_recorded"),
    fields: { issue: (path) => (path === "name" ? "name" : null) },
    onCommitted: (folder) => {
      toast({ message: `Folder ${folder.name} created` });
      onDone(folder);
    },
  });
  const review = () => {
    if (!name.trim()) setError("Enter the folder's name.");
    else if (name.trim().length > 200) setError("At most 200 characters.");
    else void flow.review();
  };
  return (
    <FlowDialog title="Create folder" flow={flow as never} onClose={onClose} onReview={review} confirmLabel="Create folder"
      review={<div className="review-panel" aria-label="Review"><p>Create the folder <b>{name.trim()}</b>{parent ? <> inside <b>{parent.name}</b></> : " under Your documents"}.</p></div>}>
      <TextField label="Folder name" required value={name} onChange={(value) => { setName(value); setError(undefined); }} error={error ?? fieldProblem(flow.problem, "name")} />
    </FlowDialog>
  );
}

/** "Rename", "Archive" or "Restore" a folder (template groups are migrated and read-only). */
export function EditFolderDialog({ folder, archive, onClose, onDone }: { folder: api.DocumentCollection; archive: boolean; onClose: () => void; onDone: (folder: api.DocumentCollection) => void }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [version, setVersion] = useState(folder.version);
  const [name, setName] = useState(folder.name);
  const [error, setError] = useState<string | undefined>();
  const archiving = folder.archivedAt === null;
  const flow = useWriteFlow({
    request: () => (archive ? { version, archived: archiving } : { version, name: name.trim() }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.patchCollection, { params: { orgId, id: folder.id }, body, idempotencyKey: key }),
    refresh: async () => setVersion((await apiRequest(api.routes.listCollections, { params: { orgId } })).items.find((item) => item.id === folder.id)?.version ?? version),
    reconcile: async ({ request }) => ((await apiRequest(api.routes.listCollections, { params: { orgId } })).items.find((item) => item.id === folder.id)?.version === request.version ? "not_recorded" : "unknown"),
    fields: { issue: (path) => (path === "name" ? "name" : null) },
    onCommitted: (updated) => {
      toast({ message: archive ? (archiving ? `Folder ${folder.name} archived` : `Folder ${folder.name} restored`) : `Folder renamed to ${updated.name}` });
      onDone(updated);
    },
  });
  const review = () => {
    if (archive) void flow.review();
    else if (!name.trim()) setError("Enter the folder's name.");
    else if (name.trim().length > 200) setError("At most 200 characters.");
    else if (name.trim() === folder.name) setError("Nothing has changed.");
    else void flow.review();
  };
  return (
    <FlowDialog title={archive ? (archiving ? "Archive the folder" : "Restore the folder") : "Rename the folder"} flow={flow as never} onClose={onClose} onReview={review}
      confirmLabel={archive ? (archiving ? "Archive folder" : "Restore folder") : "Rename"} danger={archive && archiving}
      review={<div className="review-panel" aria-label="Review"><p>{archive ? (archiving ? <>Archive <b>{folder.name}</b>. Its documents stay stored, filed in it, with their links.</> : <>Restore <b>{folder.name}</b>.</>) : <>Rename <b>{folder.name}</b> to <b>{name.trim()}</b>.</>}</p></div>}>
      {archive ? <p>Nothing is deleted in the app.</p> : <TextField label="Folder name" required value={name} onChange={(value) => { setName(value); setError(undefined); }} error={error ?? fieldProblem(flow.problem, "name")} />}
    </FlowDialog>
  );
}
