import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { WriteButton } from "../components/Actions.tsx";
import { CompanyContactDialog, DisplayDialog, OrgProfileDialog } from "../components/flows/OrgDialogs.tsx";
import { PAYMENT_LABELS, PaymentInstructionsDialog } from "../components/flows/PaymentDialogs.tsx";
import { DataTable } from "../components/DataTable.tsx";
import { DescriptionList, KeyValueGrid } from "../components/DescriptionList.tsx";
import { Badge, Pending, ResourceView } from "../components/Feedback.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { DASH, formatDate } from "../lib/format.ts";
import { SIGNATORY_TYPES, signatoryTypeLabel } from "../lib/labels.ts";
import { addressLine } from "../lib/stakeholders.ts";
import { useResource, type Resource } from "../lib/useResource.ts";

// Company › Profile & Settings: one page with an anchored section menu. Owners and admins edit; editors view. Who may
// use the app, and in which role, is managed in the Insulin console, not here. The writes: the profile, the holder
// contact, the payment instructions and display.

type Dialog = { kind: "profile" } | { kind: "contact" } | { kind: "display" };

const SECTIONS = [
  ["profile", "Company profile"],
  ["signatories", "Signatories"],
  ["contact", "Holder contact"],
  ["payment", "Payment instructions"],
  ["display", "Display"],
] as const;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const STATES: Record<string, string> = { "US-DE": "Delaware", "US-CA": "California", "US-NY": "New York", "US-NV": "Nevada", "US-WY": "Wyoming" };

/** "December 31" from the org's `MM-DD` fiscal year end. */
function fiscalYearEnd(value: string): string {
  const [month, day] = value.split("-").map(Number);
  return month && day ? `${MONTH_NAMES[month - 1]} ${day}` : value;
}

