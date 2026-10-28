import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { ActionsMenu, OwnRecordScope, type ActionEntry } from "../components/Actions.tsx";
import { ProgressBar, VestingChart } from "../components/Charts.tsx";
import { DescriptionList, type DlRow } from "../components/DescriptionList.tsx";
import { Attachments, LinkedDocuments, useDownload } from "../components/Documents.tsx";
import { Badge, Banner, Pending, ResourceView } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { HolderLink, SecurityLink, holderState } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead, SectionTitle } from "../components/Page.tsx";
import { usePii } from "../components/Pii.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { CancelSecurityDialog } from "../components/flows/CancelSecurityDialog.tsx";
import { ExtendDeadlineDialog } from "../components/flows/ExtendDeadlineDialog.tsx";
import { MarkExecutedDialog } from "../components/flows/MarkExecutedDialog.tsx";
import { ReverseDialog, type ReverseTarget } from "../components/flows/ReverseDialog.tsx";
import { securityLinkIntent, UploadDocumentDialog } from "../components/flows/DocumentDialogs.tsx";
import { compareDecimals, formatFractionPercent, fractionOf, isPositive, multiplyDecimals, sumDecimals } from "../lib/decimal.ts";
import { DASH, addYears, formatDate, formatDaysLeft } from "../lib/format.ts";
import {
  ELECTION_83B_LABELS,
  EXECUTION_LABELS,
  FEDERAL_EXEMPTION_LABELS,
  FREQUENCY_LABELS,
  PORTAL_STATE_LABELS,
  SECURITY_KIND_LABELS,
  SECURITY_STATUS_LABELS,
  SECURITY_STATUS_TONES,
  TERMINATION_WINDOW_LABELS,
  VALUATION_STATUS_LABELS,
  isExecutionPending,
  optionType,
  periodLabel,
} from "../lib/labels.ts";
import { activeEmails } from "../lib/stakeholders.ts";
import * as terms from "../lib/terms.ts";
import { useResource, type Resource } from "../lib/useResource.ts";
import { boardApproval, certificateLabel, discountLabel, yesNo } from "./CapTablePage.tsx";

// Security detail (option, shares, warrant, SAFE): a two-column page with the
// overview, vesting (chart and full schedule), details and post-termination exercise on the left; the stakeholder,
// attachments, provenance and the activity timeline on the right. Write actions sit in the Actions menu: Record
// exercise opens its page; Cancel, Mark executed, Extend exercise deadline and Reverse open their dialogs.

const CRUMB_TAB: Record<api.SecurityFamily, string> = { STOCK: "shares", EQUITY_COMPENSATION: "options", WARRANT: "warrants", CONVERTIBLE: "safes" };
const CRUMB_LABEL: Record<api.SecurityFamily, string> = { STOCK: "Shares", EQUITY_COMPENSATION: "Options", WARRANT: "Warrants", CONVERTIBLE: "SAFEs" };
const WINDOW_ORDER = ["VOLUNTARY", "INVOLUNTARY", "WITH_CAUSE", "DEATH", "DISABILITY", "RETIREMENT"] as const;
type TimelineList = api.RouteResult<typeof api.routes.getSecurityTimeline>;
type ElectionList = api.RouteResult<typeof api.routes.listElections83b>;

type SecurityDialog = "cancel" | "markExecuted" | "extend" | "reverse" | "upload";

/** `dialog` opens a flow with the page (`securities/:id/cancel`). */
export function SecurityPage({ dialog }: { dialog?: "cancel" } = {}) {
  const { orgId, href } = useWorkspace();
  const navigate = useNavigate();
  const { securityId = "", convertibleId } = useParams();
  const id = convertibleId ?? securityId;
  const detail = useResource((signal) => apiRequest(api.routes.getSecurity, { params: { orgId, id }, signal }), [orgId, id]);
  // A flow opened by its own URL (`…/cancel`) returns to the security's URL when its dialog closes.
  const leaveDialogRoute = dialog ? () => navigate(href(`securities/${id}`), { replace: true }) : undefined;
  // A recorded write remounts the body, so the vesting, timeline and lookups are read again with the security.
  const [generation, setGeneration] = useState(0);
  const changed = () => {
    setGeneration((value) => value + 1);
    detail.reload();
  };
  const security = detail.data;
  const title = security ? (security.family === "CONVERTIBLE" ? security.displayId : `${security.displayId} ${SECURITY_KIND_LABELS[security.family]}`) : "Security";
  const crumbs = security
    ? ([[CRUMB_LABEL[security.family], `${href("captable")}?tab=${CRUMB_TAB[security.family]}`], [security.stakeholderName, href(`stakeholders/${security.stakeholderId}`)], [security.displayId]] as const)
    : ([["Cap Table", href("captable")], ["Security"]] as const);
  return (
    <Page title={title} crumbs={crumbs}>
      <ResourceView resource={detail} notFound="This security does not exist.">
        {(data) => (data.family === "CONVERTIBLE" ? <ConvertibleBody key={generation} security={data} onChanged={changed} /> : <SecurityBody key={generation} security={data} initialDialog={generation === 0 ? dialog : undefined} onChanged={changed} onDialogClosed={leaveDialogRoute} />)}
      </ResourceView>
    </Page>
  );
}

/** What every security page loads besides the security itself. */
function useRelated(security: api.SecurityDetail) {
  const { orgId } = useWorkspace();
  const stakeholder = useResource((signal) => apiRequest(api.routes.getStakeholder, { params: { orgId, id: security.stakeholderId }, signal }), [orgId, security.stakeholderId]);
  const timeline = useResource((signal) => apiRequest(api.routes.getSecurityTimeline, { params: { orgId, id: security.id }, signal }), [orgId, security.id]);
  return { stakeholder, timeline };
}

