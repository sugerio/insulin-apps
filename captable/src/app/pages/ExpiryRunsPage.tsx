import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { Badge, EmptyState, InlineError, ResourceView } from "../components/Feedback.tsx";
import { ExpiryRunReview, ExpiryRunView } from "../components/flows/ExpiryRunReview.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { EXPIRY_RUN_STATE_LABELS } from "../lib/expiry.ts";
import { formatDate } from "../lib/format.ts";
import { useResource } from "../lib/useResource.ts";

// Expiry runs. The dashboard's Needs attention
// line "Expiry run to confirm" leads here. There is no scheduler: due items are processed when an admin opens the app
// or uses "Process due items". While expiry is report-only, a run that finds options or warrants past their last
// exercise day is recorded instead of expiring them. Admins and editors read the runs pending confirmation
// (`GET …/expiry-runs`) and each run's proposals (`GET …/expiry-runs/:runId`); owners and admins check and confirm a
// pending run (ExpiryRunReview), and may switch the company to automatic expiry.

export function ExpiryRunsPage() {
  return (
    <Page title="Expiry runs" crumbs={[["Expiry runs"]]}>
      <ExpiryRunsBody />
    </Page>
  );
}

function ExpiryRunsBody() {
  const { orgId, org, format, canWrite } = useWorkspace();
  const runs = useResource((signal) => apiRequest(api.routes.listExpiryRuns, { params: { orgId }, signal }), [orgId]);
  // The run open below the list. A reload of the list never replaces it mid-confirmation: the panel reads it once.
  const [open, setOpen] = useState<number | null>(null);
  const automatic = org.settings.expiry.mode === "automatic";
  return (
    <>
      <Card>
        <PageHead
          title="Expiry runs"
          sub="While expiry is report-only, processing due items records what it would expire as a run for an admin to confirm, instead of expiring it."
        />
        <p className="small">
          Expiry mode: <b>{automatic ? "Automatic" : "Report-only"}</b>
          {automatic ? " — processing due items expires options and warrants past their last exercise day without review." : " — until an admin confirms a run and switches to automatic."}
          {canWrite ? null : " Only an owner or admin confirms a run."}
        </p>
        <ResourceView resource={runs}>
          {(data) => data.items.length === 0 ? (
            <EmptyState>
              No expiry run is waiting for confirmation.{" "}
              {automatic ? "Expiry is automatic, so none is recorded." : "One is recorded when processing due items finds something past its last exercise day."}
            </EmptyState>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl" aria-label="Expiry runs pending confirmation">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Recorded</th>
                    <th scope="col" className="num">Proposed expiries</th>
                    <th scope="col">Status</th>
                    <th scope="col"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((run) => {
                    const label = `run of ${formatDate(run.localDate)}`;
                    const action = canWrite && run.state === "pending" ? "Review" : "View";
                    return (
                      <tr key={run.runId}>
                        <td>Run of {formatDate(run.localDate)}</td>
                        <td>{format.dateTime(run.startedAt)}</td>
                        <td className="num">{run.proposalCount}</td>
                        <td><Badge tone={run.state === "pending" ? "amber" : "grey"}>{EXPIRY_RUN_STATE_LABELS[run.state]}</Badge></td>
                        <td className="right">
                          <button type="button" className="btn btn-sm" disabled={open !== null} aria-label={`${action} the ${label}`} onClick={() => setOpen(run.runId)}>{action}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </ResourceView>
      </Card>
      {open !== null ? <ExpiryRunPanel key={open} runId={open} onClose={() => { setOpen(null); runs.reload(); }} onChanged={runs.reload} /> : null}
    </>
  );
}

/** One run, read once when opened: an admin's review of a pending run, or a read-only view for everyone else. */
function ExpiryRunPanel({ runId, onClose, onChanged }: { runId: number; onClose: () => void; onChanged: () => void }) {
  const { orgId, canWrite, readOnly, writeRestriction } = useWorkspace();
  const detail = useResource((signal) => apiRequest(api.routes.getExpiryRun, { params: { orgId, runId }, signal }), [orgId, runId]);
  if (detail.error !== undefined) {
    return (
      <Card>
        <InlineError what="this run" error={detail.error} onRetry={detail.reload} />
        <div className="row mt-12"><button type="button" className="btn btn-ghost" onClick={onClose}>Back to the runs</button></div>
      </Card>
    );
  }
  if (!detail.data) return <Card><p className="muted" role="status">Loading the run…</p></Card>;
  const run = detail.data;
  if (canWrite && run.state === "pending") return <ExpiryRunReview run={run} onClose={onClose} onChanged={onChanged} />;
  const note = readOnly
    ? "Only an owner or admin can confirm an expiry run. This is what it proposes, and what confirming would cancel today."
    : writeRestriction
      ? `${writeRestriction.text} This run can't be confirmed now.`
      : run.state === "confirming"
        ? "A confirmation of this run is under way or stopped. Only that confirmation can finish it: resending it with the same request resumes it."
        : `This run is ${EXPIRY_RUN_STATE_LABELS[run.state].toLowerCase()}: there is nothing to confirm.`;
  return <ExpiryRunView run={run} note={note} onClose={onClose} />;
}
