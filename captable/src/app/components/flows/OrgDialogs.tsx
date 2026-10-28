import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { fieldProblem, useWriteFlow, type FieldMap } from "../../lib/flow.ts";
import { DASH } from "../../lib/format.ts";
import {
  FISCAL_YEAR_ENDS, hasOrgChanges, JURISDICTIONS, ORG_FIELD_LABELS, orgIssueField, orgProfilePatch, orgValuesOf, rebaseOrg, timezones, validateOrgProfile,
  type OrgProfileErrors, type OrgProfileValues, type OrgServerChange,
} from "../../lib/org.ts";
import { DateField, SelectField, TextField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// Company › Profile & Settings writes: owners and admins. Every one is
// `PATCH /api/orgs/:orgId` with the version read, reviewed before it is sent. A settings section replaces its section
// whole. A stale answer (409 stale_version) reads the org again; the profile keeps only the admin's own edits on top of
// the fresh record and says what someone else changed.

const ORG_FIELDS: FieldMap = {
  issue: (path) => orgIssueField(path),
  violation: (violation) => (violation.code === "SHARE_UNIT_FROZEN" ? "shareUnit" : null),
};

/** After a lost answer: a recorded PATCH moves the version on; the same version means nothing was written. */
async function orgUnchanged(orgId: string, version: number): Promise<"not_recorded" | "unknown"> {
  return (await apiRequest(api.routes.getOrg, { params: { orgId } })).version === version ? "not_recorded" : "unknown";
}

interface OrgDialogProps {
  org: api.Org;
  onClose: () => void;
  onDone: (org: api.Org) => void;
}

/** "Edit" on the company profile: the profile fields, and the share unit while the ledger is empty. */
export function OrgProfileDialog({ org, onClose, onDone }: OrgDialogProps) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [base, setBase] = useState(org);
  const [values, setValues] = useState<OrgProfileValues>(() => orgValuesOf(org));
  const [errors, setErrors] = useState<OrgProfileErrors>({});
  const [serverChanges, setServerChanges] = useState<readonly OrgServerChange[]>([]);
  const set = (key: keyof OrgProfileValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };
  const flow = useWriteFlow({
    request: () => orgProfilePatch(values, base),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.patchOrg, { params: { orgId }, body, idempotencyKey: key }),
    refresh: async () => {
      const fresh = await apiRequest(api.routes.getOrg, { params: { orgId } });
      const rebased = rebaseOrg(values, base, fresh);
      setBase(fresh);
      setValues(rebased.values);
      setServerChanges(rebased.changes);
    },
    reconcile: ({ request }) => orgUnchanged(orgId, request.version),
    fields: ORG_FIELDS,
    onCommitted: (updated) => {
      toast({ message: "Company profile saved" });
      onDone(updated);
    },
  });
  const reviewed = flow.request;
  const nothingLeft = reviewed !== null && !hasOrgChanges(reviewed);
  const errorOf = (key: keyof OrgProfileValues) => errors[key] ?? fieldProblem(flow.problem, key);
  const review = () => {
    const found = validateOrgProfile(values, base);
    if (!Object.keys(found).length && !hasOrgChanges(orgProfilePatch(values, base))) found.displayName = "Nothing has changed.";
    setErrors(found);
    if (Object.keys(found).length === 0) {
      setServerChanges([]);
      void flow.review();
    }
  };
  const before = orgValuesOf(base);
  const changed = (Object.keys(ORG_FIELD_LABELS) as (keyof OrgProfileValues)[]).filter((key) => values[key].trim() !== before[key].trim());
  const shown = (key: keyof OrgProfileValues, value: string) => (key === "jurisdiction" ? JURISDICTIONS.find(([code]) => code === value)?.[1] ?? value
    : key === "fiscalYearEnd" ? FISCAL_YEAR_ENDS.find(([code]) => code === value)?.[1] ?? value : value || DASH);
  return (
    <FlowDialog
      title="Edit company profile"
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Save profile"
      confirmReady={!nothingLeft}
      review={
        <>
          {serverChanges.length ? (
            <div className="review-panel mb-8" aria-label="Changed on the server">
              <h3>Changed by someone else while you were editing</h3>
              {serverChanges.map((change) => (
                <div className="change-row" key={change.field}>
                  <span>{ORG_FIELD_LABELS[change.field]}</span>
                  <span className="cv">{shown(change.field, change.before)}<span className="arrow" aria-label="became">→</span><b>{shown(change.field, change.after)}</b>{change.conflict ? <span className="small"> · you edited this too: your value replaces it if you save</span> : null}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="review-panel" aria-label="Review">
            {nothingLeft ? <p>Nothing left to save: the company profile already has these values.</p> : (
              <div aria-label="Changes">
                {changed.map((key) => (
                  <div className="change-row" key={key}>
                    <span>{ORG_FIELD_LABELS[key]}</span>
                    <span className="cv">{shown(key, before[key])}<span className="arrow" aria-label="becomes">→</span><b>{shown(key, values[key].trim())}</b></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      }
    >
      <div className="form-grid">
        <TextField label="Company name" required value={values.displayName} onChange={(value) => set("displayName", value)} error={errorOf("displayName")} />
        <TextField label="Legal name" required value={values.legalName} onChange={(value) => set("legalName", value)} error={errorOf("legalName")} />
        <SelectField label="State of incorporation" value={values.jurisdiction} onChange={(value) => set("jurisdiction", value)} error={errorOf("jurisdiction")}
          options={JURISDICTIONS.some(([code]) => code === values.jurisdiction) ? JURISDICTIONS : [[values.jurisdiction, values.jurisdiction], ...JURISDICTIONS]} />
        <DateField label="Incorporation date" value={values.incorporationDate} onChange={(value) => set("incorporationDate", value)} error={errorOf("incorporationDate")} />
        <SelectField label="Timezone" value={values.timezone} onChange={(value) => set("timezone", value)} error={errorOf("timezone")} options={timezones(values.timezone).map((zone) => [zone, zone] as const)} />
        <SelectField label="Fiscal year end" value={values.fiscalYearEnd} onChange={(value) => set("fiscalYearEnd", value)} error={errorOf("fiscalYearEnd")}
          options={FISCAL_YEAR_ENDS.some(([code]) => code === values.fiscalYearEnd) ? FISCAL_YEAR_ENDS : [[values.fiscalYearEnd, values.fiscalYearEnd], ...FISCAL_YEAR_ENDS]} />
        <TextField label="EIN" value={values.ein} onChange={(value) => set("ein", value)} placeholder="12-3456789" hint="Shown masked to anyone who may not see personal data." error={errorOf("ein")} />
        <TextField label="Share unit" value={values.shareUnit} onChange={(value) => set("shareUnit", value)} disabled={base.shareUnitFrozen} error={errorOf("shareUnit")}
          hint={base.shareUnitFrozen ? "Frozen: the ledger already has transactions, so the smallest share quantity can't change." : "The smallest share quantity, e.g. 1 for whole shares. It can change only while the ledger is empty."} />
      </div>
      <h3>Address</h3>
      <div className="form-grid">
        <TextField className="full" label="Address" value={values.line1} onChange={(value) => set("line1", value)} placeholder="Street and number" error={errorOf("line1")} />
        <TextField label="Address line 2" value={values.line2} onChange={(value) => set("line2", value)} />
        <TextField label="City" value={values.city} onChange={(value) => set("city", value)} error={errorOf("city")} />
        <TextField label="State or region" value={values.region} onChange={(value) => set("region", value)} />
        <TextField label="Postal code" value={values.postalCode} onChange={(value) => set("postalCode", value)} />
        <TextField label="Country" value={values.country} onChange={(value) => set("country", value)} placeholder="US" hint="Two-letter code." error={errorOf("country")} />
      </div>
    </FlowDialog>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Company contact for holders": shown to holders in the portal. */
export function CompanyContactDialog({ org, onClose, onDone }: OrgDialogProps) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  // The org as last read: a stale answer reads it again, and the review names the contact stored now.
  const [base, setBase] = useState(org);
  const [name, setName] = useState(org.settings.companyContact?.name ?? "");
  const [email, setEmail] = useState(org.settings.companyContact?.email ?? "");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const flow = useWriteFlow({
    request: () => ({ version: base.version, settings: { companyContact: { name: name.trim(), email: email.trim() } } }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.patchOrg, { params: { orgId }, body, idempotencyKey: key }),
    refresh: async () => setBase(await apiRequest(api.routes.getOrg, { params: { orgId } })),
    reconcile: ({ request }) => orgUnchanged(orgId, request.version),
    fields: { issue: (path) => (path.endsWith("companyContact.name") ? "name" : path.endsWith("companyContact.email") ? "email" : null) },
    onCommitted: (updated) => {
      toast({ message: "Company contact saved — holders see it in the portal" });
      onDone(updated);
    },
  });
  const review = () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = "Enter the contact's name.";
    else if (name.trim().length > 200) found.name = "At most 200 characters.";
    if (!EMAIL.test(email.trim())) found.email = "Enter a valid e-mail address.";
    else if (email.trim().length > 254) found.email = "At most 254 characters.";
    const stored = base.settings.companyContact;
    if (!Object.keys(found).length && stored && stored.name === name.trim() && stored.email === email.trim()) found.name = "Nothing has changed.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  const current = base.settings.companyContact;
  return (
    <FlowDialog
      title="Company contact for holders"
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Save contact"
      review={
        <div className="review-panel" aria-label="Review">
          <p>Holders see <b>{name.trim()}</b> · <b>{email.trim()}</b> in the portal{current ? ` (instead of ${current.name} · ${current.email})` : ""}.</p>
        </div>
      }
    >
      <TextField label="Name" required value={name} onChange={(value) => { setName(value); setErrors((previous) => ({ ...previous, name: undefined })); }} placeholder="e.g. Equity team" error={errorOf("name")} />
      <TextField label="Role e-mail" type="email" required value={email} onChange={(value) => { setEmail(value); setErrors((previous) => ({ ...previous, email: undefined })); }} placeholder="equity@company.example" hint="A shared mailbox, not a person's own address." error={errorOf("email")} />
    </FlowDialog>
  );
}

/** "Display": the decimals shares and prices are shown with (0–4 and 2–6). */
export function DisplayDialog({ org, onClose, onDone }: OrgDialogProps) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [base, setBase] = useState(org);
  const [shareDecimals, setShareDecimals] = useState(String(org.settings.display.shareDecimals));
  const [priceDecimals, setPriceDecimals] = useState(String(org.settings.display.priceDecimals));
  const flow = useWriteFlow({
    request: () => ({ version: base.version, settings: { display: { shareDecimals: Number(shareDecimals), priceDecimals: Number(priceDecimals) } } }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.patchOrg, { params: { orgId }, body, idempotencyKey: key }),
    refresh: async () => setBase(await apiRequest(api.routes.getOrg, { params: { orgId } })),
    reconcile: ({ request }) => orgUnchanged(orgId, request.version),
    onCommitted: (updated) => {
      toast({ message: "Display saved" });
      onDone(updated);
    },
  });
  const unchanged = Number(shareDecimals) === base.settings.display.shareDecimals && Number(priceDecimals) === base.settings.display.priceDecimals;
  return (
    <FlowDialog
      title="Display"
      flow={flow as never}
      onClose={onClose}
      onReview={() => void flow.review()}
      confirmLabel="Save display"
      confirmReady={!unchanged}
      review={
        <div className="review-panel" aria-label="Review">
          {unchanged ? <p>Nothing to save: these are the current decimals.</p> : (
            <p>Share quantities with <b>{shareDecimals}</b> decimal{shareDecimals === "1" ? "" : "s"}, prices with <b>{priceDecimals}</b>. Every page and export shows figures this way; nothing on the ledger changes.</p>
          )}
        </div>
      }
    >
      <div className="form-grid">
        <SelectField label="Share quantity decimals" value={shareDecimals} onChange={setShareDecimals} options={["0", "1", "2", "3", "4"].map((value) => [value, value] as const)} />
        <SelectField label="Price decimals" value={priceDecimals} onChange={setPriceDecimals} options={["2", "3", "4", "5", "6"].map((value) => [value, value] as const)} />
      </div>
    </FlowDialog>
  );
}
