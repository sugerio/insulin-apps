import { useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { hasAdminAccess } from "../auth/access.ts";
import { Banner, ErrorState, Loading } from "../components/Feedback.tsx";
import { ImportWizard } from "../components/ImportWizard.tsx";
import { Breadcrumbs, Card, PageHead } from "../components/Page.tsx";
import { plural } from "../lib/format.ts";
import { useDocumentTitle } from "../lib/useDocumentTitle.ts";
import { useResource } from "../lib/useResource.ts";

// Import for a company that exists but is empty (set up with "Start with an empty company"): owners and admins import
// its cap table from Pulley's exports or the Cap Table spreadsheet while it has no stakeholders and no transactions.
// Editors are told who can; holders never get here. The page sits beside the company workspace, not inside it: an
// import creates a new company and retires the empty one, so once it is done the app switches companies under this
// page, and the result has to stay on screen while it does.

export function ImportPage() {
  useDocumentTitle("Import the cap table");
  const me = useMe();
  const { orgId = "" } = useParams();
  const [imported, setImported] = useState(false);
  if (!imported) {
    if (me.company === null) return <Navigate to="/setup" replace />;
    if (!hasAdminAccess(me)) return <Navigate to="/no-access" replace />;
    // One company per app: an address with another company's id (one an import retired) leads home.
    if (me.company.id !== orgId) return <Navigate to="/" replace />;
  }
  const company = me.company;
  return (
    <section className="page">
      <Breadcrumbs items={[[company?.displayName ?? "Cap Table", company ? `/companies/${company.id}/dashboard` : "/"], ["Import"]]} />
      <PageHead title="Import the cap table" sub="Set up this company from Pulley's exports or the Cap Table spreadsheet." />
      {me.access === "admin_rw" || imported ? <ImportGate orgId={orgId} onImported={() => setImported(true)} /> : <ReadOnly back={`/companies/${orgId}/dashboard`} />}
    </section>
  );
}

function ReadOnly({ back }: { back: string }) {
  return (
    <Card>
      <Banner kind="info" title="Only owners and admins can import">
        You can view this company's cap table. Setting it up from Pulley or a spreadsheet takes an owner or admin of the app.
      </Banner>
      <div className="row mt-12"><Link className="btn btn-ghost" to={back}>Back to the dashboard</Link></div>
    </Card>
  );
}

/** The wizard, once the company is known to be empty; otherwise why import isn't available. */
function ImportGate({ orgId, onImported }: { orgId: string; onImported: () => void }) {
  // The stakeholder list carries the ledger's head too: one read answers both questions.
  const company = useResource((signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }), [orgId]);
  if (company.data === undefined) {
    return company.error !== undefined ? <ErrorState error={company.error} onRetry={company.reload} /> : <Loading label="Checking the company…" />;
  }
  const stakeholders = company.data.items.length;
  const transactions = company.data.ledgerSeq > 0;
  if (stakeholders > 0 || transactions) {
    const has = [stakeholders > 0 ? plural(stakeholders, "stakeholder") : null, transactions ? "recorded transactions" : null].filter(Boolean).join(" and ");
    return (
      <Card>
        <Banner kind="info" title="Import isn't available for this company">
          An import sets up a company whose cap table is empty. This one already has {has}, and importing on top of them could
          duplicate or contradict what is recorded. Keep recording changes in the cap table instead.
        </Banner>
        <div className="row mt-12"><Link className="btn btn-ghost" to={`/companies/${orgId}/dashboard`}>Back to the dashboard</Link></div>
      </Card>
    );
  }
  return <ImportWizard onImported={onImported} />;
}
