import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "#shared";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
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
import { RecordRepurchaseDialog } from "../components/flows/RecordRepurchaseDialog.tsx";
import { ReverseDialog, type ReverseTarget } from "../components/flows/ReverseDialog.tsx";
import { securityLinkIntent, UploadDocumentDialog } from "../components/flows/DocumentDialogs.tsx";
import { compareDecimals, formatFractionPercent, fractionOf, isPositive, multiplyDecimals, sumDecimals } from "../lib/decimal.ts";
import { electionsInForce } from "../lib/elections.ts";
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
  blocksExercise,
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

type SecurityDialog = "cancel" | "markExecuted" | "extend" | "reverse" | "upload" | "repurchase";

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
    ? `${origin === "EXERCISE" ? "Exercised from" : origin === "CONVERSION" ? "Converted from" : origin === "TRANSFER" ? "Transferred from" : origin === "BALANCE" ? "Remainder of" : "From"} ${security.lineage.parent.displayId}`
    : null;
  const extendable = Boolean(security.deadlines?.contractual) && isPositive(outstanding);
  const repurchaseable = security.family === "STOCK" && terms.vestingTermsId(security.terms) !== null && isPositive(security.numbers?.unvested) && Boolean(stakeholder.data?.termination);
  const reverseLast = { label: "Reverse last transaction", icon: "refresh" as const, onSelect: () => setDialog("reverse") };
  const actions: ActionEntry[] = option
    ? [
        // A grant awaiting only the company signatory's signature can be exercised.
        isPositive(security.numbers?.exercisable) && !blocksExercise(security.executionStatus) ? { label: "Record exercise", icon: "check", to: href(`securities/${security.id}/exercise`) } : null,
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
          // A terminated holder's unvested restricted shares, once the company has repurchased and paid for them.
          repurchaseable ? { label: "Record repurchase", icon: "check", onSelect: () => setDialog("repurchase") } : null,
          { label: "Upload document", icon: "upload", onSelect: () => setDialog("upload") },
          "separator",
          reverseLast,
        ];
  // The server names the newest command it would reverse now (lastReversibleCommandId). The label it accepts is the
  // security of that command's first transaction: the exercised option for exercise shares, the repurchased lot for a
  // balance lot (both the share's parent, when the command made the share), the share itself otherwise.
  const lastReversible = security.lastReversibleCommandId ?? null;
  const reverseTarget: ReverseTarget = {
    commandId: lastReversible,
    securityLabel: security.family === "STOCK" && lastReversible === security.originCommandId && security.lineage.parent ? security.lineage.parent.displayId : security.displayId,
    stakeholderName: security.stakeholderName,
  };

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
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,62fr)_minmax(17.5rem,38fr)]">
          <div className="flex min-w-0 flex-col gap-3">{left}</div>
          <RightColumn security={security} stakeholder={stakeholder} timeline={timeline} onChanged={onChanged} />
        </div>
      </Card>
      {dialog === "cancel" ? <CancelSecurityDialog securityId={security.id} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "markExecuted" ? <MarkExecutedDialog securityId={security.id} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "extend" ? <ExtendDeadlineDialog security={security} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "repurchase" ? <RecordRepurchaseDialog securityId={security.id} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "reverse" ? <ReverseDialog target={reverseTarget} onClose={closeDialog} onDone={dialogDone} /> : null}
      {dialog === "upload" ? <UploadDocumentDialog link={securityLinkIntent(security)} title={`Upload a document for ${security.displayId}`} onClose={closeDialog} onDone={dialogDone} /> : null}
    </OwnRecordScope>
  );
}

