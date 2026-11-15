import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card as UiCard, CardContent } from "@/components/ui/card.tsx";
import { apiRequest } from "../api/request.ts";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { DocumentUpload, type UploadedDocument } from "../components/DocumentUpload.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { CommandPreview, FlowProblemBanner, WarningsToAcknowledge } from "../components/FlowParts.tsx";
import { CheckLine, DateField, RadioCards, SelectField, TextAreaField, TextField } from "../components/Form.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { usePii } from "../components/Pii.tsx";
import { useToast, type ToastMessage } from "../components/Toast.tsx";
import { WriteGate } from "../components/WritePage.tsx";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap } from "../lib/flow.ts";
import { DASH, formatDate } from "../lib/format.ts";
import { RELATIONSHIP_LABELS } from "../lib/labels.ts";
import {
  createRequest, duplicateOwner, EMPTY_STAKEHOLDER, hasChanges, patchRequest, rebaseStakeholder, stakeholderIssueField, validateStakeholder, valuesOf,
  type CreateRequest, type ServerChange, type StakeholderErrors, type StakeholderValues,
} from "../lib/stakeholderForm.ts";
import { activeEmails, addressLine } from "../lib/stakeholders.ts";
import { useResource } from "../lib/useResource.ts";

// Add stakeholder and Edit stakeholder: identity, the e-mail
// that connects a console account to the holder view, relationship, address and tax residence, comments and, on an
// existing record, the leave of absence. Saving reviews the exact request, then records it
// with one Idempotency-Key per body.

const RELATIONSHIP_OPTIONS = (Object.keys(RELATIONSHIP_LABELS) as api.Relationship[]).map((relationship) => [relationship, RELATIONSHIP_LABELS[relationship]] as const);
const EDIT_RELATIONSHIPS = RELATIONSHIP_OPTIONS.filter(([relationship]) => relationship !== "ex_employee");
const EMAIL_HINT = "Optional. Their console account's e-mail: it lets them see their own holdings.";
const CONTACT_HINT = "Their console account's e-mail lets them see the institution's holdings.";

/** Where the server's issues and violations land. */
const ISSUE_FIELDS: FieldMap = {
  issue: (path) => (path.startsWith("emails") ? "email" : stakeholderIssueField(path)),
};

type ProfileRequest = CreateRequest | api.PatchStakeholderRequestInput;

function createdToast(created: api.Stakeholder, to?: string): ToastMessage {
  return { message: `${created.displayName} added`, to, linkLabel: "Open" };
}

export function StakeholderFormPage({ mode }: { mode: "create" | "edit" }) {
  const { orgId, href, isOwn } = useWorkspace();
  const { stakeholderId = "" } = useParams();
  const detail = useResource((signal) => apiRequest(api.routes.getStakeholder, { params: { orgId, id: stakeholderId }, signal }), [orgId, stakeholderId], mode === "edit");
  if (mode === "create") {
    return (
      <Page title="Add stakeholder" crumbs={[["Stakeholders", href("stakeholders")], ["Add stakeholder"]]}>
        <WriteGate back={{ to: href("stakeholders"), label: "Back to stakeholders" }}>
          <StakeholderForm mode="create" />
        </WriteGate>
      </Page>
    );
  }
  const name = detail.data?.displayName ?? "Stakeholder";
  return (
    <Page title={`Edit ${name}`} crumbs={[["Stakeholders", href("stakeholders")], [name, href(`stakeholders/${stakeholderId}`)], ["Edit"]]}>
      <ResourceView resource={detail} notFound="This stakeholder does not exist.">
        {(data) => (
          <WriteGate own={isOwn(data.id)} back={{ to: href(`stakeholders/${data.id}`), label: "Back to the stakeholder" }}>
            <StakeholderForm mode="edit" original={data} />
            <LeaveOfAbsenceCard stakeholder={data} onRecorded={detail.reload} />
          </WriteGate>
        )}
      </ResourceView>
    </Page>
  );
}

