import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { apiRequest } from "../api/request.ts";
import { ActionsMenu, OwnRecordScope, WriteButton } from "../components/Actions.tsx";
import { RecordActivity } from "../components/Activity.tsx";
import { DataTable, byDecimal, byDisplayId, byText, type Column } from "../components/DataTable.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { LinkedDocuments } from "../components/Documents.tsx";
import { Badge, Banner, InlineError, Pending, ResourceView } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { SecurityLink, TerminationBadge, holderState } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead, SectionTitle } from "../components/Page.tsx";
import { CancelScheduledTerminationDialog } from "../components/flows/CancelScheduledTerminationDialog.tsx";
import { ReverseDialog } from "../components/flows/ReverseDialog.tsx";
import { AddEmailDialog, MergeStakeholderDialog, RemoveEmailDialog } from "../components/flows/StakeholderDialogs.tsx";
import { stakeholderLinkIntent, UploadDocumentDialog } from "../components/flows/DocumentDialogs.tsx";
import { usePii } from "../components/Pii.tsx";
import { isPositive, sumDecimals } from "../lib/decimal.ts";
import { DASH, formatDate } from "../lib/format.ts";
import {
  PORTAL_STATE_LABELS,
  RELATIONSHIP_LABELS,
  SECURITY_STATUS_LABELS,
  SECURITY_STATUS_TONES,
  TERMINATION_TYPE_LABELS,
  exercisePaymentLabel,
  isExecutionPending,
} from "../lib/labels.ts";
import { addressLine, emailKindLabel, leaveLabel } from "../lib/stakeholders.ts";
import * as terms from "../lib/terms.ts";
import { allOf, useResource, type Resource } from "../lib/useResource.ts";

// Stakeholder detail: overview, details, e-mails, a scheduled termination's effects, holdings by
// instrument, exercises, documents and activity. Edit and Terminate open their pages; the e-mails, the merge and the
// reversals open their dialogs.

type StakeholderDialog =
  | { kind: "reverse" }
  | { kind: "reverseMerge" }
  | { kind: "cancelScheduled" }
  | { kind: "upload" }
  | { kind: "merge" }
  | { kind: "addEmail" }
  | { kind: "removeEmail"; email: api.StakeholderEmail };

export function StakeholderPage() {
  const { orgId } = useWorkspace();
  const { stakeholderId = "" } = useParams();
  const detail = useResource((signal) => apiRequest(api.routes.getStakeholder, { params: { orgId, id: stakeholderId }, signal }), [orgId, stakeholderId]);
  const holdings = useResource((signal) => apiRequest(api.routes.getStakeholderHoldings, { params: { orgId, id: stakeholderId }, signal }), [orgId, stakeholderId]);
  const vesting = useResource((signal) => apiRequest(api.routes.listVestingTerms, { params: { orgId }, signal }), [orgId]);
  const title = detail.data?.displayName ?? "Stakeholder";
  const changed = () => {
    detail.reload();
    holdings.reload();
  };
  return (
    <Page title={title} crumbs={[["Stakeholders", `/companies/${orgId}/stakeholders`], [title]]}>
      <ResourceView resource={detail} notFound="This stakeholder does not exist.">
        {(data) => <StakeholderBody stakeholder={data} holdings={holdings} vesting={vesting} onChanged={changed} />}
      </ResourceView>
    </Page>
  );
}

interface BodyProps {
  stakeholder: api.StakeholderDetail;
  holdings: Resource<api.StakeholderHoldings>;
  vesting: Resource<api.VestingTermsList>;
  onChanged: () => void;
}