/** A quantity of a security, or "—" when the security carries no numbers (never a made-up zero). */
function quantity(format: ReturnType<typeof useWorkspace>["format"], value: string | null | undefined, unit?: string): string {
  if (value === null || value === undefined) return DASH;
  return unit ? `${format.shares(value)} ${unit}` : format.shares(value);
}

function SecurityBody({ security, initialDialog, onChanged, onDialogClosed }: { security: api.SecurityDetail; initialDialog?: SecurityDialog; onChanged: () => void; onDialogClosed?: () => void }) {
  const workspace = useWorkspace();
  const { orgId, today, canWrite, href } = workspace;
  const own = workspace.isOwn(security.stakeholderId);
  const [dialog, setDialog] = useState<SecurityDialog | null>(initialDialog && canWrite && !own ? initialDialog : null);
  const closeDialog = () => {
    setDialog(null);
    onDialogClosed?.();
  };
  const dialogDone = () => {
    closeDialog();
    onChanged();
  };
  const { stakeholder, timeline } = useRelated(security);
  const vestingTermsId = terms.vestingTermsId(security.terms);
  const vesting = useResource((signal) => apiRequest(api.routes.getSecurityVesting, { params: { orgId, id: security.id }, signal }), [orgId, security.id], security.family !== "WARRANT" || vestingTermsId !== null);
  const vestingDefinition = useResource((signal) => apiRequest(api.routes.getVestingTerms, { params: { orgId, id: vestingTermsId ?? "" }, signal }), [orgId, vestingTermsId], vestingTermsId !== null);
  const plan = useResource((signal) => apiRequest(api.routes.getStockPlan, { params: { orgId, id: security.stockPlanId ?? "" }, signal }), [orgId, security.stockPlanId], security.stockPlanId !== null);
  // Shares show the class's par value and warrants its name; an option page shows neither, so it doesn't ask.
  const stockClass = useResource(
    (signal) => apiRequest(api.routes.getStockClass, { params: { orgId, id: security.stockClassId ?? "" }, signal }),
    [orgId, security.stockClassId],
    security.stockClassId !== null && security.family !== "EQUITY_COMPENSATION",
  );
  const option = security.family === "EQUITY_COMPENSATION";
  // The FMV of the class the option is on (common unless the grant says otherwise), never the default class's.
  const fmv = useResource(
    (signal) => apiRequest(api.routes.getFmv, { params: { orgId }, query: { date: today, ...(security.stockClassId ? { stockClassId: security.stockClassId } : {}) }, signal }),
    [orgId, today, security.stockClassId],
    option,
  );
  const isoSplit = useResource((signal) => apiRequest(api.routes.getIsoSplit, { params: { orgId, id: security.stakeholderId }, signal }), [orgId, security.stakeholderId], security.subtype === "OPTION_ISO");
  const elections = useResource((signal) => apiRequest(api.routes.listElections83b, { params: { orgId }, query: { securityId: security.id }, signal }), [orgId, security.id], security.family === "STOCK");

  const outstanding = security.numbers?.outstanding ?? null;
  const pending = isExecutionPending(security.executionStatus) && isPositive(outstanding);
  const origin = terms.origin(security.terms);
  const sourceBadge = security.lineage.parent && origin
    ? `${origin === "EXERCISE" ? "Exercised from" : origin === "CONVERSION" ? "Converted from" : origin === "TRANSFER" ? "Transferred from" : "From"} ${security.lineage.parent.displayId}`
    : null;
  const extendable = Boolean(security.deadlines?.contractual) && isPositive(outstanding);
  const reverseLast = { label: "Reverse last transaction", icon: "refresh" as const, onSelect: () => setDialog("reverse") };
  const actions: ActionEntry[] = option
    ? [
        isPositive(security.numbers?.exercisable) && !pending ? { label: "Record exercise", icon: "check", to: href(`securities/${security.id}/exercise`) } : null,
        isPositive(outstanding) ? { label: "Cancel", icon: "x", onSelect: () => setDialog("cancel") } : null,
        pending ? { label: "Mark executed", icon: "checkCircle", onSelect: () => setDialog("markExecuted") } : null,
        extendable ? { label: "Extend exercise deadline", icon: "clock", onSelect: () => setDialog("extend") } : null,
        { label: "Upload document", icon: "upload", onSelect: () => setDialog("upload") },
        "separator",
        reverseLast,
      ]
    : security.family === "WARRANT"
      ? [
          isPositive(outstanding) ? { label: "Cancel", icon: "x", onSelect: () => setDialog("cancel") } : null,
          extendable ? { label: "Extend exercise deadline", icon: "clock", onSelect: () => setDialog("extend") } : null,
          { label: "Upload document", icon: "upload", onSelect: () => setDialog("upload") },
          "separator",
          reverseLast,
        ]
      : [
          { label: "Upload document", icon: "upload", onSelect: () => setDialog("upload") },
          origin === "EXERCISE" && !security.provenance.importedFromPulley ? "separator" : null,
          origin === "EXERCISE" && !security.provenance.importedFromPulley ? { label: "Reverse (exercise shares)", icon: "refresh", onSelect: () => setDialog("reverse") } : null,
        ];
  // The exercise behind a share is its origin command; the server accepts the exercised option's ID as its label. On an
  // option or a warrant, the server names the newest command it would reverse now (lastReversibleCommandId).
  const reverseTarget: ReverseTarget = security.family === "STOCK"
    ? { commandId: security.originCommandId, securityLabel: security.lineage.parent?.displayId ?? security.displayId, stakeholderName: security.stakeholderName, title: "Reverse the exercise" }
    : { commandId: security.lastReversibleCommandId ?? null, securityLabel: security.displayId, stakeholderName: security.stakeholderName };

  const definition = vestingTermsId !== null ? vestingDefinition : null;
  const left = option ? (
    <OptionLeft security={security} vesting={vesting} definition={definition} plan={security.stockPlanId !== null ? plan : null} fmv={fmv} isoSplit={isoSplit} stakeholder={stakeholder} />
  ) : security.family === "STOCK" ? (
    <ShareLeft security={security} vesting={vesting} definition={definition} stockClass={security.stockClassId !== null ? stockClass : null} plan={security.stockPlanId !== null ? plan : null} elections={elections} />
  ) : (
    <WarrantLeft security={security} stockClass={security.stockClassId !== null ? stockClass : null} />
  );
  return (
    <OwnRecordScope own={own}>
      <Card>
        <PageHead
          title={`${security.displayId} ${SECURITY_KIND_LABELS[security.family]}`}
          badges={<>{pending ? <Badge tone="amber">Execution pending</Badge> : <Badge tone={SECURITY_STATUS_TONES[security.status]}>{SECURITY_STATUS_LABELS[security.status]}</Badge>}{sourceBadge ? <Badge tone="blue">{sourceBadge}</Badge> : null}</>}
          actions={own ? null : <ActionsMenu items={actions} />}
        />
        {own && canWrite ? <Banner kind="info" title="Your own holding">Admins never record writes on their own holdings — another admin must.</Banner> : null}
        <div className="grid-detail">
          <div>{left}</div>
          <RightColumn security={security} stakeholder={stakeholder} timeline={timeline} onChanged={onChanged} />
        </div>
      </Card>
      {dialog === "cancel" ? <CancelSecurityDialog securityId={security.id} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "markExecuted" ? <MarkExecutedDialog securityId={security.id} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "extend" ? <ExtendDeadlineDialog security={security} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "reverse" ? <ReverseDialog target={reverseTarget} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "upload" ? <UploadDocumentDialog link={securityLinkIntent(security)} title={`Upload a document for ${security.displayId}`} onClose={closeDialog} onDone={dialogDone} /> : null}
    </OwnRecordScope>
  );
}

