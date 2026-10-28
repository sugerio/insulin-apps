import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { fieldProblem, useWriteFlow, type FieldMap } from "../../lib/flow.ts";
import { emailKindLabel } from "../../lib/stakeholders.ts";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { SelectField, TextAreaField, TextField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { usePii } from "../Pii.tsx";
import { useToast } from "../Toast.tsx";
import { CommandPreview, confirmationMatches, TypedConfirmation } from "../FlowParts.tsx";
import { useResource } from "../../lib/useResource.ts";
import { FlowDialog } from "./FlowDialog.tsx";

// A stakeholder's e-mail addresses and the merge of two stakeholder records. An address is added or removed, never
// edited. No admin changes these on their own record (403 self_dealing).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A name that ends a sentence: "Fund II, L.P." takes no second period. */
const endSentence = (name: string) => (name.endsWith(".") ? name : `${name}.`);

const EMAIL_FIELDS: FieldMap = {
  issue: (path) => ({ email: "email", contactName: "contactName", contactRole: "contactRole", authorizingDocumentId: "document", reason: "reason" } as Record<string, string>)[path] ?? null,
};

/** Whether the stakeholder has this address now, not removed: after a lost answer, an add may be recorded. */
async function addressOnRecord(orgId: string, stakeholderId: string, address: string): Promise<boolean> {
  const fresh = await apiRequest(api.routes.getStakeholder, { params: { orgId, id: stakeholderId } });
  return fresh.emails.some((email) => email.removedAt === null && email.email.toLowerCase() === address.toLowerCase());
}

const KIND_OPTIONS = [["self", "Their own address"], ["contact", "An authorized contact"], ["representative", "A representative (executor, guardian)"]] as const;

/** "Add e-mail": an address of the stakeholder's own, an institution's authorized contact, or a representative's. */
export function AddEmailDialog({ stakeholder, onClose, onDone }: { stakeholder: api.Stakeholder; onClose: () => void; onDone: () => void }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<api.StakeholderEmail["kind"]>(stakeholder.kind === "institution" ? "contact" : "self");
  const [contactName, setContactName] = useState("");
  const [contactRole, setContactRole] = useState("");
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const clear = (key: string) => setErrors((current) => ({ ...current, [key]: undefined }));
  const flow = useWriteFlow({
    request: (): api.StakeholderEmailRequestInput => ({
      email: email.trim(),
      kind,
      ...(kind !== "self" && contactName.trim() ? { contactName: contactName.trim() } : {}),
      ...(kind !== "self" && contactRole.trim() ? { contactRole: contactRole.trim() } : {}),
      ...(kind === "representative" && document ? { authorizingDocumentId: document.id } : {}),
    }),
    preview: null,
    // An address another stakeholder already uses needs DUPLICATE_EMAIL acknowledged.
    body: ({ request, acknowledge }) => ({ ...request, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.addStakeholderEmail, { params: { orgId, id: stakeholder.id }, body, idempotencyKey: key }),
    reconcile: async ({ request }) => ((await addressOnRecord(orgId, stakeholder.id, request.email)) ? "unknown" : "not_recorded"),
    fields: EMAIL_FIELDS,
    onCommitted: (added) => {
      toast({ message: `${added.email} added to ${stakeholder.displayName}` });
      onDone();
    },
  });
  const review = () => {
    const found: Record<string, string> = {};
    if (!EMAIL.test(email.trim())) found.email = "Enter a valid e-mail address.";
    else if (stakeholder.emails.some((item) => item.removedAt === null && item.email.toLowerCase() === email.trim().toLowerCase())) found.email = "This stakeholder already has this address.";
    if (kind !== "self" && !contactName.trim()) found.contactName = kind === "representative" ? "Enter the representative's name." : "Enter the contact's name.";
    if (kind === "representative" && !document) found.document = "A representative needs the authorizing document.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  return (
    <FlowDialog
      title={`Add an e-mail — ${stakeholder.displayName}`}
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Add e-mail"
      review={
        <div className="review-panel" aria-label="Review">
          <p>Add <b>{email.trim().toLowerCase()}</b> ({emailKindLabel({ kind }).toLowerCase()}{kind !== "self" && contactName.trim() ? `: ${contactName.trim()}` : ""}) to {endSentence(stakeholder.displayName)}</p>
          {kind === "self" ? <p className="small">A console user with this e-mail sees {stakeholder.displayName}'s holdings.</p> : null}
        </div>
      }
    >
      <TextField label="E-mail" type="email" required value={email} onChange={(value) => { setEmail(value); clear("email"); }} placeholder="name@mailbox.example" error={errorOf("email")} />
      <SelectField label="Whose address" value={kind} onChange={(value) => setKind(value as api.StakeholderEmail["kind"])} options={KIND_OPTIONS} />
      {kind !== "self" ? (
        <div className="form-grid">
          <TextField label={kind === "representative" ? "Representative's name" : "Contact name"} required value={contactName} onChange={(value) => { setContactName(value); clear("contactName"); }} error={errorOf("contactName")} />
          <TextField label="Role" value={contactRole} onChange={setContactRole} error={errorOf("contactRole")} />
        </div>
      ) : null}
      {kind === "representative" ? (
        <DocumentUpload label="Authorizing document" kind="OTHER" required value={document} onChange={(next) => { setDocument(next); clear("document"); }} error={errorOf("document")} disabled={flow.phase !== "edit"} />
      ) : null}
    </FlowDialog>
  );
}

/** "Remove": the address stops matching a console account at once; the record keeps it in its history. */
export function RemoveEmailDialog({ stakeholder, email, onClose, onDone }: { stakeholder: api.Stakeholder; email: api.StakeholderEmail; onClose: () => void; onDone: () => void }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const pii = usePii();
  const [reason, setReason] = useState("");
  const flow = useWriteFlow({
    request: () => (reason.trim() ? { reason: reason.trim() } : {}),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.removeStakeholderEmail, { params: { orgId, id: stakeholder.id, emailId: email.id }, body, idempotencyKey: key }),
    reconcile: async () => ((await addressOnRecord(orgId, stakeholder.id, email.email)) ? "not_recorded" : "unknown"),
    fields: EMAIL_FIELDS,
    onCommitted: () => {
      toast({ message: `${pii.email(email.email)} removed from ${stakeholder.displayName}` });
      onDone();
    },
  });
  return (
    <FlowDialog
      title="Remove the e-mail"
      flow={flow as never}
      onClose={onClose}
      onReview={() => void flow.review()}
      confirmLabel="Remove e-mail"
      danger
      review={
        <div className="review-panel" aria-label="Review">
          <p>Remove <b>{pii.email(email.email)}</b> from {endSentence(stakeholder.displayName)}{email.kind === "self" ? " A console user with this e-mail no longer sees these holdings." : ""}</p>
        </div>
      }
    >
      <TextAreaField label="Reason (optional)" value={reason} onChange={setReason} placeholder="e.g. The holder changed address" error={fieldProblem(flow.problem, "reason")} />
    </FlowDialog>
  );
}

const previewValue = (value: unknown) => value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);

interface MergeProps {
  stakeholder: api.StakeholderDetail;
  onClose: () => void;
  onDone: (survivingStakeholderId: string) => void;
}

/** Identity merge: the server owns every guard and computes the before/after preview. */
export function MergeStakeholderDialog({ stakeholder, onClose, onDone }: MergeProps) {
  const { orgId, format } = useWorkspace();
  const toast = useToast();
  const candidates = useResource(
    (signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }),
    [orgId],
  );
  const [survivorId, setSurvivorId] = useState("");
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const request = () => ({ mergedStakeholderId: stakeholder.id, survivingStakeholderId: survivorId, reason: reason.trim() });
  const dryRun = (frozen: ReturnType<typeof request>, signal?: AbortSignal) => apiRequest(api.routes.mergeStakeholders, {
    params: { orgId }, dryRun: true, body: frozen, signal,
  });
  const flow = useWriteFlow({
    request,
    preview: dryRun,
    body: ({ request: frozen, preview, acknowledge }) => ({
      ...frozen,
      confirmation: typed.trim(),
      expectedLedgerSeq: preview!.ledgerSeq,
      expectedDiffSha256: preview!.diffSha256,
      acknowledge: [...acknowledge],
    }),
    send: (body, key) => apiRequest(api.routes.mergeStakeholders, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: async ({ request: frozen, preview }) => {
      const next = await dryRun(frozen);
      return next.ledgerSeq === preview!.ledgerSeq ? "not_recorded" : "unknown";
    },
    onCommitted: (result) => {
      toast({ message: `${stakeholder.displayName} merged into ${result.stakeholderMerge!.survivor.displayName}` });
      onDone(result.stakeholderMerge!.survivor.id);
    },
  });
  const available = (candidates.data?.items ?? []).filter((item) => item.id !== stakeholder.id && item.kind === stakeholder.kind && item.mergedInto === null);
  const review = () => {
    const found: Record<string, string> = {};
    if (!survivorId) found.survivor = "Choose the record that will survive.";
    if (!reason.trim()) found.reason = "A reason is required.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const preview = flow.preview?.stakeholderMerge;
  const blocked = (preview?.blockingItems.length ?? 0) > 0;
  const economicChanges = flow.preview?.changes.filter((change) => !(change.entity === "stakeholder" && change.id === preview?.merged.id)) ?? [];
  return (
    <FlowDialog
      title="Merge into another stakeholder"
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Merge stakeholder"
      confirmReady={!!preview && !blocked && confirmationMatches(typed, preview.confirmation)}
      danger
      review={preview ? (
        <div className="review-panel" aria-label="Merge preview">
          <p><b>{preview.merged.displayName}</b> will disappear from lists and all ledger holdings and history will be attributed to <b>{preview.survivor.displayName}</b>.</p>
          <table className="tbl" aria-label="Holdings before and after merge">
            <thead><tr><th>Record</th><th className="right">Securities</th><th className="right">Issued &amp; outstanding</th><th className="right">Fully diluted</th></tr></thead>
            <tbody>
              <tr><td>{preview.survivor.displayName} before</td><td className="right">{preview.holdings.survivorBefore.securityCount}</td><td className="right">{format.shares(preview.holdings.survivorBefore.issuedAndOutstanding)}</td><td className="right">{format.shares(preview.holdings.survivorBefore.fullyDiluted)}</td></tr>
              <tr><td>{preview.merged.displayName} before</td><td className="right">{preview.holdings.mergedBefore.securityCount}</td><td className="right">{format.shares(preview.holdings.mergedBefore.issuedAndOutstanding)}</td><td className="right">{format.shares(preview.holdings.mergedBefore.fullyDiluted)}</td></tr>
              <tr><td><b>{preview.survivor.displayName} after</b></td><td className="right"><b>{preview.holdings.survivorAfter.securityCount}</b></td><td className="right"><b>{format.shares(preview.holdings.survivorAfter.issuedAndOutstanding)}</b></td><td className="right"><b>{format.shares(preview.holdings.survivorAfter.fullyDiluted)}</b></td></tr>
            </tbody>
          </table>
          <p className="small"><b>E-mails:</b> {preview.addresses.length ? preview.addresses.map((item) => `${item.email} (${item.action})`).join(", ") : "None"}</p>
          {preview.profileDifferences.length ? (
            <div className="small"><b>Profile differences kept on the archived record:</b>
              <ul>{preview.profileDifferences.map((item) => (
                <li key={item.field}>{item.field}: survivor “{previewValue(item.survivorValue)}”; merged record “{previewValue(item.mergedValue)}”</li>
              ))}</ul>
              <p>Edit the survivor afterwards if needed.</p>
            </div>
          ) : null}
          {economicChanges.length ? <CommandPreview changes={economicChanges} title="Economic changes" /> : <p className="small"><b>Economic changes:</b> None</p>}
          {blocked ? <div className="banner banner-warn"><b>Resolve these blockers first:</b><ul>{preview.blockingItems.map((item) => <li key={`${item.type}:${item.id}`}>{item.label}</li>)}</ul></div> : null}
          <TypedConfirmation expected={preview.confirmation} value={typed} onChange={setTyped} disabled={flow.busy || flow.locked || blocked} />
        </div>
      ) : null}
    >
      <SelectField label="Surviving record" required value={survivorId} onChange={(value) => { setSurvivorId(value); setErrors((current) => ({ ...current, survivor: undefined })); }}
        options={[["", candidates.data ? "Choose a stakeholder" : "Loading stakeholders…"], ...available.map((item) => [item.id, item.displayName] as const)]} error={errors.survivor} />
      <TextAreaField label="Reason" required value={reason} onChange={(value) => { setReason(value); setErrors((current) => ({ ...current, reason: undefined })); }} error={errors.reason} />
      <p className="small muted">The survivor keeps its own profile fields. Holdings and ledger history are combined for every as-of date. An unmerge leaves moved e-mails on the survivor.</p>
    </FlowDialog>
  );
}
