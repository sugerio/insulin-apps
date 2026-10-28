import { useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { api } from "#shared";
import { apiRequest, saveFile } from "../api/request.ts";
import { fileStem } from "../components/CapTableDownload.tsx";
import { DataTable, byDecimal, byNumber, byText, type Column } from "../components/DataTable.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { Attachments, useDownload } from "../components/Documents.tsx";
import { Drawer } from "../components/Dialog.tsx";
import { Badge, Banner, ResourceView } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { LinkTabs } from "../components/LinkTabs.tsx";
import { HolderLink, SecurityLink, holderState } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead, SectionTitle } from "../components/Page.tsx";
import { Tiles } from "../components/Tiles.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { isPositive, multiplyDecimals, subtractDecimals, sumDecimals, compareDecimals } from "../lib/decimal.ts";
import { describeError } from "../lib/errors.ts";
import { DASH, formatDate } from "../lib/format.ts";
import { EXERCISE_REQUEST_STATUS_LABELS, PAYMENT_METHOD_LABELS, TAX_TREATMENT_LABELS } from "../lib/labels.ts";
import { allOf, notFoundAsNull, useResource, type Resource } from "../lib/useResource.ts";
import { exerciseSource } from "./StakeholderPage.tsx";

// Hire and Retain › Exercise Requests, history: every exercise (migrated and recorded),
// and the requests migrated from Pulley, read-only with Pulley's statuses. The app takes no live requests.

type Tab = "exercises" | "requests";
const REQUEST_TONES: Record<string, "blue" | "grey" | "red" | "amber"> = { EXERCISED: "blue", CANCELLED: "grey", REJECTED: "red", REVERSED: "grey" };

function withholdingTotal(withholding: api.ExerciseRecord["withholding"]): string {
  if (!withholding) return "0";
  return sumDecimals([withholding.federalIncome, withholding.socialSecurity, withholding.medicare, ...withholding.state.map((line) => line.amount)]);
}

function portionLabel(iso: string, nso: string): string {
  return isPositive(iso) && isPositive(nso) ? "ISO + NSO" : isPositive(iso) ? "ISO" : "NSO";
}

export function ExerciseRequestsPage() {
  const workspace = useWorkspace();
  const { orgId, href } = workspace;
  const [params] = useSearchParams();
  const tab: Tab = params.get("tab") === "requests" ? "requests" : "exercises";
  const exercises = useResource((signal) => apiRequest(api.routes.listExercises, { params: { orgId }, signal }), [orgId]);
  const requests = useResource((signal) => apiRequest(api.routes.listExerciseRequests, { params: { orgId }, signal }), [orgId]);
  const stakeholders = useResource((signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }), [orgId]);
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId, }, query: { family: "EQUITY_COMPENSATION" }, signal }), [orgId], tab === "requests");
  const byId = <T extends { id: string }>(items: readonly T[]) => new Map(items.map((item) => [item.id, item]));
  const tabs = [
    { id: "exercises", label: <>Exercises<TabCount resource={exercises} noun="exercises" /></>, to: href("exercise-requests") },
    { id: "requests", label: <>Requests (migrated)<TabCount resource={requests} noun="migrated requests" /></>, to: `${href("exercise-requests")}?tab=requests` },
  ];
  return (
    <Page title="Exercise Requests" crumbs={[["Hire and Retain"], ["Exercise Requests"]]}>
      <Card>
        <PageHead title="Exercise Requests" />
        <Banner kind="info" title="Holders can't request an exercise in the app yet">
          Record exercises reported by holders from the option's Actions menu (signed notice + payment).
        </Banner>
        <LinkTabs tabs={tabs} selected={tab} label="Exercise views" />
        {/* Holder status and names come from the lookups: each tab waits for the ones it shows. */}
        {tab === "exercises" ? (
          <ResourceView resource={allOf(exercises, stakeholders)}>
            {([data, people]) => <ExercisesTab exercises={data.items} lookups={{ stakeholders: byId(people.items), securities: new Map() }} />}
          </ResourceView>
        ) : (
          <ResourceView resource={allOf(requests, stakeholders, securities)}>
            {([data, people, grants]) => <RequestsTab requests={data.items} lookups={{ stakeholders: byId(people.items), securities: byId(grants.items) }} />}
          </ResourceView>
        )}
      </Card>
    </Page>
  );
}