function StakeholderBody({ stakeholder, holdings, vesting, onChanged }: BodyProps) {
  const workspace = useWorkspace();
  const { format, href, canWrite } = workspace;
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<StakeholderDialog | null>(null);
  const [documentsGeneration, setDocumentsGeneration] = useState(0);
  const closeDialog = () => setDialog(null);
  const dialogDone = () => {
    setDialog(null);
    onChanged();
  };
  const pii = usePii();
  const own = workspace.isOwn(stakeholder.id);
  const state = holderState(stakeholder);
  const termination = stakeholder.termination;
  const scheduled = stakeholder.scheduledTermination;
  const institution = stakeholder.kind === "institution";
  const status = scheduled ? (
    <><Badge tone="amber">Terminating on {formatDate(scheduled.terminationDate)}</Badge> · {TERMINATION_TYPE_LABELS[scheduled.type]}</>
  ) : termination ? `Terminated on ${formatDate(termination.date)} (${TERMINATION_TYPE_LABELS[termination.type]})` : "Active";
  const portal = PORTAL_STATE_LABELS[stakeholder.portalState];
  const actions = own ? null : (
    <ActionsMenu
      items={stakeholder.mergedInto ? [
        { label: "Undo stakeholder merge", icon: "refresh", onSelect: () => setDialog({ kind: "reverseMerge" }) },
      ] : [
        { label: "Edit stakeholder", icon: "edit", to: href(`stakeholders/${stakeholder.id}/edit`) },
        !termination && !scheduled ? { label: "Terminate stakeholder", icon: "x", to: href(`stakeholders/${stakeholder.id}/terminate`) } : null,
        { label: "Merge into another stakeholder…", icon: "refresh", onSelect: () => setDialog({ kind: "merge" }) },
        { label: "Upload document", icon: "upload", onSelect: () => setDialog({ kind: "upload" }) },
        termination || scheduled ? "separator" : null,
        termination || scheduled
          ? { label: scheduled ? "Reverse scheduled termination" : "Reverse termination", icon: "refresh", onSelect: () => setDialog({ kind: scheduled ? "cancelScheduled" : "reverse" }) }
          : null,
      ]}
    />
  );

  return (
    <OwnRecordScope own={own}>
      <Card>
        <PageHead
          title={stakeholder.displayName}
          after={
            <>
              <Button asChild variant="ghost" size="xs">
                <Link to={href(`stakeholders/${stakeholder.id}/preview`)} title="The holder view as it shows this stakeholder record">
                  <Icon name="eye" /> Preview as stakeholder
                </Link>
              </Button>
              <TerminationBadge state={state} />
            </>
          }
          actions={actions}
        />
        {own && canWrite ? (
          <Banner kind="info" title="This is your own record">Admins never record writes on their own holdings or stakeholder record — another admin must.</Banner>
        ) : null}
        {stakeholder.mergedInto ? (
          <Banner kind="info" title="Merged stakeholder record">
            Merged into <Link to={href(`stakeholders/${stakeholder.mergedInto.id}`)}>{stakeholder.mergedInto.displayName}</Link>. This record is hidden from stakeholder lists; its holdings and history appear on the surviving record.
          </Banner>
        ) : null}
        {stakeholder.mergedRecords.length ? (
          <p className="text-xs text-muted-foreground">
            Merged into this record: {stakeholder.mergedRecords.map((record, index) => <span key={record.id}>{index ? ", " : ""}<Link className="underline underline-offset-4" to={href(`stakeholders/${record.id}`)}>{record.displayName}</Link></span>)}.
          </p>
        ) : null}
        <SectionTitle>Overview</SectionTitle>
        <DescriptionList
          rows={[
            ["Fully diluted shares", stakeholder.totals ? `${format.shares(stakeholder.totals.fullyDiluted)} (${format.percent(stakeholder.totals.fullyDilutedPct)})` : DASH],
            ["Capital contributed", stakeholder.totals ? format.money(stakeholder.totals.capitalContribution) : DASH],
            ["Status", status],
            ["Portal access", portal],
          ]}
        />
        <SectionTitle>Stakeholder Details</SectionTitle>
        <DescriptionList
          rows={[
            ["Legal name", stakeholder.legalName ?? stakeholder.displayName],
            ["Display name", stakeholder.displayName],
            ["Relationship and type", `${RELATIONSHIP_LABELS[stakeholder.relationship]} (${institution ? "Institution" : "Individual"})`],
            ["Hire date", formatDate(stakeholder.hireDate)],
            ["Phone", pii.text(stakeholder.phone)],
            ["Address", pii.text(addressLine(stakeholder.address))],
            ["Country of tax residence", pii.text(stakeholder.countryOfResidence)],
            ["Termination", termination
              ? `${TERMINATION_TYPE_LABELS[termination.type]} · ${formatDate(termination.date)} · vesting stopped ${formatDate(termination.vestingStopDate)}`
              : scheduled ? `${TERMINATION_TYPE_LABELS[scheduled.type]} · ${formatDate(scheduled.terminationDate)} (scheduled)` : DASH],
            ["Leave of absence", leaveLabel(stakeholder.leaveOfAbsence) ?? DASH],
            ["External ID", stakeholder.issuerAssignedId ?? DASH],
            stakeholder.provenance.importedFromPulley ? ["Source", stakeholder.provenance.pulleyId
              ? `${api.importSourceLabel(workspace.org.importSource)} (${api.displaySourceId(stakeholder.provenance.pulleyId)})`
              : api.importSourceLabel(workspace.org.importSource)] : null,
          ]}
        />
        <SectionTitle>{institution ? "Authorized contacts" : "E-mails"}</SectionTitle>
        <EmailList stakeholder={stakeholder} readOnly={stakeholder.mergedInto !== null}
          onAdd={() => setDialog({ kind: "addEmail" })} onRemove={(email) => setDialog({ kind: "removeEmail", email })} />
      </Card>
      {scheduled ? <ScheduledTermination stakeholder={stakeholder} scheduled={scheduled} holdings={holdings} /> : null}
      <Card>
        <h3 className="text-base font-semibold">Holdings</h3>
        {/* The schedule names come from the vesting terms; a missing name must not read as "explicit tranches". */}
        <Pending resource={allOf(holdings, vesting)} what="the holdings">
          {([held, vestingList]) => <Holdings holdings={held.items} vestingNames={new Map(vestingList.items.map((item) => [item.id, item.name]))} />}
        </Pending>
        {stakeholder.exercises.length ? (
          <>
            <SectionTitle>Exercises</SectionTitle>
            <DataTable
              id="stakeholder-exercises"
              label="Exercises"
              rows={stakeholder.exercises}
              rowKey={(row) => row.transactionId}
              toolbar={false}
              paginate={false}
              defaultSort={["date", "desc"]}
              columns={[
                { key: "date", label: "Date", render: (row) => formatDate(row.exerciseDate), compare: byText((row) => row.exerciseDate) },
                { key: "grant", label: "Grant", render: (row) => <SecurityLink id={row.securityId} family="EQUITY_COMPENSATION" displayId={row.grantDisplayId} /> },
                { key: "qty", label: "Quantity", numeric: true, render: (row) => format.shares(row.quantity), compare: byDecimal((row) => row.quantity) },
                { key: "type", label: "ISO/NSO", render: (row) => (isPositive(row.isoQuantity) && isPositive(row.nsoQuantity) ? "ISO + NSO" : isPositive(row.isoQuantity) ? "ISO" : "NSO") },
                { key: "pay", label: "Payment", render: (row) => exercisePaymentLabel(row, workspace.org.importSource) },
                { key: "src", label: "Source", render: (row) => exerciseSource(row, workspace.org.importSource) },
              ]}
            />
          </>
        ) : null}
        <SectionTitle>Documents</SectionTitle>
        <LinkedDocuments key={documentsGeneration} targetType="stakeholder" targetId={stakeholder.id} showVisibility limit={12} />
        <SectionTitle>Activity</SectionTitle>
        <RecordActivity targetId={stakeholder.id} />
      </Card>
      {dialog?.kind === "reverse" && termination ? (
        <ReverseDialog target={{ commandId: termination.commandId, securityLabel: stakeholder.displayName, stakeholderName: stakeholder.displayName, title: "Reverse termination" }} onClose={closeDialog} onDone={dialogDone} />
      ) : null}
      {dialog?.kind === "reverseMerge" && stakeholder.mergedInto ? (
        <ReverseDialog target={{ commandId: stakeholder.mergedInto.commandId, securityLabel: stakeholder.displayName, stakeholderName: stakeholder.displayName, title: "Undo stakeholder merge" }} onClose={closeDialog} onDone={dialogDone} />
      ) : null}
      {dialog?.kind === "merge" ? (
        <MergeStakeholderDialog stakeholder={stakeholder} onClose={closeDialog} onDone={(survivingId) => { closeDialog(); navigate(href(`stakeholders/${survivingId}`)); }} />
      ) : null}
      {dialog?.kind === "addEmail" ? <AddEmailDialog stakeholder={stakeholder} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog?.kind === "removeEmail" ? (
        <RemoveEmailDialog stakeholder={stakeholder} email={dialog.email} onClose={closeDialog} onDone={dialogDone} />
      ) : null}
      {dialog?.kind === "cancelScheduled" && scheduled ? (
        <CancelScheduledTerminationDialog scheduledTerminationId={scheduled.id} stakeholderName={stakeholder.displayName} onClose={closeDialog} onDone={dialogDone} />
      ) : null}
      {dialog?.kind === "upload" ? (
        <UploadDocumentDialog link={stakeholderLinkIntent(stakeholder)} title={`Upload a document for ${stakeholder.displayName}`} onClose={closeDialog}
          onDone={() => { closeDialog(); setDocumentsGeneration((value) => value + 1); }} />
      ) : null}
    </OwnRecordScope>
  );
}

