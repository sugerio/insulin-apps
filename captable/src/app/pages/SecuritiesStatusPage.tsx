import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { OwnRecordScope, WriteButton } from "../components/Actions.tsx";
import { DataTable, byDecimal, byDisplayId, byNumber, byText, type Column } from "../components/DataTable.tsx";
import { Badge, ResourceView } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { HolderLink, SecurityLink, holderState } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { CancelScheduledTerminationDialog } from "../components/flows/CancelScheduledTerminationDialog.tsx";
import { CancelSecurityDialog } from "../components/flows/CancelSecurityDialog.tsx";
import { MarkExecutedDialog } from "../components/flows/MarkExecutedDialog.tsx";
import { DASH, daysBetween, formatDate } from "../lib/format.ts";
import { MISSING_LABELS, TERMINATION_TYPE_LABELS } from "../lib/labels.ts";
import { allOf, useResource } from "../lib/useResource.ts";

// Securities Status: the queues that need admin attention, one card per section with a one-line
// explainer and a 10-row table; an empty section collapses to one line. Actions are for owners and admins; none show
// on the admin's own holdings. Mark executed, Cancel and Reverse (a scheduled termination's cancellation) open their
// dialogs, and the queues are read again after each.

type StatusDialog =
  | { kind: "markExecuted"; securityId: string }
  | { kind: "cancel"; securityId: string; reason: "NOT_EXECUTED" | "HOLDER_WAIVER" }
  | { kind: "cancelScheduled"; id: string; stakeholderName: string };

const REPURCHASE_LABELS = { open: ["Window open", "teal"], closing_soon: ["Closing soon", "amber"], lapsed: ["Lapsed", "red"], not_recorded: ["Not recorded", "grey"] } as const;

interface Lookups {
  securities: ReadonlyMap<string, api.Security>;
  stakeholders: ReadonlyMap<string, api.Stakeholder>;
}

function Section<T>(props: { id: string; title: string; explainer: string; rows: readonly T[]; empty: string; columns: Column<T>[]; rowKey: (row: T) => string; extra?: ReactNode }) {
  const headingId = `${props.id}-title`;
  return (
    <Card id={props.id} className={props.rows.length ? undefined : "collapsed"} labelledBy={headingId}>
      <div className="card-h">
        <div style={{ flex: 1 }}>
          <h2 id={headingId}>{props.title} <span className="sb-count">{props.rows.length}</span></h2>
          <div className="muted mt-4">{props.explainer}</div>
        </div>
      </div>
      {props.extra}
      {props.rows.length ? (
        <DataTable id={`ss-${props.id}`} label={props.title} rows={props.rows} rowKey={props.rowKey} columns={props.columns} toolbar={false} paginate={props.rows.length > 10} />
      ) : (
        <p className="muted small">{props.empty}</p>
      )}
    </Card>
  );
}

export function SecuritiesStatusPage() {
  const { orgId, href } = useWorkspace();
  const status = useResource((signal) => apiRequest(api.routes.getSecuritiesStatus, { params: { orgId }, signal }), [orgId]);
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, signal }), [orgId]);
  const stakeholders = useResource((signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }), [orgId]);
  const [dialog, setDialog] = useState<StatusDialog | null>(null);
  const done = () => {
    setDialog(null);
    status.reload();
    securities.reload();
  };
  return (
    <Page title="Securities Status" crumbs={[["Cap Table", href("captable")], ["Securities Status"]]}>
      <Card><PageHead title="Securities Status" sub="The queues that need admin attention." /></Card>
      {/* Names, badges and the outstanding quantities come from the lookups: the queues wait for them. */}
      <ResourceView resource={allOf(status, securities, stakeholders)}>
        {([data, securityList, stakeholderList]) => (
          <StatusSections
            onAction={setDialog}
            data={data}
            lookups={{
              securities: new Map(securityList.items.map((item) => [item.id, item])),
              stakeholders: new Map(stakeholderList.items.map((item) => [item.id, item])),
            }}
          />
        )}
      </ResourceView>
      {dialog?.kind === "markExecuted" ? <MarkExecutedDialog securityId={dialog.securityId} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "cancel" ? <CancelSecurityDialog securityId={dialog.securityId} defaultReason={dialog.reason} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "cancelScheduled" ? <CancelScheduledTerminationDialog scheduledTerminationId={dialog.id} stakeholderName={dialog.stakeholderName} onClose={() => setDialog(null)} onDone={done} /> : null}
    </Page>
  );
}