function StakeholderForm({ mode, original: loaded }: { mode: "create" | "edit"; original?: api.StakeholderDetail }) {
  const { orgId, href } = useWorkspace();
  // The record the edit starts from, and the PATCH sends the version of. After a stale answer it becomes the fresh
  // record, with the admin's own edits kept on top of it (rebaseStakeholder).
  const [base, setBase] = useState<api.Stakeholder | undefined>(loaded);
  /** What the server changed while the admin was editing, shown with the next review. */
  const [serverChanges, setServerChanges] = useState<readonly ServerChange[]>([]);
  const navigate = useNavigate();
  const toast = useToast();
  const pii = usePii();
  const [values, setValues] = useState<StakeholderValues>(() => (base ? valuesOf(base) : EMPTY_STAKEHOLDER));
  const [errors, setErrors] = useState<StakeholderErrors>({});
  const list = useResource((signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }), [orgId], mode === "create");
  const set = <K extends keyof StakeholderValues>(key: K, value: StakeholderValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  };
  const flow = useWriteFlow<ProfileRequest, null, api.CreateStakeholderRequestInput | api.PatchStakeholderRequestInput, api.Stakeholder>({
    request: () => (mode === "create" ? createRequest(values) : patchRequest(values, base!)),
    preview: null,
    // A create sends the warnings the admin acknowledged (an address another stakeholder uses: DUPLICATE_EMAIL).
    body: ({ request, acknowledge }) => (mode === "create" ? { ...(request as api.CreateStakeholderRequestInput), acknowledge: [...acknowledge] } : request),
    send: (body, key) => mode === "create"
      ? apiRequest(api.routes.createStakeholder, { params: { orgId }, body: body as api.CreateStakeholderRequestInput, idempotencyKey: key })
      : apiRequest(api.routes.patchStakeholder, { params: { orgId, id: base!.id }, body: body as api.PatchStakeholderRequestInput, idempotencyKey: key }),
    fields: ISSUE_FIELDS,
    refresh: async () => {
      if (mode !== "edit" || !base) return;
      const fresh = await apiRequest(api.routes.getStakeholder, { params: { orgId, id: base.id } });
      const rebased = rebaseStakeholder(values, base, fresh);
      setBase(fresh);
      setValues(rebased.values);
      setServerChanges(rebased.changes);
    },
    reconcile: async ({ request, body, key }) => {
      if (mode === "create") {
        const result = await apiRequest(api.routes.createStakeholder, {
          params: { orgId }, body: body as api.CreateStakeholderRequestInput, idempotencyKey: key,
        });
        return { result };
      }
      // A recorded PATCH moves the version on; the same version means nothing was written.
      const fresh = await apiRequest(api.routes.getStakeholder, { params: { orgId, id: base!.id } });
      return fresh.version === (request as api.PatchStakeholderRequestInput).version ? "not_recorded" : "unknown";
    },
    onCommitted: (saved) => {
      toast(mode === "create" ? createdToast(saved, href(`stakeholders/${saved.id}`)) : { message: "Stakeholder updated" });
      navigate(href(`stakeholders/${saved.id}`));
    },
  });
  const editing = flow.phase === "edit";
  const errorOf = (key: keyof StakeholderValues) => errors[key] ?? fieldProblem(flow.problem, key);
  const duplicate = mode === "create" ? duplicateOwner(list.data?.items ?? [], values.email) : null;
  const reviewed = flow.request;
  const nothingLeft = mode === "edit" && reviewed !== null && !hasChanges(reviewed as api.PatchStakeholderRequestInput);

  const review = () => {
    const found = validateStakeholder(values, mode);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (base && !hasChanges(patchRequest(values, base))) {
      setErrors({ legalName: "Nothing has changed." });
      return;
    }
    setServerChanges([]);
    void flow.review();
  };

  const institution = values.kind === "institution";
  return (
    <Card>
      <PageHead title={mode === "create" ? "Add stakeholder" : `Edit ${base!.displayName}`} />
      {editing ? <FlowProblemBanner problem={flow.problem} /> : null}
      <fieldset className="flex max-w-190 min-w-0 flex-col gap-4" disabled={!editing} aria-label="Stakeholder details">
        <h3 className="text-base font-semibold">Identity</h3>
        <RadioCards label="Type" value={values.kind} onChange={(value) => set("kind", value as StakeholderValues["kind"])} options={[
          { value: "individual", label: "Individual", sub: "A person" },
          { value: "institution", label: "Institution", sub: "A fund, company or trust" },
        ]} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Legal name" required value={values.legalName} onChange={(value) => set("legalName", value)} error={errorOf("legalName")} />
          <TextField label="Display name" value={values.displayName} onChange={(value) => set("displayName", value)} hint="Defaults to the legal name." error={errorOf("displayName")} />
          {mode === "create" ? (
            <>
              <TextField label={institution ? "Contact e-mail" : "E-mail"} type="email" required={institution} value={values.email} onChange={(value) => set("email", value)} hint={institution ? CONTACT_HINT : EMAIL_HINT} error={errorOf("email")} />
              {institution ? (
                <>
                  <TextField label="Contact name" value={values.contactName} onChange={(value) => set("contactName", value)} />
                  <TextField label="Contact role" value={values.contactRole} onChange={(value) => set("contactRole", value)} />
                </>
              ) : null}
            </>
          ) : (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-sm font-medium">E-mails</span>
              <div className="text-xs">{activeEmails(base!).map((email) => pii.email(email.email)).join(", ") || DASH}</div>
            </div>
          )}
        </div>
        {duplicate ? (
          <Banner kind="warn" title="Duplicate e-mail">{duplicate.displayName} already uses this e-mail. You can still save; duplicate records can be merged from the stakeholder page.</Banner>
        ) : null}
        <h3 className="text-base font-semibold">Relationship</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Ex-employee is set by a termination and locked while one is recorded or scheduled; one imported without
              a termination can be corrected. */}
          {base?.relationship === "ex_employee" && (base.termination !== null || base.scheduledTermination !== null) ? (
            <SelectField label="Relationship" value="ex_employee" onChange={() => {}} disabled options={RELATIONSHIP_OPTIONS}
              hint={base.termination !== null ? "Set by the termination; reverse the termination to change it." : "A termination is scheduled; it must be cancelled to change the relationship."} />
          ) : (
            <SelectField label="Relationship" required value={values.relationship} onChange={(value) => set("relationship", value as api.Relationship)} error={errorOf("relationship")}
              options={mode === "create" || base?.relationship === "ex_employee" ? RELATIONSHIP_OPTIONS : EDIT_RELATIONSHIPS}
              hint={base?.relationship === "ex_employee" ? "No termination is recorded for this ex-employee: choose the relationship the record should have." : undefined} />
          )}
          <DateField label="Hire date" value={values.hireDate} onChange={(value) => set("hireDate", value)} error={errorOf("hireDate")} />
          <TextField label="External ID" value={values.issuerAssignedId} onChange={(value) => set("issuerAssignedId", value)} error={errorOf("issuerAssignedId")} />
          <TextField label="Phone" type="tel" value={values.phone} onChange={(value) => set("phone", value)} error={errorOf("phone")} />
        </div>
        <h3 className="text-base font-semibold">Address and tax residence</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField className="sm:col-span-2" label="Address" value={values.line1} onChange={(value) => set("line1", value)} placeholder="Street and number" error={errorOf("line1")} />
          <TextField label="Address line 2" value={values.line2} onChange={(value) => set("line2", value)} />
          <TextField label="City" value={values.city} onChange={(value) => set("city", value)} error={errorOf("city")} />
          <TextField label="State or region" value={values.region} onChange={(value) => set("region", value)} />
          <TextField label="Postal code" value={values.postalCode} onChange={(value) => set("postalCode", value)} />
          <TextField label="Country" value={values.country} onChange={(value) => set("country", value)} placeholder="US" hint="Two-letter code." error={errorOf("country")} />
          <TextField label="Country of tax residence" value={values.countryOfResidence} onChange={(value) => set("countryOfResidence", value)} placeholder="US" hint="Two-letter code." error={errorOf("countryOfResidence")} />
        </div>
        <TextAreaField label="Comments" value={values.comments} onChange={(value) => set("comments", value)} error={errorOf("comments")} />
        <p className="text-xs text-muted-foreground">The app doesn't collect a TIN.{mode === "edit" ? " A leave of absence is recorded below, on the ledger." : ""}</p>
      </fieldset>
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={review}>Save</Button>
          <Button asChild variant="ghost"><Link to={base ? href(`stakeholders/${base.id}`) : href("stakeholders")}>Cancel</Link></Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <FlowProblemBanner problem={flow.problem} onRetry={() => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
          {serverChanges.length ? <ServerChangeList changes={serverChanges} /> : null}
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-4" aria-label="Review">
            <h3 className="text-sm font-semibold">{mode === "create" ? "Review the new stakeholder" : "Review your changes"}</h3>
            {mode === "create" && reviewed ? <CreateSummary request={reviewed as CreateRequest} />
              : nothingLeft ? <p className="text-sm">Nothing left to save: the record already has these values.</p>
                : base ? <ChangeList values={values} original={base} /> : null}
          </div>
          <WarningsToAcknowledge flow={flow as never} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={flow.edit} disabled={flow.busy || flow.locked}>Back to edit</Button>
            <Button type="button" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked || !flow.acknowledgedAll || nothingLeft}>
              {flow.phase === "committing" ? "Saving…" : mode === "create" ? "Add stakeholder" : "Save changes"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** The create request in words, exactly as it will be sent. */
function CreateSummary({ request }: { request: CreateRequest }) {
  const contact = request.emails.find((email) => email.kind === "contact");
  const own = request.emails.find((email) => email.kind !== "contact");
  return (
    <p className="text-sm">
      Add <b>{request.displayName}</b> ({request.kind === "institution" ? "Institution" : "Individual"} · {RELATIONSHIP_LABELS[request.relationship]})
      {contact ? <> with contact <b>{contact.email}</b></> : null}
      {own ? <> with e-mail <b>{own.email}</b></> : null}
      {!request.emails.length ? " without an e-mail" : null}.
    </p>
  );
}

const CHANGE_LABELS: Partial<Record<keyof StakeholderValues, string>> = {
  kind: "Type", legalName: "Legal name", displayName: "Display name", relationship: "Relationship", hireDate: "Hire date", issuerAssignedId: "External ID",
  phone: "Phone", line1: "Address", line2: "Address line 2", city: "City", region: "State or region", postalCode: "Postal code", country: "Country",
  countryOfResidence: "Country of tax residence", comments: "Comments",
};

function shown(key: keyof StakeholderValues, value: string): string {
  if (key === "relationship") return RELATIONSHIP_LABELS[value as api.Relationship] ?? value;
  if (key === "kind") return value === "institution" ? "Institution" : value === "individual" ? "Individual" : value;
  return value === "" ? DASH : String(value);
}

const ADDRESS_KEYS: readonly (keyof StakeholderValues)[] = ["line1", "line2", "city", "region", "postalCode", "country"];

/**
 * The fields an edit changes, before → after, as the PATCH sends them (trimmed). An optional field the admin emptied
 * is cleared on the server (sent as null) and says so; an emptied address clears the whole address.
 */
function ChangeList({ values, original }: { values: StakeholderValues; original: api.Stakeholder }) {
  const before = valuesOf(original);
  const differs = (key: keyof StakeholderValues) => (typeof values[key] === "string" ? (values[key] as string).trim() !== (before[key] as string).trim() : values[key] !== before[key]);
  const addressCleared = original.address !== null && ADDRESS_KEYS.every((key) => (values[key] as string).trim() === "");
  const keys = (Object.keys(CHANGE_LABELS) as (keyof StakeholderValues)[]).filter((key) => differs(key) && !(addressCleared && ADDRESS_KEYS.includes(key)));
  const after = (key: keyof StakeholderValues) => {
    if (key === "displayName" && values.displayName.trim() === "") return values.legalName.trim();
    if (typeof values[key] === "string" && (values[key] as string).trim() === "" && (before[key] as string).trim() !== "") return "Cleared";
    return shown(key, typeof values[key] === "string" ? (values[key] as string).trim() : values[key]);
  };
  return (
    <div aria-label="Changes">
      {addressCleared ? (
        <div className="grid gap-x-3 gap-y-0.5 border-b border-dashed py-1 text-xs last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]">
          <span>Address</span>
          <span className="tabular-nums sm:text-right">{addressLine(original.address) ?? DASH}<span className="mx-1.5 text-muted-foreground" aria-label="becomes">→</span><b>Cleared</b></span>
        </div>
      ) : null}
      {keys.map((key) => (
        <div className="grid gap-x-3 gap-y-0.5 border-b border-dashed py-1 text-xs last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]" key={key}>
          <span>{CHANGE_LABELS[key]}</span>
          <span className="tabular-nums sm:text-right">{key === "displayName" && before.displayName === "" ? original.displayName : shown(key, before[key])}<span className="mx-1.5 text-muted-foreground" aria-label="becomes">→</span><b>{after(key)}</b></span>
        </div>
      ))}
      {values.displayName === "" && values.legalName !== before.legalName ? <p className="mt-2 text-xs text-muted-foreground">The display name follows the legal name.</p> : null}
    </div>
  );
}

/** What someone else changed while the admin was editing (after 409 stale_version). */
function ServerChangeList({ changes }: { changes: readonly ServerChange[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-4" aria-label="Changed on the server">
      <h3 className="text-sm font-semibold">Changed by someone else while you were editing</h3>
      <p className="text-xs">Fields you didn't edit now show the new values and are left as they are. Check them before you save again.</p>
      {changes.map((change) => (
        <div className="grid gap-x-3 gap-y-0.5 border-b border-dashed py-1 text-xs last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]" key={change.field}>
          <span>{CHANGE_LABELS[change.field] ?? change.field}</span>
          <span className="tabular-nums sm:text-right">
            {shown(change.field, change.before)}<span className="mx-1.5 text-muted-foreground" aria-label="became">→</span><b>{shown(change.field, change.after)}</b>
            {change.conflict ? <span className="text-xs text-amber-700 dark:text-amber-300"> · you edited this too: your value replaces it if you save</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Leave of absence: a
 * ledger command, because it moves the ISO deadline. A leave longer than 3 months without a guaranteed return ends
 * employment for the ISO test on the day after the 3rd month. Reviewed with the server's dry run, like any command.
 */
type Leave = api.Stakeholder["leaveOfAbsence"][number];

/** The recorded leave a span [start, end) overlaps, other than the one with the same start (that one is corrected). */
function overlappingLeave(leaves: readonly Leave[], start: string, end: string | null): Leave | null {
  return leaves.find((other) => other.startDate !== start && start < (other.endDate ?? "9999-12-31") && other.startDate < (end ?? "9999-12-31")) ?? null;
}

function LeaveOfAbsenceCard({ stakeholder, onRecorded }: { stakeholder: api.StakeholderDetail; onRecorded: () => void }) {
  // A recorded leave starts a new intent: the form is mounted afresh, with a new flow and new keys.
  const [generation, setGeneration] = useState(0);
  // The open leave whose end is being recorded: a leave is identified by its start date, so the form sends that one.
  const [closing, setClosing] = useState<Leave | null>(null);
  const restart = (next: Leave | null) => {
    setClosing(next);
    setGeneration((current) => current + 1);
  };
  return (
    <Card>
      <h2 className="text-lg font-semibold">Leave of absence</h2>
      <p className="text-xs text-muted-foreground">Feeds the ISO test: a leave longer than 3 months without a guaranteed right to return ends employment for that test on the day after the 3rd month.</p>
      {stakeholder.leaveOfAbsence.length ? (
        <ul className="list-disc pl-4.5 text-xs" aria-label="Recorded leaves">
          {stakeholder.leaveOfAbsence.map((leave, index) => (
            <li key={`${leave.startDate}-${index}`}>
              {formatDate(leave.startDate)} → {leave.endDate ? formatDate(leave.endDate) : "open"} · return {leave.returnGuaranteed ? "guaranteed" : "not guaranteed"}
              {leave.endDate === null && closing?.startDate !== leave.startDate ? (
                <> <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => restart(leave)}>Record its end<span className="sr-only"> (the leave that started on {formatDate(leave.startDate)})</span></Button></>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-xs">No leave of absence recorded.</p>}
      <LeaveForm key={generation} stakeholder={stakeholder} closing={closing} onNewLeave={() => restart(null)} onRecorded={() => { restart(null); onRecorded(); }} />
    </Card>
  );
}

const LEAVE_FIELDS: FieldMap = {
  issue: (path) => (path === "startDate" ? "start" : path === "endDate" ? "end" : path === "documentId" ? "document" : null),
  violation: (violation) => ({ LEAVE_DATES: "end", LEAVE_START_IN_FUTURE: "start", LEAVE_OVERLAPS: "start", DOCUMENT_ARCHIVED: "document", DOCUMENT_IS_COMPANY_RESOURCE: "document", DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER: "document" } as Record<string, string>)[violation.code] ?? null,
};

/**
 * Records a leave, or the end of an open one (`closing`): the same command with the open leave's start date and the
 * end, which the engine keeps as that leave's later record. A new leave that overlaps a recorded one is refused (422
 * LEAVE_OVERLAPS); the form says so first and points to "Record its end" for an open leave.
 */
function LeaveForm({ stakeholder, closing, onNewLeave, onRecorded }: { stakeholder: api.StakeholderDetail; closing: Leave | null; onNewLeave: () => void; onRecorded: () => void }) {
  const { orgId, today } = useWorkspace();
  const toast = useToast();
  const [start, setStart] = useState(closing?.startDate ?? "");
  const [end, setEnd] = useState("");
  const [guaranteed, setGuaranteed] = useState(closing?.returnGuaranteed ?? false);
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const request = () => ({ stakeholderId: stakeholder.id, startDate: start, endDate: end || null, returnGuaranteed: guaranteed, ...(document ? { documentId: document.id } : {}) });
  const dryRun = (frozen: ReturnType<typeof request>, signal?: AbortSignal) => apiRequest(api.routes.recordLeaveOfAbsence, { params: { orgId }, dryRun: true, body: frozen, signal });
  const flow = useWriteFlow({
    request,
    preview: dryRun,
    body: ({ request: frozen, preview, acknowledge }) => ({ ...frozen, expectedLedgerSeq: preview!.ledgerSeq, expectedDiffSha256: preview!.diffSha256, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.recordLeaveOfAbsence, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request: frozen, preview }) => ledgerUnmoved(() => dryRun(frozen), preview!.ledgerSeq),
    fields: LEAVE_FIELDS,
    onCommitted: () => {
      toast({ message: closing ? `Leave of absence ended — ${stakeholder.displayName}` : `Leave of absence recorded — ${stakeholder.displayName}` });
      onRecorded();
    },
  });
  const editing = flow.phase === "edit" || flow.phase === "previewing";
  // Recording a leave with the start date of a recorded one corrects that leave (its end, its right to return).
  const corrects = closing ?? stakeholder.leaveOfAbsence.find((leave) => leave.startDate === start) ?? null;
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  const clear = (key: string) => {
    setErrors((current) => ({ ...current, [key]: undefined }));
    if (flow.problem?.kind === "invalid") flow.clearProblem();
  };
  const review = () => {
    const found: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) found.start = "Enter the date the leave started.";
    else if (start > today) found.start = "Record a leave once it has started.";
    if (closing && !end) found.end = "Enter the date the leave ended.";
    else if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) found.end = "Enter a date, or leave it empty while the leave is open.";
    else if (end && start && end < start) found.end = "The leave can't end before it starts.";
    if (!found.start && !found.end) {
      const other = overlappingLeave(stakeholder.leaveOfAbsence, start, end || null);
      if (other) {
        found.start = other.endDate === null
          ? `The leave that started on ${formatDate(other.startDate)} is still open: record its end first ("Record its end" above).`
          : `This overlaps the leave from ${formatDate(other.startDate)} to ${formatDate(other.endDate)}.`;
      }
    }
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  return (
    <section className="flex flex-col gap-4" aria-label="Record a leave of absence">
      {editing ? <FlowProblemBanner problem={flow.problem} onRetry={review} busy={flow.busy} /> : null}
      {closing ? (
        <p className="text-xs">
          Record the end of the leave that started on <b>{formatDate(closing.startDate)}</b>: it is sent with that start date, so it ends that leave rather than adding one.{" "}
          {editing ? <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onNewLeave}>Record a new leave instead</Button> : null}
        </p>
      ) : null}
      <fieldset className="flex max-w-140 min-w-0 flex-col gap-4" disabled={!editing}>
        <div className="grid gap-4 sm:grid-cols-2">
          <DateField label="Leave start" required max={today} value={start} disabled={closing !== null} onChange={(value) => { setStart(value); clear("start"); }} error={errorOf("start")} />
          <DateField label="Leave end" required={closing !== null} value={end} onChange={(value) => { setEnd(value); clear("end"); }} hint={closing ? "The day the leave ended." : "Empty while the leave is open."} error={errorOf("end")} />
        </div>
        <CheckLine checked={guaranteed} onChange={setGuaranteed}>Return guaranteed (by statute or contract)</CheckLine>
        <DocumentUpload label="Supporting document (optional)" kind="OTHER" value={document} onChange={(next) => { setDocument(next); clear("document"); }} error={errorOf("document")} disabled={!editing} />
      </fieldset>
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={review} disabled={flow.busy}>{flow.phase === "previewing" ? "Checking…" : "Review leave"}</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <FlowProblemBanner problem={flow.problem} onRetry={() => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
          {corrects && flow.request ? (
            <p className="text-xs" aria-label="What this records">
              {flow.request.endDate
                ? <>Ends the leave that started on <b>{formatDate(corrects.startDate)}</b> on <b>{formatDate(flow.request.endDate)}</b>, return {flow.request.returnGuaranteed ? "guaranteed" : "not guaranteed"}.</>
                : <>Records the leave that started on <b>{formatDate(corrects.startDate)}</b> again, still open, return {flow.request.returnGuaranteed ? "guaranteed" : "not guaranteed"}.</>}
              {" "}The stakeholder keeps one leave for that start date.
            </p>
          ) : null}
          {flow.preview ? <CommandPreview transactions={flow.preview.transactions} changes={flow.preview.changes} names={new Map([[stakeholder.id, stakeholder.displayName]])} /> : null}
          <WarningsToAcknowledge flow={flow as never} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={flow.edit} disabled={flow.busy || flow.locked}>Change the leave</Button>
            <Button type="button" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked || !flow.acknowledgedAll}>
              {flow.phase === "committing" ? "Recording…" : closing ? "Record its end" : "Record leave"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * "+ Add a new stakeholder…" inside the grant wizard: the few fields a new hire needs,
 * then the same review as the standalone page (the exact request), then Add.
 */
export function NewStakeholderCard({ stakeholders, onCreated, onUnsettledChange }: {
  stakeholders: readonly api.Stakeholder[];
  onCreated: (created: api.Stakeholder) => void;
  /**
   * Whether the create's outcome is unknown (being sent or checked, or a lost answer). The parent must then keep
   * everything that would unmount this card locked, or the body and key a retry must resend would be lost.
   */
  onUnsettledChange?: (unsettled: boolean) => void;
}) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [values, setValues] = useState<StakeholderValues>(EMPTY_STAKEHOLDER);
  const [errors, setErrors] = useState<StakeholderErrors>({});
  const set = <K extends keyof StakeholderValues>(field: K, value: StakeholderValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };
  const flow = useWriteFlow({
    request: () => createRequest(values),
    preview: null,
    body: ({ request, acknowledge }) => ({ ...request, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.createStakeholder, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: async ({ body, key }) => ({ result: await apiRequest(api.routes.createStakeholder, {
      params: { orgId }, body, idempotencyKey: key,
    }) }),
    fields: ISSUE_FIELDS,
    onCommitted: (created) => {
      toast(createdToast(created));
      onCreated(created);
    },
  });
  const unsettled = flow.unsettled;
  useEffect(() => {
    onUnsettledChange?.(unsettled);
  }, [unsettled, onUnsettledChange]);
  useEffect(() => () => onUnsettledChange?.(false), [onUnsettledChange]);
  const editing = flow.phase === "edit";
  const duplicate = duplicateOwner(stakeholders, values.email);
  const errorOf = (field: keyof StakeholderValues) => errors[field] ?? fieldProblem(flow.problem, field);
  const review = () => {
    const found = validateStakeholder(values, "create");
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const reviewed = flow.request;
  return (
    <UiCard className="mt-2 bg-muted/50" aria-label="New stakeholder">
      <CardContent className="flex flex-col gap-3">
      <h4 className="text-sm font-semibold">New stakeholder</h4>
      {editing ? <FlowProblemBanner problem={flow.problem} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Type" value={values.kind} onChange={(value) => set("kind", value as StakeholderValues["kind"])} options={[["individual", "Individual"], ["institution", "Institution"]]} disabled={!editing} />
        <TextField label="Legal name" required value={values.legalName} onChange={(value) => set("legalName", value)} error={errorOf("legalName")} disabled={!editing} />
        <TextField label={values.kind === "institution" ? "Contact e-mail" : "E-mail"} type="email" required={values.kind === "institution"} value={values.email} onChange={(value) => set("email", value)} hint={values.kind === "institution" ? CONTACT_HINT : EMAIL_HINT} error={errorOf("email")} disabled={!editing} />
        <SelectField label="Relationship" value={values.relationship} onChange={(value) => set("relationship", value as api.Relationship)} options={RELATIONSHIP_OPTIONS} disabled={!editing} />
        <DateField label="Hire date" value={values.hireDate} onChange={(value) => set("hireDate", value)} error={errorOf("hireDate")} disabled={!editing} />
      </div>
      {duplicate && editing ? <div><Banner kind="warn" title="Duplicate e-mail">{duplicate.displayName} already uses this e-mail. Pick them from the list, use another address, or merge the duplicate records later.</Banner></div> : null}
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={review}>Review</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <FlowProblemBanner problem={flow.problem} onRetry={() => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-4" aria-label="Review the new stakeholder">
            {reviewed ? (
              <DescriptionList rows={[
                ["Name", reviewed.displayName],
                ["Type", reviewed.kind === "institution" ? "Institution" : "Individual"],
                ["Relationship", RELATIONSHIP_LABELS[reviewed.relationship]],
                ["Hire date", reviewed.hireDate ? formatDate(reviewed.hireDate) : DASH],
                [values.kind === "institution" ? "Contact e-mail" : "E-mail", reviewed.emails[0]?.email ?? DASH],
              ]} />
            ) : null}
            <p className="text-xs text-muted-foreground">Added to the stakeholders now.</p>
          </div>
          <WarningsToAcknowledge flow={flow as never} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={flow.edit} disabled={flow.busy || flow.locked}>Back</Button>
            <Button type="button" size="sm" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked || !flow.acknowledgedAll}>
              {flow.phase === "committing" ? "Adding…" : "Add stakeholder"}
            </Button>
          </div>
        </div>
      )}
      </CardContent>
    </UiCard>
  );
}