export function CompanyPage() {
  const workspace = useWorkspace();
  const { orgId, readOnly, href, reloadOrg } = workspace;
  const location = useLocation();
  const org = useResource((signal) => apiRequest(api.routes.getOrg, { params: { orgId }, signal }), [orgId]);
  const instructions = useResource((signal) => apiRequest(api.routes.getPaymentInstructions, { params: { orgId }, signal }), [orgId]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  // A settings write changes what every page shows (the name, decimals): read the company again everywhere.
  const orgSaved = () => {
    org.reload();
    reloadOrg();
  };
  // Opened from a "company#display" link: show that section once the page has rendered.
  useEffect(() => {
    if (!org.data || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView?.({ block: "start" });
  }, [org.data, location.hash]);
  return (
    <Page title="Profile & Settings" crumbs={[["Company", href("company")], ["Profile & Settings"]]}>
      <PageHead title="Profile & Settings" sub={readOnly ? "View only — owners and admins edit." : "Owners and admins edit; editors view."} />
      <ResourceView resource={org}>
        {(data) => (
          <div className="settings-layout">
            <div className="stack">
              <ProfileSection org={data} onEdit={() => setDialog({ kind: "profile" })} />
              <SignatoriesSection />
              <Card id="contact" title="Company contact for holders" right={<WriteButton label="Edit" size="sm" ariaLabel="Edit the company contact" onClick={() => setDialog({ kind: "contact" })} />}>
                <DescriptionList
                  rows={[
                    ["Name", data.settings.companyContact?.name ?? DASH],
                    ["E-mail (shown to holders in the portal)", data.settings.companyContact?.email ?? DASH],
                  ]}
                />
              </Card>
              <PaymentSection instructions={instructions} />
              <Card id="display" title="Display" right={<WriteButton label="Edit" size="sm" ariaLabel="Edit the display decimals" onClick={() => setDialog({ kind: "display" })} />}>
                <DescriptionList
                  rows={[
                    ["Decimals for share quantities", String(data.settings.display.shareDecimals)],
                    ["Decimals for prices", String(data.settings.display.priceDecimals)],
                  ]}
                />
              </Card>
            </div>
            <nav className="anchor-nav" aria-label="Settings sections">
              {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} onClick={(event) => { event.preventDefault(); document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" }); }}>{label}</a>)}
            </nav>
            {dialog?.kind === "profile" ? <OrgProfileDialog org={data} onClose={close} onDone={() => { close(); orgSaved(); }} /> : null}
            {dialog?.kind === "contact" ? <CompanyContactDialog org={data} onClose={close} onDone={() => { close(); orgSaved(); }} /> : null}
            {dialog?.kind === "display" ? <DisplayDialog org={data} onClose={close} onDone={() => { close(); orgSaved(); }} /> : null}
          </div>
        )}
      </ResourceView>
    </Page>
  );
}

function ProfileSection({ org, onEdit }: { org: api.Org; onEdit: () => void }) {
  return (
    <Card id="profile" title="Company Profile" right={<WriteButton label="Edit" size="sm" ariaLabel="Edit the company profile" onClick={onEdit} />}>
      <KeyValueGrid
        rows={[
          ["Company name", org.displayName],
          ["Legal name", org.legalName],
          ["State of incorporation", STATES[org.jurisdiction] ?? org.jurisdiction],
          ["Incorporation date", formatDate(org.incorporationDate)],
          ["Entity type", org.entityType === "C_CORPORATION" ? "C-corporation" : org.entityType],
          ["Address", addressLine(org.address) ?? DASH],
          ["Timezone", org.timezone],
          ["EIN", org.ein ?? DASH],
          ["Fiscal year end", fiscalYearEnd(org.fiscalYearEnd)],
          ["Share unit", `${org.shareUnit}${org.shareUnitFrozen ? " (frozen: the ledger has transactions)" : ""}`],
        ]}
      />
    </Card>
  );
}

interface SignatoryRow {
  key: string;
  type: string;
  order: number;
  signatory: api.OrgSignatory;
}

/** One row per signatory type and person, in a fixed type order; view only. */
function signatoryRows(items: readonly api.OrgSignatory[]): SignatoryRow[] {
  const orderOf = (capability: string) => {
    const index = SIGNATORY_TYPES.findIndex(([key]) => key === capability.toLowerCase());
    return index === -1 ? SIGNATORY_TYPES.length : index;
  };
  return items
    .flatMap((signatory) => (signatory.capabilities.length ? signatory.capabilities : [""]).map((capability) => ({
      key: `${signatory.id}-${capability}`,
      type: capability ? signatoryTypeLabel(capability) : DASH,
      order: capability ? orderOf(capability) : SIGNATORY_TYPES.length + 1,
      signatory,
    })))
    .sort((a, b) => a.order - b.order || a.type.localeCompare(b.type) || a.signatory.name.localeCompare(b.signatory.name));
}

function SignatoriesSection() {
  const { orgId } = useWorkspace();
  const signatories = useResource((signal) => apiRequest(api.routes.listSignatories, { params: { orgId }, signal }), [orgId]);
  return (
    <Card id="signatories" title="Signatories" right={<span className="small muted">View only</span>}>
      <Pending resource={signatories} what="the signatories">
        {(data) => (
          <DataTable
            id="signatories"
            label="Signatories"
            rows={signatoryRows(data.items)}
            rowKey={(row) => row.key}
            toolbar={false}
            paginate={false}
            empty="No signatories yet."
            columns={[
              { key: "type", label: "Type", render: (row) => row.type },
              { key: "person", label: "Person", render: (row) => <>{row.signatory.name}{row.signatory.active ? null : <> <Badge tone="grey">Inactive</Badge></>}</> },
              { key: "title", label: "Title", render: (row) => row.signatory.title ?? DASH },
            ]}
          />
        )}
      </Pending>
      <p className="small muted mt-8">Signatories come in with the import. The app doesn't collect electronic signatures.</p>
    </Card>
  );
}

function PaymentSection({ instructions }: { instructions: Resource<api.PaymentInstruction | null> }) {
  const { format } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const current = instructions.data ?? null;
  return (
    <Card id="payment" title="Payment instructions" right={instructions.data !== undefined ? <WriteButton label={current ? "Edit" : "Set up"} size="sm" ariaLabel={current ? "Edit the payment instructions" : "Set up the payment instructions"} onClick={() => setEditing(true)} /> : null}>
      <p className="small muted">Shown to holders <b>only inside the portal</b> (How to exercise).</p>
      <ResourceView resource={instructions}>
        {(data) => data ? (
          <DescriptionList
            rows={[
              ...(Object.keys(PAYMENT_LABELS) as (keyof api.PaymentInstructionDetails)[]).map((key) => [
                PAYMENT_LABELS[key],
                key === "referenceFormat" ? <span className="mono">{data.details.referenceFormat}</span> : data.details[key] ?? DASH,
              ] as [string, ReactNode]),
              ["Last changed", `${format.dateTime(data.updatedAt)}${data.updatedBy ? ` by ${data.updatedBy}` : ""}`],
            ]}
          />
        ) : (
          <p className="muted small">No payment instructions yet.</p>
        )}
      </ResourceView>
      {editing ? <PaymentInstructionsDialog current={current} onClose={() => setEditing(false)} onDone={() => { setEditing(false); instructions.reload(); }} /> : null}
    </Card>
  );
}