function RightColumn({ security, stakeholder, timeline, onChanged }: { security: api.SecurityDetail; stakeholder: Resource<api.StakeholderDetail>; timeline: Resource<TimelineList>; onChanged: () => void }) {
  const pii = usePii();
  return (
    <div>
      <SectionTitle>Stakeholder</SectionTitle>
      <DescriptionList
        split
        rows={[
          ["Stakeholder", <HolderLink id={security.stakeholderId} name={security.stakeholderName} state={holderState(stakeholder.data)} />],
          ["E-mail", <Pending resource={stakeholder} what="the stakeholder" inline>{(data) => pii.email(activeEmails(data)[0]?.email)}</Pending>],
          ["Portal access", <Pending resource={stakeholder} what="the portal access" inline>{(data) => PORTAL_STATE_LABELS[data.portalState]}</Pending>],
        ]}
      />
      <SectionTitle>Attachments</SectionTitle>
      <Attachments documents={security.documents} link={securityLinkIntent(security)} onUploaded={onChanged} />
      <Provenance provenance={security.provenance} />
      <SectionTitle>Activity</SectionTitle>
      <Pending resource={timeline} what="the activity">{(data) => <SecurityTimeline entries={data.items} />}</Pending>
    </div>
  );
}

function Provenance({ provenance }: { provenance: api.Security["provenance"] }) {
  const { org } = useWorkspace();
  if (!provenance.importedFromPulley) return null;
  return (
    <details className="adv mt-12 prov">
      <summary><Icon name="database" /> {api.importSourceLabel(org.importSource)}</summary>
      <div className="adv-b">
        <DescriptionList
          rows={[
            ["Source file", provenance.sourceFile ? <span className="mono">{provenance.sourceFile}</span> : DASH],
            ["Source hash (SHA-256)", provenance.sourceSha256 ? <span className="mono small">{provenance.sourceSha256.slice(0, 24)}…</span> : DASH],
            provenance.pulleyId ? ["Source id", <span className="mono">{api.displaySourceId(provenance.pulleyId)}</span>] : null,
          ]}
        />
      </div>
    </details>
  );
}

