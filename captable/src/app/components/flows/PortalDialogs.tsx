import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { isResourceCandidate, MIGRATION_KINDS } from "../../lib/documents.ts";
import { fieldProblem, useWriteFlow } from "../../lib/flow.ts";
import { portalSection } from "../../lib/org.ts";
import { SelectField, TextAreaField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// Stakeholder portal settings writes, owners and admins. The portal section of
// the org settings replaces whole and only an explicit null clears a key, so every write sends all three keys: the
// stored ones with the change laid over them, rebuilt from the org read again after a stale answer, so a concurrent
// change to another key is never overwritten. The notice of exercise form and the privacy notice must be published
// company resources (422 PORTAL_DOCUMENT_NOT_COMPANY_RESOURCE): a pick that no longer is one is said before sending.

/** After a lost answer: a recorded PATCH moves the version on. */
async function orgUnchanged(orgId: string, version: number): Promise<"not_recorded" | "unknown"> {
  return (await apiRequest(api.routes.getOrg, { params: { orgId } })).version === version ? "not_recorded" : "unknown";
}

/** The org read again after a stale answer, so the portal section is rebuilt from what is stored now. */
function useOrgBase(org: api.Org) {
  const { orgId } = useWorkspace();
  const [base, setBase] = useState(org);
  const refresh = async () => setBase(await apiRequest(api.routes.getOrg, { params: { orgId } }));
  return { base, refresh };
}

const PICKS = { noticeFormDocumentId: "the notice of exercise form", privacyNoticeDocumentId: "the privacy notice" } as const;
type Pick = keyof typeof PICKS;

/** The stored picks that are no longer published company resources: any portal write would be refused until fixed. */
export function stalePicks(org: api.Org, resources: ReadonlySet<string> | null): Pick[] {
  if (resources === null) return [];
  return (Object.keys(PICKS) as Pick[]).filter((key) => {
    const id = org.settings.portal[key];
    return id !== null && !resources.has(id);
  });
}

interface PortalDialogProps {
  org: api.Org;
  /** The published, unarchived company resources (null while unknown: the server decides). */
  resources: readonly api.Document[] | null;
  onClose: () => void;
  onDone: (org: api.Org) => void;
}

/** "Edit" the notice of exercise form and the privacy notice: each one a published company resource, or none. */
export function PortalDocumentsDialog({ org, resources, onClose, onDone }: PortalDialogProps) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const { base, refresh } = useOrgBase(org);
  const [notice, setNotice] = useState(org.settings.portal.noticeFormDocumentId ?? "");
  const [privacy, setPrivacy] = useState(org.settings.portal.privacyNoticeDocumentId ?? "");
  const [errors, setErrors] = useState<Partial<Record<Pick, string>>>({});
  const published = resources === null ? null : new Set(resources.map((document) => document.id));
  const nameOf = (id: string | null) => (id === null ? "None" : resources?.find((document) => document.id === id)?.filename ?? "A document that is no longer a company resource");
  const flow = useWriteFlow({
    request: () => ({ version: base.version, settings: { portal: portalSection(base, { noticeFormDocumentId: notice || null, privacyNoticeDocumentId: privacy || null }) } }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.patchOrg, { params: { orgId }, body, idempotencyKey: key }),
    refresh,
    reconcile: ({ request }) => orgUnchanged(orgId, request.version),
    fields: {
      // The server doesn't say which pick it refused: place it on the one that changed, else above the form.
      violation: (violation) => {
        if (violation.code !== "PORTAL_DOCUMENT_NOT_COMPANY_RESOURCE") return null;
        const noticeChanged = (notice || null) !== base.settings.portal.noticeFormDocumentId;
        const privacyChanged = (privacy || null) !== base.settings.portal.privacyNoticeDocumentId;
        return noticeChanged && !privacyChanged ? "noticeFormDocumentId" : privacyChanged && !noticeChanged ? "privacyNoticeDocumentId" : null;
      },
    },
    onCommitted: (updated) => {
      toast({ message: "Portal documents saved" });
      onDone(updated);
    },
  });
  const options = (current: string) => [
    ["", "None"] as const,
    ...(resources ?? []).map((document) => [document.id, document.filename] as const),
    ...(current && !(resources ?? []).some((document) => document.id === current) ? [[current, `${nameOf(current)} (not available)`] as const] : []),
  ];
  const review = () => {
    const found: Partial<Record<Pick, string>> = {};
    for (const [key, value] of [["noticeFormDocumentId", notice], ["privacyNoticeDocumentId", privacy]] as const) {
      if (value && published && !published.has(value)) found[key] = "No longer a published company resource: choose another one, or None.";
    }
    if (!Object.keys(found).length && (notice || null) === base.settings.portal.noticeFormDocumentId && (privacy || null) === base.settings.portal.privacyNoticeDocumentId) {
      found.noticeFormDocumentId = "Nothing has changed.";
    }
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const reviewed = flow.request?.settings.portal;
  return (
    <FlowDialog title="Portal documents" flow={flow as never} onClose={onClose} onReview={review} confirmLabel="Save"
      review={reviewed ? (
        <div className="review-panel" aria-label="Review">
          <p>Notice of exercise form: <b>{nameOf(reviewed.noticeFormDocumentId)}</b>. Privacy notice: <b>{nameOf(reviewed.privacyNoticeDocumentId)}</b>. Holders reach them from How to exercise and the portal footer.</p>
        </div>
      ) : null}>
      <p className="small">Each one is a company resource every holder sees. Publish a document first if it isn't listed.</p>
      <SelectField label="Notice of exercise form (counsel's)" value={notice} onChange={(value) => { setNotice(value); setErrors((current) => ({ ...current, noticeFormDocumentId: undefined })); }}
        options={options(notice)} error={errors.noticeFormDocumentId ?? fieldProblem(flow.problem, "noticeFormDocumentId")} />
      <SelectField label="Privacy notice (counsel's)" value={privacy} onChange={(value) => { setPrivacy(value); setErrors((current) => ({ ...current, privacyNoticeDocumentId: undefined })); }}
        options={options(privacy)} error={errors.privacyNoticeDocumentId ?? fieldProblem(flow.problem, "privacyNoticeDocumentId")} />
    </FlowDialog>
  );
}

/** "Edit" the How to exercise text (8,000 characters; empty restores the default text). */
export function HowToExerciseDialog({ org, resources, onClose, onDone }: PortalDialogProps) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const { base, refresh } = useOrgBase(org);
  const [text, setText] = useState(org.settings.portal.howToExerciseText ?? "");
  const [error, setError] = useState<string | undefined>();
  const stale = stalePicks(base, resources === null ? null : new Set(resources.map((document) => document.id)));
  const flow = useWriteFlow({
    request: () => ({ version: base.version, settings: { portal: portalSection(base, { howToExerciseText: text.trim() || null }) } }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.patchOrg, { params: { orgId }, body, idempotencyKey: key }),
    refresh,
    reconcile: ({ request }) => orgUnchanged(orgId, request.version),
    fields: { issue: (path) => (path.endsWith("howToExerciseText") ? "text" : null) },
    onCommitted: (updated) => {
      toast({ message: "How to exercise text saved" });
      onDone(updated);
    },
  });
  const review = () => {
    if (stale.length) setError(`The portal settings still name ${stale.map((key) => PICKS[key]).join(" and ")}, which is no longer a published company resource: the server refuses every portal change until it is replaced (Portal documents).`);
    else if (text.trim().length > 8000) setError("At most 8,000 characters.");
    else if ((text.trim() || null) === base.settings.portal.howToExerciseText) setError("Nothing has changed.");
    else void flow.review();
  };
  const reviewed = flow.request?.settings.portal.howToExerciseText;
  return (
    <FlowDialog title="How to exercise — text" flow={flow as never} onClose={onClose} onReview={review} confirmLabel="Save text"
      review={
        <div className="review-panel" aria-label="Review">
          {reviewed ? <><p>Holders see this on How to exercise, above the payment instructions and their reference:</p><pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{reviewed}</pre></> : <p>Holders see the default text again.</p>}
        </div>
      }>
      <TextAreaField label="Text holders see on How to exercise" value={text} rows={8} onChange={(value) => { setText(value); setError(undefined); }}
        hint="Leave empty for the default text. The payment instructions and each holder's reference are added below it." error={error ?? fieldProblem(flow.problem, "text")} />
    </FlowDialog>
  );
}