function RightColumn({ security, stakeholder, timeline, onChanged }: { security: api.SecurityDetail; stakeholder: Resource<api.StakeholderDetail>; timeline: Resource<TimelineList>; onChanged: () => void }) {
  const pii = usePii();
  return (
    <div className="flex min-w-0 flex-col gap-3">
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

/** A section that opens on demand: shadcn/ui's Collapsible, its trigger a full-width ghost button. */
function Disclosure({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Collapsible className="group/disclosure rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="h-auto w-full justify-between rounded-lg px-3 py-2.5 font-semibold">
          <span className="flex items-center gap-1.5">{title}</span>
          <ChevronDownIcon aria-hidden="true" className="transition-transform group-data-[state=open]/disclosure:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function Provenance({ provenance }: { provenance: api.Security["provenance"] }) {
  const { org } = useWorkspace();
  if (!provenance.importedFromPulley) return null;
  return (
    <Disclosure title={<><Icon name="database" /> {api.importSourceLabel(org.importSource)}</>}>
      <DescriptionList
        rows={[
          ["Source file", provenance.sourceFile ? <span className="font-mono text-xs">{provenance.sourceFile}</span> : DASH],
          ["Source hash (SHA-256)", provenance.sourceSha256 ? <span className="font-mono text-xs">{provenance.sourceSha256.slice(0, 24)}…</span> : DASH],
          provenance.pulleyId ? ["Source id", <span className="font-mono text-xs">{api.displaySourceId(provenance.pulleyId)}</span>] : null,
        ]}
      />
    </Disclosure>
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
            {entry.note ? <div className="text-xs text-muted-foreground">{entry.note}</div> : null}
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
          ["Status", <>{<Badge tone={status === "Fully vested" ? "green" : status === "Stopped" ? "amber" : "teal"}>{status}</Badge>}{status === "Stopped" && vesting.vestingStopDate ? <span className="text-xs text-muted-foreground"> on {formatDate(vesting.vestingStopDate)} — termination</span> : null}</>],
          ["Vesting progress", (
            <>
              <div className="mb-2">
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
      <Disclosure title={<>Full vesting schedule ({vesting.events.length} events)</>}>
        <div className="max-h-85 overflow-auto">
          <Table aria-label="Vesting schedule">
            <TableHeader><TableRow><TableHead scope="col">Date</TableHead><TableHead scope="col" className="text-right">Tranche</TableHead><TableHead scope="col" className="text-right">Cumulative</TableHead><TableHead scope="col">Status</TableHead></TableRow></TableHeader>
            <TableBody>
              {vesting.events.map((event, index) => (
                <TableRow key={`${event.date}-${index}`}>
                  <TableCell>
                    {formatDate(event.date)}{event.kind === "CLIFF" ? " · cliff" : event.kind === "ACCELERATION" ? " · acceleration" : ""}
                    {event.source === "pulley" ? <span className="text-xs text-muted-foreground"> from {api.importSourceName(org.importSource)}</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{format.shares(event.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{format.shares(event.cumulative)}</TableCell>
                  <TableCell>
                    {event.state === "CANCELLED"
                      ? <Badge tone="red">{vesting.vestingStopDate && vesting.vestingStopDate > today ? "Cancels on stop" : "Cancelled"}</Badge>
                      : event.date <= today ? <Badge tone="green">Vested</Badge> : <Badge tone="grey">Unvested</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Disclosure>
      {unit === "options" ? (
        <>
          <h4 className="text-sm font-semibold">Accelerations</h4>
          {accelerations.length ? (
            <Table aria-label="Accelerations">
              <TableHeader><TableRow><TableHead scope="col">Date</TableHead><TableHead scope="col" className="text-right">Quantity</TableHead></TableRow></TableHeader>
              <TableBody>{accelerations.map((event, index) => <TableRow key={index}><TableCell>{formatDate(event.date)}</TableCell><TableCell className="text-right tabular-nums">{format.shares(event.quantity)}</TableCell></TableRow>)}</TableBody>
            </Table>
          ) : <p className="text-xs text-muted-foreground">No accelerations.</p>}
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
    return [TERMINATION_WINDOW_LABELS[reason], own || inherited ? <>{periodLabel(own ?? inherited)}{overrides ? " (override)" : <span className="text-xs text-muted-foreground"> inherited from the plan</span>}</> : DASH] as const;
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
      <p className="text-xs text-muted-foreground">Statutory $100,000 test: shares first exercisable per calendar year, valued at the FMV on the grant date, across this holder's ISO grants in grant order.</p>
      <Table aria-label="ISO/NSO split">
        <TableHeader>
          <TableRow><TableHead scope="col">Year</TableHead><TableHead scope="col" className="text-right">Shares first exercisable</TableHead><TableHead scope="col" className="text-right">FMV at grant</TableHead><TableHead scope="col" className="text-right">Value</TableHead><TableHead scope="col" className="text-right">ISO</TableHead><TableHead scope="col" className="text-right">NSO</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {lots.map((lot) => {
            const shares = sumDecimals([lot.isoQuantity, lot.nsoQuantity]);
            const consumed = isPositive(lot.exercisedIso) || isPositive(lot.exercisedNso);
            return (
              <TableRow key={lot.year}>
                <TableCell>{lot.year}{consumed ? <span className="text-xs text-muted-foreground"> · partly exercised</span> : null}</TableCell>
                <TableCell className="text-right tabular-nums">{format.shares(shares)}</TableCell>
                <TableCell className="text-right tabular-nums">{format.price(lot.fmvAtGrant)}</TableCell>
                <TableCell className="text-right tabular-nums">{format.money(multiplyDecimals(shares, lot.fmvAtGrant))}</TableCell>
                <TableCell className="text-right tabular-nums">{format.shares(lot.isoQuantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{format.shares(lot.nsoQuantity)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Totals</TableCell>
            <TableCell className="text-right tabular-nums">{format.shares(sumDecimals(lots.map((lot) => sumDecimals([lot.isoQuantity, lot.nsoQuantity]))))}</TableCell>
            <TableCell />
            <TableCell className="text-right tabular-nums">{format.money(sumDecimals(lots.map((lot) => multiplyDecimals(sumDecimals([lot.isoQuantity, lot.nsoQuantity]), lot.fmvAtGrant))))}</TableCell>
            <TableCell className="text-right tabular-nums">{format.shares(sumDecimals(lots.map((lot) => lot.isoQuantity)))}</TableCell>
            <TableCell className="text-right tabular-nums">{format.shares(sumDecimals(lots.map((lot) => lot.nsoQuantity)))}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
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
        ["Contractual deadline", deadlines.contractual ? <><b>{formatDate(deadlines.contractual)}</b> <span className="text-xs text-muted-foreground">({formatDaysLeft(today, deadlines.contractual)})</span>{deadlines.reason ? <div className="text-xs text-muted-foreground">{deadlines.reason}</div> : null}</> : DASH],
        ["ISO deadline", deadlines.iso ? <><b>{formatDate(deadlines.iso)}</b> <span className="text-xs text-muted-foreground">({formatDaysLeft(today, deadlines.iso)})</span></> : type === "NSO" ? "— (NSO)" : DASH],
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
                security.stockClassId && data.stockClassId !== security.stockClassId ? <span className="text-sm font-medium text-destructive">Unavailable for this class</span>
                  : data.fmv ? <>{format.price(data.fmv.pricePerShare)} <span className="text-xs text-muted-foreground">({data.fmv.valuationName} · {VALUATION_STATUS_LABELS[data.fmv.status]})</span></>
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
      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => void download(document.id, document.filename)}>{document.filename}</Button>
      {error ? <div className="text-sm font-medium text-destructive" role="alert">{error}</div> : null}
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

/**
 * The 83(b) line from the share's election record in force (by supersession). With no record, a restricted share's
 * election is "Not recorded" (one may have been required); only a share without vesting needs none.
 */
function electionLabel(security: api.SecurityDetail, elections: ElectionList, restricted: boolean): string {
  const election = electionsInForce(elections.items).get(security.id);
  if (!election) return restricted ? "Not recorded" : "Not required";
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
          // A balance lot adds no contribution: the lot it came from keeps what was paid for these shares.
          ["Capital contribution", origin === "BALANCE" && terms.capitalContribution(security.terms) === null && security.lineage.parent ? <>Counted on <SecurityLink id={security.lineage.parent.id} family="STOCK" displayId={security.lineage.parent.displayId} /></> : format.money(capital)],
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
                ? <>If the holder leaves before vesting, the company may buy back unvested shares at {repurchase.pricePerShare ? format.price(repurchase.pricePerShare) : "the price paid"}{repurchase.noDeadline ? " — no deadline (per agreement)" : repurchase.window ? ` within ${periodLabel(repurchase.window)} after termination` : ""}{repurchase.termsText ? <span className="text-xs text-muted-foreground"> ({repurchase.termsText})</span> : null}</>
                : `not recorded in ${api.importSourceName(org.importSource)} — enter from the stock purchase agreement`,
            ]]}
          />
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
          ["83(b)", <Pending resource={elections} what="the 83(b) record" inline>{(data) => electionLabel(security, data, restricted)}</Pending>],
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
      <Button type="button" variant="ghost" size="xs" onClick={() => void download(documentId, `${number}_certificate_unsigned.pdf`)}>
        Download <span className="sr-only">certificate {number}</span>
      </Button>
      {error ? <div className="text-sm font-medium text-destructive" role="alert">{error}</div> : null}
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
      <p className="text-xs text-muted-foreground">
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
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,62fr)_minmax(17.5rem,38fr)]">
          <div className="flex min-w-0 flex-col gap-3">
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
                ["Conversion price", safe.conversionPrice ? <>{format.price(safe.conversionPrice)} <span className="text-xs text-muted-foreground">per closing memo</span></> : DASH],
                ["Shares", results.length === 0 ? DASH : (
                  <Pending resource={resulting} what="the resulting shares" inline>
                    {(data) => { const issued = sumDecimals(data.map((item) => item.numbers?.issued)); return isPositive(issued) ? <>{format.shares(issued)} <span className="text-xs text-muted-foreground">per closing memo</span></> : DASH; }}
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
            <p className="text-xs text-muted-foreground">The app does not compute SAFE conversions; values come from the closing memo.</p>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
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