function StatusSections({ data, lookups, onAction }: { data: api.SecuritiesStatus; lookups: Lookups; onAction: (dialog: StatusDialog) => void }) {
  const workspace = useWorkspace();
  const { format, today, href } = workspace;
  const holder = (stakeholderId: string, fallback?: string) => {
    const stakeholder = lookups.stakeholders.get(stakeholderId);
    return <HolderLink id={stakeholderId} name={stakeholder?.displayName ?? fallback ?? "Stakeholder"} state={holderState(stakeholder)} />;
  };
  const holderName = (stakeholderId: string) => lookups.stakeholders.get(stakeholderId)?.displayName ?? lookups.securities.get(stakeholderId)?.stakeholderName ?? "";
  const security = (securityId: string, displayId?: string) => {
    const known = lookups.securities.get(securityId);
    return <SecurityLink id={securityId} family={known?.family ?? "EQUITY_COMPENSATION"} displayId={displayId ?? known?.displayId ?? "Security"} />;
  };
  const displayIdOf = (securityId: string) => lookups.securities.get(securityId)?.displayId ?? "";
  const days = (date: string) => <span className="muted small"> ({daysBetween(today, date)} days)</span>;

  return (
    <>
      <Section
        id="exec"
        title="Execution pending (migrated)"
        explainer="Grants migrated with missing signatures. They count in fully diluted and plan usage, and cannot be exercised until marked executed."
        rows={data.executionPending}
        rowKey={(row) => row.securityId}
        empty="No grants are awaiting signatures."
        columns={[
          { key: "id", label: "Security", render: (row) => security(row.securityId, row.displayId), compare: byDisplayId((row) => row.displayId) },
          { key: "holder", label: "Stakeholder", render: (row) => holder(row.stakeholderId), compare: byText((row) => holderName(row.stakeholderId)) },
          { key: "date", label: "Issue date", render: (row) => formatDate(row.issueDate), compare: byText((row) => row.issueDate) },
          { key: "missing", label: "Missing", render: (row) => <Badge tone="amber">{MISSING_LABELS[row.missing]}</Badge> },
          {
            key: "actions", label: "",
            render: (row) => (
              <OwnRecordScope own={workspace.isOwn(row.stakeholderId)}>
                <div className="row nowrap">
                  <WriteButton label="Mark executed" kind="primary" size="xs" ariaLabel={`Mark ${row.displayId} executed`} onClick={() => onAction({ kind: "markExecuted", securityId: row.securityId })} />
                  <WriteButton label="Cancel" size="xs" ariaLabel={`Cancel ${row.displayId}`} onClick={() => onAction({ kind: "cancel", securityId: row.securityId, reason: "NOT_EXECUTED" })} />
                </div>
              </OwnRecordScope>
            ),
          },
        ]}
      />
      <Section
        id="sched"
        title="Scheduled terminations"
        explainer="Terminations recorded with a future date. Vesting continues until then; fully diluted is unchanged."
        rows={data.scheduledTerminations}
        rowKey={(row) => row.id}
        empty="No scheduled terminations."
        columns={[
          { key: "holder", label: "Stakeholder", render: (row) => holder(row.stakeholderId), compare: byText((row) => holderName(row.stakeholderId)) },
          { key: "date", label: "Termination date", render: (row) => <>{formatDate(row.terminationDate)} <span className="muted small">(in {daysBetween(today, row.terminationDate)} days)</span></>, compare: byText((row) => row.terminationDate) },
          { key: "type", label: "Type", render: (row) => TERMINATION_TYPE_LABELS[row.type] },
          { key: "affected", label: "Securities affected", numeric: true, render: (row) => String(row.securitiesAffected), compare: byNumber((row) => row.securitiesAffected) },
          { key: "cancel", label: "Unvested to cancel on that date", numeric: true, render: (row) => format.shares(row.unvestedToCancel), compare: byDecimal((row) => row.unvestedToCancel) },
          {
            key: "actions", label: "",
            render: (row) => (
              <div className="row nowrap">
                <Link className="btn btn-ghost btn-xs" to={href(`stakeholders/${row.stakeholderId}`)}>Open</Link>
                <OwnRecordScope own={workspace.isOwn(row.stakeholderId)}>
                  <WriteButton label="Reverse" size="xs" ariaLabel={`Reverse the scheduled termination of ${holderName(row.stakeholderId)}`} onClick={() => onAction({ kind: "cancelScheduled", id: row.id, stakeholderName: holderName(row.stakeholderId) })} />
                </OwnRecordScope>
              </div>
            ),
          },
        ]}
      />
      <Section
        id="rep"
        title="Unvested shares from terminated holders"
        explainer="The company may repurchase unvested shares within the window in the stock purchase agreement."
        rows={data.unvestedSharesFromTerminated}
        rowKey={(row) => row.securityId}
        empty="No open repurchase windows."
        extra={data.unvestedSharesFromTerminated.length ? (
          <p className="small muted mt-8"><Icon name="info" /> Cap Table doesn't record repurchases: counsel papers the repurchase offline and the share gets a dated note and document.</p>
        ) : null}
        columns={[
          { key: "id", label: "Security", render: (row) => security(row.securityId), compare: byDisplayId((row) => displayIdOf(row.securityId)) },
          { key: "holder", label: "Stakeholder", render: (row) => holder(row.stakeholderId), compare: byText((row) => holderName(row.stakeholderId)) },
          { key: "unvested", label: "Unvested quantity", numeric: true, render: (row) => format.shares(row.unvested), compare: byDecimal((row) => row.unvested) },
          { key: "price", label: "Repurchase price", numeric: true, render: (row) => format.price(row.repurchasePrice) },
          { key: "last", label: "Last date to repurchase", render: (row) => (row.lastRepurchaseDate ? <>{formatDate(row.lastRepurchaseDate)} <span className="muted small">({Math.max(0, daysBetween(today, row.lastRepurchaseDate))} days left)</span></> : "not recorded — see agreement"), compare: byText((row) => row.lastRepurchaseDate) },
          { key: "status", label: "Status", render: (row) => <Badge tone={REPURCHASE_LABELS[row.status][1]}>{REPURCHASE_LABELS[row.status][0]}</Badge> },
          { key: "action", label: "Action", render: () => <span className="small muted">Repurchase offline, with counsel</span> },
        ]}
      />
      <Section
        id="term"
        title="Options from terminated holders"
        explainer="Vested options that former holders can still exercise. Each shows the contractual deadline and, for ISOs, the ISO deadline."
        rows={data.optionsFromTerminated}
        rowKey={(row) => row.securityId}
        empty="No open exit windows."
        columns={[
          { key: "id", label: "Security", render: (row) => security(row.securityId), compare: byDisplayId((row) => displayIdOf(row.securityId)) },
          { key: "holder", label: "Stakeholder", render: (row) => holder(row.stakeholderId), compare: byText((row) => holderName(row.stakeholderId)) },
          { key: "vested", label: "Vested and unexercised", numeric: true, render: (row) => format.shares(row.vestedUnexercised), compare: byDecimal((row) => row.vestedUnexercised) },
          { key: "deadline", label: "Contractual deadline", render: (row) => <>{formatDate(row.contractualDeadline)}<span className="muted small"> ({row.contractualDaysLeft} days)</span></>, compare: byNumber((row) => row.contractualDaysLeft) },
          { key: "iso", label: "ISO deadline", render: (row) => (row.isoDeadline ? <>{formatDate(row.isoDeadline)}<span className="muted small"> ({row.isoDaysLeft ?? daysBetween(today, row.isoDeadline)} days)</span></> : <>— <span className="muted small">(NSO)</span></>), compare: byNumber((row) => row.isoDaysLeft) },
          {
            key: "action", label: "",
            render: (row) => (
              <OwnRecordScope own={workspace.isOwn(row.stakeholderId)}>
                <WriteButton label="Cancel now" size="xs" ariaLabel={`Cancel ${displayIdOf(row.securityId)} now`} onClick={() => onAction({ kind: "cancel", securityId: row.securityId, reason: "HOLDER_WAIVER" })} />
              </OwnRecordScope>
            ),
          },
        ]}
      />
      <Section
        id="exp"
        title="Expiring within 90 days"
        explainer="Options and warrants reaching their expiration date."
        rows={data.expiringWithin90Days}
        rowKey={(row) => row.securityId}
        empty="Nothing expires in the next 90 days."
        columns={[
          { key: "id", label: "Security", render: (row) => security(row.securityId, row.displayId), compare: byDisplayId((row) => row.displayId) },
          { key: "holder", label: "Stakeholder", render: (row) => { const known = lookups.securities.get(row.securityId); return known ? holder(known.stakeholderId, known.stakeholderName) : DASH; } },
          { key: "exp", label: "Expiration", render: (row) => <>{formatDate(row.expirationDate)}{days(row.expirationDate)}</>, compare: byText((row) => row.expirationDate) },
          { key: "out", label: "Outstanding", numeric: true, render: (row) => format.shares(lookups.securities.get(row.securityId)?.numbers?.outstanding ?? null) },
        ]}
      />
    </>
  );
}