export function exerciseSource(row: api.ExerciseRecord, source: api.ImportSource | null | undefined = null): string {
  if (row.source.kind === "request") return row.source.requestNumber ? `Request ER-${row.source.requestNumber}` : "Request";
  return row.source.kind === "migrated" ? api.importSourceLabel(source) : "Recorded";
}

/**
 * The stakeholder's e-mail addresses: the person's own, an institution's authorized contacts and any representative.
 * A console account whose e-mail matches one of them sees this stakeholder's holdings in the holder view.
 */
function EmailList({ stakeholder, readOnly, onAdd, onRemove }: { stakeholder: api.Stakeholder; readOnly: boolean; onAdd: () => void; onRemove: (email: api.StakeholderEmail) => void }) {
  const { format } = useWorkspace();
  const pii = usePii();
  const emails = stakeholder.emails.filter((email) => email.removedAt === null);
  const add = readOnly ? null : <div className="flex flex-wrap items-center gap-2"><WriteButton label="Add e-mail" size="sm" icon="plus" ariaLabel={`Add an e-mail to ${stakeholder.displayName}`} onClick={onAdd} /></div>;
  if (!emails.length) {
    return (
      <>
        <p className="text-xs text-muted-foreground">No e-mail address yet. Without one, this stakeholder can't see their holdings in the holder view.</p>
        {add}
      </>
    );
  }
  return (
    <>
      <Table aria-label={stakeholder.kind === "institution" ? "Authorized contacts" : "E-mails"}>
        <TableHeader><TableRow><TableHead scope="col">E-mail</TableHead><TableHead scope="col">Whose</TableHead><TableHead scope="col">Added</TableHead><TableHead scope="col"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {emails.map((email) => (
            <TableRow key={email.id}>
              <TableCell>
                {pii.email(email.email)}
                {email.contactName ? <div className="text-xs text-muted-foreground">{email.contactName}{email.contactRole ? ` · ${email.contactRole}` : ""}</div> : null}
              </TableCell>
              <TableCell>{emailKindLabel(email)}</TableCell>
              <TableCell>{formatDate(format.localDate(email.createdAt))}{email.addedBy ? <div className="text-xs text-muted-foreground">{email.addedBy}</div> : null}</TableCell>
              <TableCell className="text-right">{readOnly ? null : <WriteButton label="Remove" size="xs" ariaLabel={`Remove ${pii.email(email.email)}`} onClick={() => onRemove(email)} />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">A console account whose e-mail matches one of these sees this stakeholder's holdings.</p>
      {add}
    </>
  );
}

function ScheduledTermination({ stakeholder, scheduled, holdings }: { stakeholder: api.Stakeholder; scheduled: NonNullable<api.Stakeholder["scheduledTermination"]>; holdings: Resource<api.StakeholderHoldings> }) {
  const { orgId, format } = useWorkspace();
  const held = holdings.data?.items;
  const affected = (held ?? []).filter((security) => security.status === "OUTSTANDING" && (security.family === "EQUITY_COMPENSATION" || (security.family === "STOCK" && terms.vestingTermsId(security.terms))));
  const ids = affected.map((security) => security.id).join(",");
  const previews = useResource(
    (signal) => Promise.all(affected.map((security) => apiRequest(api.routes.getTerminationPreview, {
      params: { orgId, id: security.id },
      query: { terminationDate: scheduled.terminationDate, terminationType: scheduled.type },
      signal,
    }))),
    [orgId, ids, scheduled.terminationDate, scheduled.type],
    held !== undefined,
  );
  const byId = new Map(affected.map((security) => [security.id, security]));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">On {formatDate(scheduled.terminationDate)}</h3>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">Vesting continues until then; fully diluted is unchanged.</span>
      </div>
      {previews.data ? (
        <Table aria-label={`Effects of ${stakeholder.displayName}'s scheduled termination`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Security</TableHead>
              <TableHead scope="col" className="text-right">Vested at stop</TableHead>
              <TableHead scope="col" className="text-right">Cancelled on that date</TableHead>
              <TableHead scope="col">Contractual deadline</TableHead>
              <TableHead scope="col">ISO deadline</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {previews.data.map((preview) => {
              const security = byId.get(preview.securityId);
              return (
                <TableRow key={preview.securityId}>
                  <TableCell>{security ? <SecurityLink id={security.id} family={security.family} displayId={security.displayId} /> : DASH}</TableCell>
                  <TableCell className="text-right tabular-nums">{format.shares(preview.vested)}</TableCell>
                  <TableCell className="text-right tabular-nums">{format.shares(preview.unvested)}</TableCell>
                  <TableCell>{formatDate(preview.contractualDeadline)}</TableCell>
                  <TableCell>{formatDate(preview.isoDeadline)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Back to the pool</TableCell>
              <TableCell />
              <TableCell className="text-right tabular-nums">{format.shares(sumDecimals(previews.data.map((preview) => preview.unvested)))}</TableCell>
              <TableCell />
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      ) : held === undefined && holdings.error !== undefined ? (
        <InlineError what="the holdings, so the effects couldn't be computed" error={holdings.error} onRetry={holdings.reload} />
      ) : previews.error !== undefined ? (
        <InlineError what="the effects of this termination" error={previews.error} onRetry={previews.reload} />
      ) : (
        <p className="text-xs text-muted-foreground" role="status">Computing the effects…</p>
      )}
    </Card>
  );
}

function Holdings({ holdings, vestingNames }: { holdings: readonly api.Security[]; vestingNames: ReadonlyMap<string, string> }) {
  const { format } = useWorkspace();
  const of = (family: api.SecurityFamily) => holdings.filter((security) => security.family === family);
  const number = (security: api.Security, key: keyof api.SecurityNumbers) => (security.numbers ? String(security.numbers[key]) : null);
  const status = (security: api.Security) => <Badge tone={SECURITY_STATUS_TONES[security.status]}>{SECURITY_STATUS_LABELS[security.status]}</Badge>;
  const schedule = (security: api.Security) => {
    const id = terms.vestingTermsId(security.terms);
    return id ? vestingNames.get(id) ?? "Explicit tranches (from the agreement)" : security.family === "STOCK" ? "Fully vested" : DASH;
  };
  const certificate: Column<api.Security> = { key: "id", label: "Certificate", render: (security) => <SecurityLink id={security.id} family={security.family} displayId={security.displayId} />, compare: byDisplayId((security) => security.displayId) };
  const date: Column<api.Security> = { key: "date", label: "Issue date", render: (security) => formatDate(security.issueDate), compare: byText((security) => security.issueDate) };
  const statusColumn: Column<api.Security> = { key: "status", label: "Status", render: status };
  const fd: Column<api.Security> = { key: "fd", label: "Fully diluted", numeric: true, render: (security) => format.shares(number(security, "fullyDiluted")), compare: byDecimal((security) => number(security, "fullyDiluted")) };
  const pct: Column<api.Security> = { key: "pct", label: "% Fully diluted", numeric: true, render: (security) => (security.numbers ? format.percent(security.numbers.fullyDilutedPct) : DASH) };
  const groups: [string, readonly api.Security[], Column<api.Security>[]][] = [
    ["Shares", of("STOCK"), [certificate, date, statusColumn, { key: "v", label: "Vesting schedule", render: schedule }, fd, pct]],
    ["Options", of("EQUITY_COMPENSATION"), [
      { ...certificate, render: (security) => <><SecurityLink id={security.id} family={security.family} displayId={security.displayId} />{isExecutionPending(security.executionStatus) && isPositive(number(security, "outstanding")) ? <> <Badge tone="amber">Execution pending</Badge></> : null}</> },
      date, statusColumn, { key: "v", label: "Vesting schedule", render: schedule },
      { key: "vested", label: "Vested", numeric: true, render: (security) => format.shares(number(security, "exercisable")) },
      { key: "unvested", label: "Unvested", numeric: true, render: (security) => format.shares(number(security, "unvested")) },
      { key: "dl", label: "Deadlines", render: (security) => (security.deadlines?.contractual ? <span className="text-xs">{formatDate(security.deadlines.contractual)}{security.deadlines.iso ? ` · ISO ${formatDate(security.deadlines.iso)}` : ""}</span> : DASH) },
      fd, pct,
    ]],
    ["Warrants", of("WARRANT"), [certificate, date, statusColumn, fd]],
    ["SAFEs (converted)", of("CONVERTIBLE"), [
      certificate, date, statusColumn,
      { key: "principal", label: "Principal", numeric: true, render: (security) => format.money(terms.safeTerms(security.terms).principal, 0) },
      {
        key: "into", label: "Converted into",
        render: (security) => {
          const children = holdings.filter((child) => child.parentSecurityId === security.id);
          return children.length ? children.map((child, index) => <span key={child.id}>{index ? ", " : ""}<SecurityLink id={child.id} family={child.family} displayId={child.displayId} /></span>) : DASH;
        },
      },
    ]],
  ];
  const present = groups.filter(([, rows]) => rows.length > 0);
  if (!present.length) return <p className="text-sm text-muted-foreground">No holdings.</p>;
  return (
    <>
      {present.map(([title, rows, columns]) => (
        <div key={title} className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">{title}</h4>
          <DataTable id={`holdings-${title}`} label={title} rows={rows} rowKey={(security) => security.id} columns={columns} toolbar={false} paginate={false} defaultSort={["date", "asc"]} />
        </div>
      ))}
    </>
  );
}