/** A tab's count, or a mark that it is still loading or couldn't be loaded (never a number it doesn't have). */
function TabCount({ resource, noun }: { resource: Resource<{ items: readonly unknown[] }>; noun: string }) {
  if (resource.data) return <> ({resource.data.items.length})</>;
  if (resource.error !== undefined) return <span role="alert" title={`Couldn't load the number of ${noun}`}> (!)</span>;
  return <span role="status" aria-label={`Loading the number of ${noun}`}> (…)</span>;
}

interface Lookups {
  stakeholders: ReadonlyMap<string, api.Stakeholder>;
  securities: ReadonlyMap<string, api.Security>;
}

function ExercisesTab({ exercises, lookups }: { exercises: readonly api.ExerciseRecord[]; lookups: Lookups }) {
  const workspace = useWorkspace();
  const { format, today, orgId, name } = workspace;
  const [open, setOpen] = useState<api.ExerciseRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const year = today.slice(0, 4);
  const thisYear = exercises.filter((exercise) => exercise.exerciseDate.startsWith(year) && !exercise.reversed);
  const methods = (["ACH", "WIRE", "CHECK", "CASH"] as const)
    .map((method) => [PAYMENT_METHOD_LABELS[method], thisYear.filter((exercise) => exercise.paymentMethod === method).length] as const)
    .filter(([, count]) => count > 0);
  const download = async () => {
    setNotice(null);
    try {
      await saveFile(api.routes.runReport, { params: { orgId, reportKey: "exercise-history" }, query: { format: "xlsx" } }, `${fileStem(name)}_ExerciseHistory_${today}.xlsx`);
    } catch (cause) {
      setNotice(describeError(cause, { not_found: "This export isn't available." }));
    }
  };
  const columns: Column<api.ExerciseRecord>[] = [
    { key: "date", label: "Date", render: (row) => formatDate(row.exerciseDate), compare: byText((row) => row.exerciseDate) },
    { key: "holder", label: "Holder", render: (row) => <HolderLink id={row.stakeholderId} name={row.stakeholderName} state={holderState(lookups.stakeholders.get(row.stakeholderId))} />, compare: byText((row) => row.stakeholderName) },
    { key: "grant", label: "Grant", render: (row) => <SecurityLink id={row.securityId} family="EQUITY_COMPENSATION" displayId={row.grantDisplayId} /> },
    { key: "iso", label: "ISO qty", numeric: true, render: (row) => (isPositive(row.isoQuantity) ? format.shares(row.isoQuantity) : DASH), compare: byDecimal((row) => row.isoQuantity) },
    { key: "nso", label: "NSO qty", numeric: true, render: (row) => (isPositive(row.nsoQuantity) ? format.shares(row.nsoQuantity) : DASH), compare: byDecimal((row) => row.nsoQuantity) },
    { key: "cost", label: "Cost", numeric: true, render: (row) => format.money(row.cost), compare: byDecimal((row) => row.cost) },
    { key: "method", label: "Payment method", render: (row) => (row.paymentMethod ? PAYMENT_METHOD_LABELS[row.paymentMethod] : DASH) },
    { key: "tax", label: "Tax treatment", render: (row) => (row.taxTreatment ? TAX_TREATMENT_LABELS[row.taxTreatment] : DASH) },
    { key: "wh", label: "Withholding entered", numeric: true, render: (row) => (isPositive(withholdingTotal(row.withholding)) ? format.money(withholdingTotal(row.withholding)) : DASH), compare: byDecimal((row) => withholdingTotal(row.withholding)) },
    { key: "result", label: "Resulting share", render: (row) => row.resultingShares.map((share, index) => <span key={share.securityId}>{index ? ", " : ""}<SecurityLink id={share.securityId} family="STOCK" displayId={share.displayId} /></span>) },
    { key: "source", label: "Source", render: (row) => <>{exerciseSource(row, workspace.org.importSource)}{row.reversed ? <> <Badge tone="grey">Reversed</Badge></> : null}</> },
    { key: "view", label: "", render: (row) => <button type="button" className="btn btn-ghost btn-xs" onClick={() => setOpen(row)}>View <span className="sr-only">exercise of {row.grantDisplayId} on {formatDate(row.exerciseDate)}</span></button> },
  ];
  return (
    <>
      <Tiles
        label="Exercise summary"
        items={[
          { label: `Exercises in ${year}`, value: String(thisYear.length) },
          { label: "ISO / NSO", value: `ISO ${thisYear.filter((exercise) => isPositive(exercise.isoQuantity)).length} · NSO ${thisYear.filter((exercise) => isPositive(exercise.nsoQuantity)).length}` },
          { label: "Paid by", value: methods.map(([method, count]) => `${method} ${count}`).join(" · ") || DASH },
        ]}
      />
      {notice ? <p className="err-inline" role="alert">{notice}</p> : null}
      <DataTable
        id="exercises"
        label="Exercises"
        rows={exercises}
        rowKey={(row) => row.transactionId}
        columns={columns}
        defaultSort={["date", "desc"]}
        search={(row) => `${row.grantDisplayId} ${row.stakeholderName} ${row.resultingShares.map((share) => share.displayId).join(" ")}`}
        searchPlaceholder="Search exercises…"
        toolbarExtra={<button type="button" className="btn btn-ghost btn-sm" onClick={() => void download()}><Icon name="download" /> Download</button>}
        filters={[
          { key: "method", label: "Payment method", options: (["ACH", "WIRE", "CHECK", "CASH"] as const).map((method) => [method, PAYMENT_METHOD_LABELS[method]] as const), test: (row, value) => row.paymentMethod === value },
          { key: "date", label: "Date", type: "daterange", test: (row, range) => (!range.from || row.exerciseDate >= range.from) && (!range.to || row.exerciseDate <= range.to) },
        ]}
        empty="No exercises yet."
      />
      {open ? <ExerciseDrawer exercise={open} stakeholder={lookups.stakeholders.get(open.stakeholderId)} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function ExerciseDrawer({ exercise, stakeholder, onClose }: { exercise: api.ExerciseRecord; stakeholder: api.Stakeholder | undefined; onClose: () => void }) {
  const { format, org } = useWorkspace();
  const withholding = exercise.withholding;
  const spread = exercise.fmvPerShare && isPositive(exercise.nsoQuantity) && compareDecimals(exercise.fmvPerShare, exercise.exercisePrice) > 0
    ? multiplyDecimals(subtractDecimals(exercise.fmvPerShare, exercise.exercisePrice), exercise.nsoQuantity)
    : null;
  return (
    <Drawer title={`Exercise — ${exercise.grantDisplayId} · ${formatDate(exercise.exerciseDate)}`} onClose={onClose}>
      <DescriptionList
        rows={[
          ["Holder", <HolderLink id={exercise.stakeholderId} name={exercise.stakeholderName} state={holderState(stakeholder)} />],
          ["Holder status", stakeholder ? (stakeholder.termination ? "Former" : "Current") : DASH],
          ["Grant", <SecurityLink id={exercise.securityId} family="EQUITY_COMPENSATION" displayId={exercise.grantDisplayId} />],
          ["ISO / NSO", `${format.shares(exercise.isoQuantity)} ISO · ${format.shares(exercise.nsoQuantity)} NSO`],
          ["Strike", format.price(exercise.exercisePrice)],
          ["FMV at exercise", format.price(exercise.fmvPerShare)],
          ["Cost", format.money(exercise.cost)],
          ["Spread (NSO)", spread ? format.money(spread) : DASH],
          ["Payment", `${exercise.paymentMethod ? PAYMENT_METHOD_LABELS[exercise.paymentMethod] : DASH}${exercise.paymentReference ? ` · ref ${exercise.paymentReference}` : ""}`],
          ["Tax treatment", exercise.taxTreatment ? TAX_TREATMENT_LABELS[exercise.taxTreatment] : DASH],
          ["Withholding entered", withholding
            ? `Federal ${format.money(withholding.federalIncome)} · Social Security ${format.money(withholding.socialSecurity)} · Medicare ${format.money(withholding.medicare)}${withholding.state.map((line) => ` · State ${format.money(line.amount)} (${line.code})`).join("")}`
            : "None"],
          ["Resulting shares", exercise.resultingShares.map((share, index) => <span key={share.securityId}>{index ? ", " : ""}<SecurityLink id={share.securityId} family="STOCK" displayId={share.displayId} /> ({share.portion})</span>)],
          ["Source", exerciseSource(exercise, org.importSource)],
          exercise.reversed ? ["Reversed", "Yes — the command was reversed"] : null,
        ]}
      />
    </Drawer>
  );
}

function RequestsTab({ requests, lookups }: { requests: readonly api.ExerciseRequest[]; lookups: Lookups }) {
  const { format } = useWorkspace();
  const [open, setOpen] = useState<api.ExerciseRequest | null>(null);
  const holderName = (row: api.ExerciseRequest) => lookups.stakeholders.get(row.stakeholderId)?.displayName ?? "Stakeholder";
  const displayId = (row: api.ExerciseRequest) => lookups.securities.get(row.securityId)?.displayId ?? "Security";
  const columns: Column<api.ExerciseRequest>[] = [
    { key: "id", label: "ID", render: (row) => `ER-${row.requestNumber}`, compare: byNumber((row) => row.requestNumber) },
    { key: "security", label: "Security", render: (row) => <SecurityLink id={row.securityId} family="EQUITY_COMPENSATION" displayId={displayId(row)} /> },
    { key: "holder", label: "Stakeholder", render: (row) => <HolderLink id={row.stakeholderId} name={holderName(row)} state={holderState(lookups.stakeholders.get(row.stakeholderId))} />, compare: byText(holderName) },
    { key: "date", label: "Request date", render: (row) => formatDate(format.localDate(row.createdAt)), compare: byNumber((row) => row.createdAt) },
    { key: "type", label: "Option type", render: (row) => portionLabel(row.isoQuantity, row.nsoQuantity) },
    { key: "qty", label: "Quantity", numeric: true, render: (row) => format.shares(row.quantity), compare: byDecimal((row) => row.quantity) },
    { key: "cost", label: "Cost", numeric: true, render: (row) => format.money(row.totalCost), compare: byDecimal((row) => row.totalCost) },
    { key: "method", label: "Payment method", render: (row) => PAYMENT_METHOD_LABELS[row.paymentMethod] },
    { key: "status", label: "Status", render: (row) => <Badge tone={REQUEST_TONES[row.status] ?? "amber"}>{EXERCISE_REQUEST_STATUS_LABELS[row.status] ?? row.status}</Badge>, compare: byText((row) => row.status) },
    { key: "docs", label: "Documents", render: (row) => (row.documents[0] ? <NoticeLink document={row.documents[0]} /> : DASH) },
    { key: "history", label: "", render: (row) => <button type="button" className="btn btn-ghost btn-xs" onClick={() => setOpen(row)}>History <span className="sr-only">of ER-{row.requestNumber}</span></button> },
  ];
  return (
    <>
      <DataTable
        id="exercise-requests"
        label="Requests (migrated)"
        rows={requests}
        rowKey={(row) => row.id}
        columns={columns}
        defaultSort={["id", "asc"]}
        search={(row) => `ER-${row.requestNumber} ${holderName(row)} ${displayId(row)}`}
        empty="No exercise requests were migrated."
      />
      {open ? (
        <Drawer title={`ER-${open.requestNumber} — history (Pulley)`} onClose={() => setOpen(null)}>
          <RequestDetails request={open} holder={lookups.stakeholders.get(open.stakeholderId)} grant={lookups.securities.get(open.securityId)} />
        </Drawer>
      ) : null}
    </>
  );
}

function NoticeLink({ document }: { document: api.DocumentRef }) {
  const { download, error } = useDownload();
  return (
    <>
      <button type="button" className="btn-link" onClick={() => void download(document.id, document.filename)}><Icon name="file" /> Notice</button>
      {error ? <div className="err-inline" role="alert">{error}</div> : null}
    </>
  );
}

function RequestDetails({ request, holder, grant }: { request: api.ExerciseRequest; holder: api.Stakeholder | undefined; grant: api.Security | undefined }) {
  const { format } = useWorkspace();
  const events: { key: string; title: ReactNode; at: string }[] = [
    { key: "created", title: "Request submitted", at: format.dateTime(request.createdAt) },
    request.decidedAt !== null ? { key: "decided", title: request.status === "REJECTED" ? "Rejected" : "Approved", at: format.dateTime(request.decidedAt) } : null,
    request.paymentReceivedOn ? { key: "paid", title: "Payment received", at: formatDate(request.paymentReceivedOn) } : null,
    request.exerciseDate ? { key: "exercised", title: "Exercised", at: formatDate(request.exerciseDate) } : null,
    request.cancelledAt !== null ? { key: "cancelled", title: "Cancelled", at: format.dateTime(request.cancelledAt) } : null,
  ].filter((item) => item !== null);
  return (
    <>
      <DescriptionList
        rows={[
          ["Holder", <HolderLink id={request.stakeholderId} name={holder?.displayName ?? "Stakeholder"} state={holderState(holder)} />],
          ["Grant", <SecurityLink id={request.securityId} family="EQUITY_COMPENSATION" displayId={grant?.displayId ?? "Security"} />],
          ["Quantity", `${format.shares(request.quantity)} (${portionLabel(request.isoQuantity, request.nsoQuantity)})`],
          ["Exercise price", format.price(request.exercisePrice)],
          ["FMV", format.price(request.fmvPerShare)],
          ["Estimated withholding", format.money(request.estimatedWithholding)],
          ["Total cost", format.money(request.totalCost)],
          ["Payment method", PAYMENT_METHOD_LABELS[request.paymentMethod]],
          ["Status", <>{EXERCISE_REQUEST_STATUS_LABELS[request.status] ?? request.status}{request.pulleyStatus ? <span className="muted small"> (Pulley: {request.pulleyStatus})</span> : null}</>],
          ["Payment due", formatDate(request.paymentDueDate)],
        ]}
      />
      <h4 className="mt-16">Timeline</h4>
      <Timeline label="Request timeline" items={events.map((event) => ({ key: event.key, title: event.title, meta: event.at }))} />
      {request.documents.length ? (
        <>
          <h4 className="mt-16">Documents</h4>
          <Attachments documents={request.documents} upload={false} />
        </>
      ) : null}
      <p className="small muted">Migrated history, read-only.</p>
    </>
  );
}

export function ExerciseRequestPage() {
  const { orgId, href } = useWorkspace();
  const { requestId = "" } = useParams();
  const request = useResource((signal) => apiRequest(api.routes.getExerciseRequest, { params: { orgId, id: requestId }, signal }), [orgId, requestId]);
  const holder = useResource((signal) => apiRequest(api.routes.getStakeholder, { params: { orgId, id: request.data?.stakeholderId ?? "" }, signal }), [orgId, request.data?.stakeholderId], request.data !== undefined);
  const grant = useResource((signal) => apiRequest(api.routes.getSecurity, { params: { orgId, id: request.data?.securityId ?? "" }, signal }), [orgId, request.data?.securityId], request.data !== undefined);
  const title = request.data ? `ER-${request.data.requestNumber}` : "Exercise request";
  return (
    <Page title={title} crumbs={[["Exercise Requests", `${href("exercise-requests")}?tab=requests`], [title]]}>
      {/* The holder and grant are lookups: one that no longer exists shows as such; any other failure is an error. */}
      <ResourceView resource={allOf(request, notFoundAsNull(holder), notFoundAsNull(grant))} notFound="This exercise request does not exist.">
        {([data, holderData, grantData]) => (
          <Card>
            <PageHead title={title} after={<Badge tone={REQUEST_TONES[data.status] ?? "amber"}>{EXERCISE_REQUEST_STATUS_LABELS[data.status] ?? data.status}</Badge>} />
            <SectionTitle>Request</SectionTitle>
            <RequestDetails request={data} holder={holderData ?? undefined} grant={grantData ?? undefined} />
          </Card>
        )}
      </ResourceView>
    </Page>
  );
}