export function SecurityTimeline({ entries }: { entries: readonly api.TimelineEntry[] }) {
  const { format } = useWorkspace();
  const newestFirst = [...entries].reverse();
  return (
    <Timeline
      label="Activity"
      items={newestFirst.slice(0, 20).map((entry, index) => ({
        key: `${entry.at}-${index}`,
        title: (
          <>
            {entry.summary}
            {entry.kind === "reversal" ? <> <Badge tone="grey">Reversed</Badge></> : null}
            {entry.note ? <div className="small muted">{entry.note}</div> : null}
          </>
        ),
        meta: `${entry.effectiveDate ? formatDate(entry.effectiveDate) : format.date(format.localDate(entry.at))} · ${entry.actor ?? DASH}`,
      }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Vesting

interface VestingProps {
  security: api.SecurityDetail;
  vesting: Resource<api.SecurityVesting>;
  /** The security's vesting terms; null when it has none. */
  definition: Resource<api.VestingTerms> | null;
  unit: "options" | "shares";
}

function vestingStatus(vesting: api.SecurityVesting | null, today: string): "Vesting" | "Fully vested" | "Stopped" {
  if (!vesting || compareDecimals(vesting.vested, vesting.quantity) >= 0) return "Fully vested";
  if (vesting.vestingStopDate && vesting.vestingStopDate <= today) return "Stopped";
  return "Vesting";
}

function VestingSection(props: VestingProps) {
  return <Pending resource={props.vesting} what="the vesting schedule">{(vesting) => <VestingBody {...props} vesting={vesting} />}</Pending>;
}

/** The schedule's name, length, frequency and cliff, once the vesting terms have loaded. */
function scheduleRows(definition: Resource<api.VestingTerms> | null): DlRow[] {
  if (definition === null) return [["Schedule", "Fully vested"]];
  if (!definition.data) return [["Schedule", <Pending resource={definition} what="the vesting terms" inline>{() => null}</Pending>]];
  const terms = definition.data;
  const schedule = terms.definition;
  return [
    ["Schedule", terms.isTemplate ? terms.name : "Explicit tranches (from the agreement)"],
    ["Duration", schedule.type === "SCHEDULE" ? `${schedule.totalMonths} months` : DASH],
    ["Frequency", schedule.type === "SCHEDULE" ? FREQUENCY_LABELS[schedule.frequency] ?? schedule.frequency : DASH],
    ["Cliff", schedule.type === "SCHEDULE" ? (schedule.cliff ? `${schedule.cliff.months} months` : "None") : DASH],
  ];
}

function VestingBody({ security, vesting, definition, unit }: Omit<VestingProps, "vesting"> & { vesting: api.SecurityVesting }) {
  const { format, today, org } = useWorkspace();
  const status = vestingStatus(vesting, today);
  const issued = security.numbers?.issued ?? vesting.quantity;
  const active = vesting.events.filter((event) => event.state === "ACTIVE");
  const cliff = active.find((event) => event.kind === "CLIFF");
  const next = active.find((event) => event.date > today && (!vesting.vestingStopDate || event.date <= vesting.vestingStopDate));
  const accelerations = vesting.events.filter((event) => event.kind === "ACCELERATION");
  const [scheduleRow, ...shapeRows] = scheduleRows(definition);
  const percent = formatFractionPercent(fractionOf(vesting.vested, issued), 1);
  const cancelled = security.numbers?.forfeited ?? null;
  return (
    <>
      <DescriptionList
        rows={[
          ["Status", <>{<Badge tone={status === "Fully vested" ? "green" : status === "Stopped" ? "amber" : "teal"}>{status}</Badge>}{status === "Stopped" && vesting.vestingStopDate ? <span className="small muted"> on {formatDate(vesting.vestingStopDate)} — termination</span> : null}</>],
          ["Vesting progress", (
            <>
              <div className="mb-8">
                {format.shares(vesting.vested)} of the total {format.shares(issued)} {unit} ({percent}) have vested.
                {cliff && cliff.date > today && status !== "Stopped" ? <b> Cliff on {formatDate(cliff.date)} ({format.shares(cliff.cumulative)} {unit}).</b> : next ? ` Next: ${format.shares(next.quantity)} on ${formatDate(next.date)}.` : ""}
                {vesting.vestingStopDate && vesting.vestingStopDate > today ? ` Vesting stops on ${formatDate(vesting.vestingStopDate)} (scheduled termination).` : ""}
              </div>
              <ProgressBar vested={vesting.vested} unvested={vesting.unvested} cancelled={cancelled} unit={unit} />
            </>
          )],
        ]}
      />
      {vesting.vestingStartDate ? (
        <VestingChart
          events={vesting.events.map((event) => ({ date: event.date, cumulative: event.cumulative, active: event.state === "ACTIVE", cliff: event.kind === "CLIFF" }))}
          total={issued}
          start={vesting.vestingStartDate}
          stopDate={vesting.vestingStopDate}
          label={`Cumulative vested ${unit} over time for ${security.displayId}`}
        />
      ) : null}
      <DescriptionList rows={[scheduleRow, ["Start date", formatDate(vesting.vestingStartDate)], ...shapeRows]} />
      <details className="adv mt-12">
        <summary>Full vesting schedule ({vesting.events.length} events)</summary>
        <div className="adv-b">
          <div className="tbl-scroll" style={{ maxHeight: 340, overflow: "auto" }}>
            <table className="tbl dense" aria-label="Vesting schedule">
              <thead><tr><th scope="col">Date</th><th scope="col" className="num">Tranche</th><th scope="col" className="num">Cumulative</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {vesting.events.map((event, index) => (
                  <tr key={`${event.date}-${index}`}>
                    <td>
                      {formatDate(event.date)}{event.kind === "CLIFF" ? " · cliff" : event.kind === "ACCELERATION" ? " · acceleration" : ""}
                      {event.source === "pulley" ? <span className="faint small"> from {api.importSourceName(org.importSource)}</span> : null}
                    </td>
                    <td className="num">{format.shares(event.quantity)}</td>
                    <td className="num">{format.shares(event.cumulative)}</td>
                    <td>
                      {event.state === "CANCELLED"
                        ? <Badge tone="red">{vesting.vestingStopDate && vesting.vestingStopDate > today ? "Cancels on stop" : "Cancelled"}</Badge>
                        : event.date <= today ? <Badge tone="green">Vested</Badge> : <Badge tone="grey">Unvested</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
      {unit === "options" ? (
        <>
          <h4 className="mt-16">Accelerations</h4>
          {accelerations.length ? (
            <table className="tbl dense" aria-label="Accelerations">
              <thead><tr><th scope="col">Date</th><th scope="col" className="num">Quantity</th></tr></thead>
              <tbody>{accelerations.map((event, index) => <tr key={index}><td>{formatDate(event.date)}</td><td className="num">{format.shares(event.quantity)}</td></tr>)}</tbody>
            </table>
          ) : <p className="muted small">No accelerations.</p>}
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Option

interface OptionProps {
  security: api.SecurityDetail;
  vesting: Resource<api.SecurityVesting>;
  definition: Resource<api.VestingTerms> | null;
  /** The grant's plan; null outside a plan. */
  plan: Resource<api.StockPlanDetail> | null;
  fmv: Resource<api.FmvResponse>;
  isoSplit: Resource<api.IsoSplit>;
  stakeholder: Resource<api.StakeholderDetail>;
}

/** The six post-termination windows: the grant's own, else the plan's default (which waits for the plan). */
function windowRows(security: api.SecurityDetail, plan: api.StockPlanDetail | null): DlRow[] {
  const ownWindows = terms.terminationWindows(security.terms);
  const planWindows = new Map((plan?.defaultTerminationWindows ?? []).map((window) => [window.reason, window]));
  return WINDOW_ORDER.map((reason) => {
    const own = ownWindows.get(reason);
    const inherited = planWindows.get(reason);
    const overrides = own && (!inherited || own.period !== inherited.period || own.unit !== inherited.unit);
    return [TERMINATION_WINDOW_LABELS[reason], own || inherited ? <>{periodLabel(own ?? inherited)}{overrides ? " (override)" : <span className="muted small"> inherited from the plan</span>}</> : DASH] as const;
  });
}

function IsoSplitSection({ security, isoSplit }: { security: api.SecurityDetail; isoSplit: Resource<api.IsoSplit> }) {
  const { format } = useWorkspace();
  if (!isoSplit.data) {
    return (
      <>
        <SectionTitle>ISO/NSO split</SectionTitle>
        <Pending resource={isoSplit} what="the ISO/NSO split">{() => null}</Pending>
      </>
    );
  }
  const lots = isoSplit.data.years.flatMap((year) => year.lots.filter((lot) => lot.securityId === security.id).map((lot) => ({ year: year.year, ...lot })));
  if (!lots.length) return null;
  return (
    <>
      <SectionTitle>ISO/NSO split</SectionTitle>
      <p className="small muted">Statutory $100,000 test: shares first exercisable per calendar year, valued at the FMV on the grant date, across this holder's ISO grants in grant order.</p>
      <div className="tbl-scroll">
        <table className="tbl" aria-label="ISO/NSO split">
          <thead>
            <tr><th scope="col">Year</th><th scope="col" className="num">Shares first exercisable</th><th scope="col" className="num">FMV at grant</th><th scope="col" className="num">Value</th><th scope="col" className="num">ISO</th><th scope="col" className="num">NSO</th></tr>
          </thead>
          <tbody>
            {lots.map((lot) => {
              const shares = sumDecimals([lot.isoQuantity, lot.nsoQuantity]);
              const consumed = isPositive(lot.exercisedIso) || isPositive(lot.exercisedNso);
              return (
                <tr key={lot.year}>
                  <td>{lot.year}{consumed ? <span className="faint small"> · partly exercised</span> : null}</td>
                  <td className="num">{format.shares(shares)}</td>
                  <td className="num">{format.price(lot.fmvAtGrant)}</td>
                  <td className="num">{format.money(multiplyDecimals(shares, lot.fmvAtGrant))}</td>
                  <td className="num">{format.shares(lot.isoQuantity)}</td>
                  <td className="num">{format.shares(lot.nsoQuantity)}</td>
                </tr>
              );
            })}
            <tr className="totals">
              <td>Totals</td>
              <td className="num">{format.shares(sumDecimals(lots.map((lot) => sumDecimals([lot.isoQuantity, lot.nsoQuantity]))))}</td>
              <td />
              <td className="num">{format.money(sumDecimals(lots.map((lot) => multiplyDecimals(sumDecimals([lot.isoQuantity, lot.nsoQuantity]), lot.fmvAtGrant))))}</td>
              <td className="num">{format.shares(sumDecimals(lots.map((lot) => lot.isoQuantity)))}</td>
              <td className="num">{format.shares(sumDecimals(lots.map((lot) => lot.nsoQuantity)))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function OptionLeft({ security, vesting, definition, plan, fmv, isoSplit, stakeholder }: OptionProps) {
  const { format, today, href, org } = useWorkspace();
  const numbers = security.numbers;
  const units = (value: string | undefined) => quantity(format, value, "options");
  const deadlines = security.deadlines;
  const type = optionType(security.subtype);
  const consent = security.documents.find((document) => document.kind === "BOARD_CONSENT");
  const deadlineRows: DlRow[] = deadlines
    ? [
        ["Contractual deadline", deadlines.contractual ? <><b>{formatDate(deadlines.contractual)}</b> <span className="muted small">({formatDaysLeft(today, deadlines.contractual)})</span>{deadlines.reason ? <div className="small muted">{deadlines.reason}</div> : null}</> : DASH],
        ["ISO deadline", deadlines.iso ? <><b>{formatDate(deadlines.iso)}</b> <span className="muted small">({formatDaysLeft(today, deadlines.iso)})</span></> : type === "NSO" ? "— (NSO)" : DASH],
      ]
    : [];
  return (
    <>
      <SectionTitle>Overview</SectionTitle>
      <DescriptionList
        split
        rows={[
          ["Issue date", formatDate(security.issueDate)],
          ["Granted", units(numbers?.issued)],
          ["Outstanding", units(numbers?.outstanding)],
          ["Vested", units(numbers?.vested)],
          ["Vested and unexercised", units(numbers?.exercisable)],
          ["Unvested", units(numbers?.unvested)],
          ["Exercised", units(numbers?.exercised)],
          ["Cancelled", units(numbers?.cancelled)],
          ["Exercise price", format.price(terms.exercisePrice(security.terms))],
          ["Current FMV", (
            <Pending resource={fmv} what="the current FMV" inline>
              {(data) =>
                // Shown only for the option's own class: an answer for another class is not this option's FMV.
                security.stockClassId && data.stockClassId !== security.stockClassId ? <span className="err-inline">Unavailable for this class</span>
                  : data.fmv ? <>{format.price(data.fmv.pricePerShare)} <span className="muted small">({data.fmv.valuationName} · {VALUATION_STATUS_LABELS[data.fmv.status]})</span></>
                    : <Badge tone="red">No 409A</Badge>}
            </Pending>
          )],
          ...deadlineRows,
          ["Expiration date", formatDate(terms.expirationDate(security.terms))],
        ]}
      />
      <SectionTitle>Vesting</SectionTitle>
      <VestingSection security={security} vesting={vesting} definition={definition} unit="options" />
      {type === "ISO" ? <IsoSplitSection security={security} isoSplit={isoSplit} /> : null}
      <SectionTitle>Details</SectionTitle>
      <DescriptionList
        rows={[
          ["Equity plan", security.stockPlanId ? <Link to={href(`equity-plans/${security.stockPlanId}`)}>{plan?.data?.name ?? "Equity plan"}</Link> : "Outside a plan"],
          ["Option type", type ?? DASH],
          ["Board approval date", boardApproval(security, org.importSource)],
          ["Consent document", consent ? <ConsentDocument document={consent} /> : DASH],
          ["Federal exemption", security.exemption.federal ? FEDERAL_EXEMPTION_LABELS[security.exemption.federal] : DASH],
          ["Country", security.exemption.country ?? "United States"],
          ["State exemption", security.exemption.state ?? DASH],
          ["Issue reason", terms.issueReason(security.terms) ?? DASH],
          ["Legend(s)", security.legends.length ? security.legends.map((legend) => legend.name).join(", ") : "Exercise-type defaults"],
          ["Acceleration terms", terms.accelerationLabel(terms.accelerationTerms(security.terms))],
          ["Early exercise allowed", yesNo(terms.earlyExercisable(security.terms))],
          ["Execution status", isExecutionPending(security.executionStatus) ? <Badge tone="amber">{EXECUTION_LABELS[security.executionStatus]}</Badge> : EXECUTION_LABELS[security.executionStatus]],
          ["Exercises", (
            <Pending resource={stakeholder} what="the exercises" inline>
              {(data) => {
                const exercises = data.exercises.filter((exercise) => exercise.securityId === security.id);
                return exercises.length
                  ? exercises.map((exercise) => (
                      <div key={exercise.transactionId}>
                        {formatDate(exercise.exerciseDate)} · {format.shares(exercise.quantity)} {isPositive(exercise.isoQuantity) && isPositive(exercise.nsoQuantity) ? "ISO + NSO" : isPositive(exercise.isoQuantity) ? "ISO" : "NSO"} →{" "}
                        {exercise.resultingShares.map((share, index) => <span key={share.securityId}>{index ? ", " : ""}<SecurityLink id={share.securityId} family="STOCK" displayId={share.displayId} /></span>)}
                      </div>
                    ))
                  : DASH;
              }}
            </Pending>
          )],
        ]}
      />
      <SectionTitle>Post-Termination Exercise</SectionTitle>
      {plan === null ? (
        <DescriptionList label="Post-termination exercise" rows={windowRows(security, null)} />
      ) : (
        <Pending resource={plan} what="the plan's exercise windows">{(data) => <DescriptionList label="Post-termination exercise" rows={windowRows(security, data)} />}</Pending>
      )}
      <SectionTitle>Additional Information</SectionTitle>
      <DescriptionList rows={[["Comments", terms.comments(security.terms).join(" ") || DASH]]} />
    </>
  );
}

function ConsentDocument({ document }: { document: api.DocumentRef }) {
  const { download, error } = useDownload();
  return (
    <>
      <button type="button" className="btn-link" onClick={() => void download(document.id, document.filename)}>{document.filename}</button>
      {error ? <div className="err-inline" role="alert">{error}</div> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shares

interface ShareProps {
  security: api.SecurityDetail;
  vesting: Resource<api.SecurityVesting>;
  definition: Resource<api.VestingTerms> | null;
  /** Null when the security names no class (or plan). */
  stockClass: Resource<api.StockClassDetail> | null;
  plan: Resource<api.StockPlanDetail> | null;
  elections: Resource<ElectionList>;
}

/** The 83(b) line from the share's election record; no record means none was required. */
function electionLabel(security: api.SecurityDetail, elections: ElectionList): string {
  const election = elections.items.filter((item) => item.securityId === security.id).at(-1);
  if (!election) return "Not required";
  return election.status === "FILED" && election.filedDate ? `Filed on ${formatDate(election.filedDate)}${election.proofDocumentId ? " (proof on file)" : ""}` : ELECTION_83B_LABELS[election.status] ?? election.status;
}

function ShareLeft({ security, vesting, definition, stockClass, plan, elections }: ShareProps) {
  const { format, href, org } = useWorkspace();
  const numbers = security.numbers;
  const price = terms.sharePrice(security.terms);
  const capital = terms.capitalContribution(security.terms) ?? (price ? multiplyDecimals(price, numbers?.issued) : null);
  const origin = terms.origin(security.terms);
  const restricted = terms.vestingTermsId(security.terms) !== null;
  const repurchase = terms.repurchaseRight(security.terms);
  const holdingStart = terms.holdingStartDate(security.terms);
  const originLabel = origin === "EXERCISE" ? "Exercised from" : origin === "CONVERSION" ? "Converted from" : origin === "TRANSFER" ? "Transferred from" : origin === "BALANCE" ? "Remainder of" : null;
  const certificate = certificateLabel(security);
  return (
    <>
      <SectionTitle>Overview</SectionTitle>
      <DescriptionList
        split
        rows={[
          ["Fully diluted", quantity(format, numbers?.fullyDiluted, "shares")],
          ["Issued", quantity(format, numbers?.issued, "shares")],
          ["Price per share", format.price(price)],
          ["Par value", stockClass === null ? DASH : <Pending resource={stockClass} what="the share class" inline>{(data) => format.price(data.parValue)}</Pending>],
          ["Capital contribution", format.money(capital)],
          ["Issue date", formatDate(security.issueDate)],
          ["Status", <Badge tone={SECURITY_STATUS_TONES[security.status]}>{SECURITY_STATUS_LABELS[security.status]}</Badge>],
          ["Certificate", security.certificate?.documentId ? <>{certificate} <CertificateDownload documentId={security.certificate.documentId} number={security.certificate.number} /></> : certificate],
        ]}
      />
      {restricted ? (
        <>
          <SectionTitle>Vesting</SectionTitle>
          <VestingSection security={security} vesting={vesting} definition={definition} unit="shares" />
          <DescriptionList
            rows={[[
              "Repurchase right",
              repurchase
                ? <>If the holder leaves before vesting, the company may buy back unvested shares at {repurchase.pricePerShare ? format.price(repurchase.pricePerShare) : "the price paid"}{repurchase.window ? ` within ${periodLabel(repurchase.window)} after termination` : ""}{repurchase.termsText ? <span className="muted small"> ({repurchase.termsText})</span> : null}</>
                : `not recorded in ${api.importSourceName(org.importSource)} — enter from the stock purchase agreement`,
            ]]}
          />
          {isPositive(numbers?.unvested) ? <p className="small muted">Cap Table doesn't record repurchases: counsel papers a repurchase offline and the share gets a dated note and document.</p> : null}
        </>
      ) : null}
      <SectionTitle>Details</SectionTitle>
      <DescriptionList
        rows={[
          ["Share class", security.stockClassId ? <Link to={href(`share-classes/${security.stockClassId}`)}>{stockClass?.data?.name ?? "Share class"}</Link> : DASH],
          originLabel && security.lineage.parent ? [originLabel, <SecurityLink id={security.lineage.parent.id} family={origin === "CONVERSION" ? "CONVERTIBLE" : origin === "EXERCISE" ? "EQUITY_COMPENSATION" : "STOCK"} displayId={security.lineage.parent.displayId} />] : null,
          plan !== null ? ["Equity plan", <Pending resource={plan} what="the equity plan" inline>{(data) => data.name}</Pending>] : null,
          ["Consideration", terms.consideration(security.terms) ?? DASH],
          ["Board approval date", security.boardApprovalDate ? formatDate(security.boardApprovalDate) : origin === "EXERCISE" ? "n/a (exercise of an approved grant)" : boardApproval(security, org.importSource)],
          ["Federal exemption", security.exemption.federal ? FEDERAL_EXEMPTION_LABELS[security.exemption.federal] : DASH],
          ["State exemption", security.exemption.state ?? DASH],
          ["Holding start date", formatDate(holdingStart)],
          ["Issue reason", terms.issueReason(security.terms) ?? DASH],
          ["Legends", security.legends.length ? security.legends.map((legend) => legend.name).join(", ") : DASH],
          ["Rule 144 date", holdingStart ? formatDate(addYears(holdingStart, 1)) : DASH],
          ["83(b)", <Pending resource={elections} what="the 83(b) record" inline>{(data) => electionLabel(security, data)}</Pending>],
          ["Execution status", EXECUTION_LABELS[security.executionStatus]],
        ]}
      />
      <SectionTitle>Additional Information</SectionTitle>
      <DescriptionList rows={[["Comments", terms.comments(security.terms).join(" ") || DASH]]} />
    </>
  );
}

function CertificateDownload({ documentId, number }: { documentId: string; number: string }) {
  const { download, error } = useDownload();
  return (
    <>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => void download(documentId, `${number}_certificate_unsigned.pdf`)}>
        Download <span className="sr-only">certificate {number}</span>
      </button>
      {error ? <div className="err-inline" role="alert">{error}</div> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Warrant

function WarrantLeft({ security, stockClass }: { security: api.SecurityDetail; stockClass: Resource<api.StockClassDetail> | null }) {
  const { format, org } = useWorkspace();
  const numbers = security.numbers;
  return (
    <>
      <SectionTitle>Overview</SectionTitle>
      <DescriptionList
        split
        rows={[
          ["Issue date", formatDate(security.issueDate)],
          ["Quantity", quantity(format, numbers?.issued, "shares")],
          ["Share class", stockClass === null ? DASH : <Pending resource={stockClass} what="the share class" inline>{(data) => data.name}</Pending>],
          ["Exercise price", format.price(terms.exercisePrice(security.terms))],
          ["Exercised", quantity(format, numbers?.exercised)],
          ["Outstanding", quantity(format, numbers?.outstanding)],
          ["Expiration date", formatDate(terms.expirationDate(security.terms))],
          ["Vesting", terms.vestingTermsId(security.terms) ? `${quantity(format, numbers?.vested)} vested` : "Fully vested"],
        ]}
      />
      <SectionTitle>Details</SectionTitle>
      <DescriptionList
        rows={[
          ["Board approval date", boardApproval(security, org.importSource)],
          ["Federal exemption", security.exemption.federal ? FEDERAL_EXEMPTION_LABELS[security.exemption.federal] : DASH],
          ["Legends", security.legends.length ? security.legends.map((legend) => legend.name).join(", ") : DASH],
          ["Exercise provisions (imported)", terms.exerciseProvisions(security.terms) ?? DASH],
          ["Issue reason", terms.issueReason(security.terms) ?? DASH],
        ]}
      />
      <p className="small muted mt-12">
        The app doesn't record warrant exercises. An expired warrant is cancelled when due items are processed after its expiration date (audited).
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// SAFE (converted history)

function ConvertibleBody({ security, onChanged }: { security: api.SecurityDetail; onChanged: () => void }) {
  const workspace = useWorkspace();
  const { orgId, format, canWrite } = workspace;
  const [uploading, setUploading] = useState(false);
  const pii = usePii();
  const own = workspace.isOwn(security.stakeholderId);
  const { stakeholder, timeline } = useRelated(security);
  const results = security.lineage.children;
  const resultIds = results.map((child) => child.id).join(",");
  const resulting = useResource(
    (signal) => Promise.all(results.map((child) => apiRequest(api.routes.getSecurity, { params: { orgId, id: child.id }, signal }))),
    [orgId, resultIds],
    results.length > 0,
  );
  const safe = terms.safeTerms(security.terms);
  const converted = security.status === "CONVERTED";
  // The conversion date is the conversion transaction's, from the timeline (else the resulting share's issue date).
  const dateFrom = (entries: TimelineList) => entries.items.find((entry) => entry.type.includes("CONVERSION") && entry.kind === "transaction")?.effectiveDate ?? resulting.data?.[0]?.issueDate ?? null;
  const conversionDate = timeline.data ? dateFrom(timeline.data) : null;
  const intoLinks: ReactNode = results.length
    ? results.map((child, index) => <span key={child.id}>{index ? ", " : ""}<SecurityLink id={child.id} family="STOCK" displayId={child.displayId} /></span>)
    : DASH;
  return (
    <OwnRecordScope own={own}>
      <Card>
        {converted ? (
          <Banner kind="info">
            Converted{conversionDate ? ` on ${formatDate(conversionDate)}` : ""} into {intoLinks}{safe.conversionPrice ? ` at ${format.price(safe.conversionPrice)} per share` : ""} (per closing memo).
          </Banner>
        ) : null}
        <PageHead
          title={security.displayId}
          badges={converted && results.length ? <Badge tone="blue">Converted to {results.map((child) => child.displayId).join(", ")}</Badge> : <Badge tone={SECURITY_STATUS_TONES[security.status]}>{SECURITY_STATUS_LABELS[security.status]}</Badge>}
          actions={own ? null : <ActionsMenu items={[{ label: "Upload document", icon: "upload", onSelect: () => setUploading(true) }]} />}
        />
        {own && canWrite ? <Banner kind="info" title="Your own holding">Admins never record writes on their own holdings — another admin must.</Banner> : null}
        <div className="grid-detail">
          <div>
            <SectionTitle>Terms</SectionTitle>
            <DescriptionList
              split
              rows={[
                ["SAFE form (as recorded)", safe.form ?? DASH],
                ["Valuation cap", safe.valuationCap ? format.money(safe.valuationCap, 0) : "Uncapped"],
                ["Discount", discountLabel(safe.discountRate)],
                ["Principal", format.money(safe.principal, 0)],
                ["Pro rata", yesNo(safe.proRata)],
                ["MFN", yesNo(safe.mfn)],
              ]}
            />
            <SectionTitle>Conversion</SectionTitle>
            <DescriptionList
              split
              rows={[
                ["Conversion date", converted ? <Pending resource={timeline} what="the conversion date" inline>{(data) => formatDate(dateFrom(data))}</Pending> : DASH],
                ["Resulting share", intoLinks],
                ["Conversion price", safe.conversionPrice ? <>{format.price(safe.conversionPrice)} <span className="muted small">per closing memo</span></> : DASH],
                ["Shares", results.length === 0 ? DASH : (
                  <Pending resource={resulting} what="the resulting shares" inline>
                    {(data) => { const issued = sumDecimals(data.map((item) => item.numbers?.issued)); return isPositive(issued) ? <>{format.shares(issued)} <span className="muted small">per closing memo</span></> : DASH; }}
                  </Pending>
                )],
                ["Principal converted", converted ? format.money(safe.principal, 0) : DASH],
              ]}
            />
            <SectionTitle>Details</SectionTitle>
            <DescriptionList
              split
              rows={[
                ["Issue date", formatDate(security.issueDate)],
                ["Funds received", formatDate(safe.fundsReceivedOn)],
                ["Board approval date", boardApproval(security, workspace.org.importSource)],
                ["Federal exemption", security.exemption.federal ? FEDERAL_EXEMPTION_LABELS[security.exemption.federal] : DASH],
                ["State exemption", security.exemption.state ?? DASH],
              ]}
            />
            <SectionTitle>Documents</SectionTitle>
            <LinkedDocuments targetType="security" targetId={security.id} />
            <p className="small muted">The app does not compute SAFE conversions; values come from the closing memo.</p>
          </div>
          <div>
            <SectionTitle>Stakeholder</SectionTitle>
            <DescriptionList
              split
              rows={[
                ["Stakeholder", <HolderLink id={security.stakeholderId} name={security.stakeholderName} state={holderState(stakeholder.data)} />],
                ["E-mail", <Pending resource={stakeholder} what="the stakeholder" inline>{(data) => pii.email(activeEmails(data)[0]?.email)}</Pending>],
              ]}
            />
            <SectionTitle>Attachments</SectionTitle>
            <Attachments documents={security.documents} link={securityLinkIntent(security)} onUploaded={onChanged} />
            <Provenance provenance={security.provenance} />
            <SectionTitle>Activity</SectionTitle>
            <Pending resource={timeline} what="the activity">{(data) => <SecurityTimeline entries={data.items} />}</Pending>
          </div>
        </div>
      </Card>
      {uploading ? <UploadDocumentDialog link={securityLinkIntent(security)} title={`Upload a document for ${security.displayId}`} onClose={() => setUploading(false)} onDone={() => { setUploading(false); onChanged(); }} /> : null}
    </OwnRecordScope>
  );
}