/**
 * "Publish a document": every holder sees it under Company resources. Only documents with no holder link can be
 * company resources, never migration records.
 */
export function PublishResourceDialog({ documents, preselect, onClose, onDone }: { documents: readonly api.Document[] | null; preselect?: string; onClose: () => void; onDone: (document: api.Document) => void }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const candidates = (documents ?? []).filter((document) => isResourceCandidate(document) && !document.holderVisible && !MIGRATION_KINDS.has(document.kind));
  const [documentId, setDocumentId] = useState(preselect ?? "");
  const [error, setError] = useState<string | undefined>();
  const chosen = candidates.find((document) => document.id === documentId) ?? null;
  const [version, setVersion] = useState<number | null>(null);
  const flow = useWriteFlow({
    request: () => ({ documentId, version: version ?? chosen?.version ?? 0, visible: true }),
    preview: null,
    body: ({ request }) => ({ version: request.version, visible: request.visible }),
    send: (body, key) => apiRequest(api.routes.setHolderVisibility, { params: { orgId, id: documentId }, body, idempotencyKey: key }),
    refresh: async () => setVersion((await apiRequest(api.routes.getDocument, { params: { orgId, id: documentId } })).version),
    reconcile: async ({ request }) => ((await apiRequest(api.routes.getDocument, { params: { orgId, id: request.documentId } })).version === request.version ? "not_recorded" : "unknown"),
    fields: { violation: (violation) => (violation.code === "MULTIPLE_HOLDERS" ? "document" : null) },
    onCommitted: (updated) => {
      toast({ message: `${updated.filename} published — every holder sees it` });
      onDone(updated);
    },
  });
  const review = () => {
    if (!chosen) setError("Choose the document to publish.");
    else void flow.review();
  };
  return (
    <FlowDialog title="Publish a company resource" flow={flow as never} onClose={onClose} onReview={review} confirmLabel="Publish"
      review={<div className="review-panel" aria-label="Review"><p>Every holder sees <b>{chosen?.filename}</b> under Company resources in their portal. No e-mail is sent.</p></div>}>
      <p className="small">Documents with no holder link can be company resources (a plan document, the exercise FAQ, counsel's notice of exercise form, the privacy notice).</p>
      <SelectField label="Document" required value={documentId} onChange={(value) => { setDocumentId(value); setVersion(null); setError(undefined); }}
        placeholder={documents === null ? "Loading…" : candidates.length ? "Choose…" : "No document can be published"} options={candidates.map((document) => [document.id, document.filename] as const)}
        error={error ?? fieldProblem(flow.problem, "document")} />
    </FlowDialog>
  );
}
