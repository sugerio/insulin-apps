import { Link, useParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { RecordActivity } from "../components/Activity.tsx";
import { Meter } from "../components/Charts.tsx";
import { DataTable, byDecimal, byDisplayId, byRatio, byText } from "../components/DataTable.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { LinkedDocuments } from "../components/Documents.tsx";
import { Badge, Pending, ResourceView } from "../components/Feedback.tsx";
import { HolderLink, SecurityLink } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead, SectionTitle } from "../components/Page.tsx";
import { formatFractionPercent, fractionOf, isPositive, subtractDecimals, sumDecimals } from "../lib/decimal.ts";
import { DASH, daysBetween, formatDate } from "../lib/format.ts";
import { SECURITY_STATUS_LABELS, SECURITY_STATUS_TONES, TERMINATION_WINDOW_LABELS, isExecutionPending, periodLabel } from "../lib/labels.ts";
import { allOf, useResource } from "../lib/useResource.ts";

// Equity plans, view only, in Pulley's section order plus the read-only Return-to-pool
// rules. There is no form to amend a plan: plans come in with the import.

const RULES = [
  ["cancelledUnvestedAwards", "Cancelled unvested awards"],
  ["expiredVestedOptions", "Expired vested options"],
  ["repurchasedUnvestedShares", "Repurchased unvested shares"],
  ["repurchasedVestedShares", "Repurchased vested shares"],
  ["sharesWithheldForTax", "Shares withheld for taxes or net exercise"],
] as const satisfies readonly (readonly [keyof api.PlanReturnRules, string])[];
const WINDOW_ORDER = ["VOLUNTARY", "INVOLUNTARY", "WITH_CAUSE", "DEATH", "DISABILITY", "RETIREMENT"] as const;

/** "10 years", from the plan's start to its expiration. */
function termLabel(plan: api.StockPlan): string {
  const start = plan.effectiveDate ?? plan.boardApprovalDate;
  if (!start || !plan.expirationDate) return DASH;
  const years = Math.round(daysBetween(start, plan.expirationDate) / 365.25);
  return `${years} year${years === 1 ? "" : "s"}`;
}

/** Outstanding awards per plan, from the ownership rows of the cap table. */
function awardsByPlan(capTable: api.CapTableResponse): Map<string, string> {
  const totals = new Map<string, string>();
  for (const row of capTable.ownership ?? []) {
    for (const [planId, quantity] of Object.entries(row.planAwards)) totals.set(planId, sumDecimals([totals.get(planId), quantity]));
  }
  return totals;
}

export function EquityPlansPage() {
  const { orgId, format, href } = useWorkspace();
  const plans = useResource((signal) => apiRequest(api.routes.listStockPlans, { params: { orgId }, signal }), [orgId]);
  const capTable = useResource((signal) => apiRequest(api.routes.getCapTable, { params: { orgId }, query: { tab: "ownership" }, signal }), [orgId]);
  return (
    <Page title="Equity Plans" crumbs={[["Cap Table", href("captable")], ["Equity Plans"]]}>
      <Card>
        <PageHead title="Equity Plans" sub="View only. Plans come in with the import; the app has no form to amend them." />
        {/* "% of FD" comes from the cap table: the list waits for it rather than showing a blank share. */}
        <ResourceView resource={allOf(plans, capTable)}>
          {([data, capTableData]) => {
            const awards = awardsByPlan(capTableData);
            const fd = capTableData.metrics.fullyDiluted;
            // The plan's outstanding awards plus its unissued pool, both of which count in fully diluted.
            const shareOfFd = (plan: api.StockPlan) => fractionOf(sumDecimals([awards.get(plan.id), plan.availableToGrant]), fd);
            return (
              <DataTable
                id="equity-plans"
                label="Equity plans"
                rows={data.items}
                rowKey={(plan) => plan.id}
                paginate={false}
                search={(plan) => plan.name}
                empty="No equity plans yet."
                columns={[
                  { key: "name", label: "Name", render: (plan) => <Link className="cell-link" to={href(`equity-plans/${plan.id}`)}>{plan.name}</Link>, compare: byText((plan) => plan.name) },
                  { key: "status", label: "Status", render: (plan) => <Badge tone={plan.status === "active" ? "green" : "grey"}>{plan.status === "active" ? "Active" : "Terminated"}</Badge> },
                  { key: "board", label: "Board approval", render: (plan) => formatDate(plan.boardApprovalDate), compare: byText((plan) => plan.boardApprovalDate) },
                  {
                    key: "size", label: "Plan size", numeric: true,
                    render: (plan) => <>{format.shares(plan.poolSize)}<div className="small muted">{format.shares(plan.availableToGrant)} available</div></>,
                    compare: byDecimal((plan) => plan.poolSize),
                  },
                  { key: "term", label: "Term", render: termLabel },
                  { key: "out", label: "Outstanding", numeric: true, render: (plan) => format.shares(plan.equityOutstanding), compare: byDecimal((plan) => plan.equityOutstanding) },
                  {
                    key: "pct", label: "% of FD", numeric: true,
                    render: (plan) => formatFractionPercent(shareOfFd(plan)),
                    compare: byRatio((plan) => { const share = shareOfFd(plan); return `${share.num}/${share.den}`; }),
                  },
                ]}
              />
            );
          }}
        </ResourceView>
      </Card>
    </Page>
  );
}

export function EquityPlanPage() {
  const { orgId, href } = useWorkspace();
  const { planId = "" } = useParams();
  const plan = useResource((signal) => apiRequest(api.routes.getStockPlan, { params: { orgId, id: planId }, signal }), [orgId, planId]);
  const title = plan.data?.name ?? "Equity plan";
  return (
    <Page title={title} crumbs={[["Equity Plans", href("equity-plans")], [title]]}>
      <ResourceView resource={plan} notFound="This equity plan does not exist.">{(data) => <EquityPlanBody plan={data} />}</ResourceView>
    </Page>
  );
}

function EquityPlanBody({ plan }: { plan: api.StockPlanDetail }) {
  const { orgId, format, href } = useWorkspace();
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, signal }), [orgId]);
  const stockClass = useResource((signal) => apiRequest(api.routes.getStockClass, { params: { orgId, id: plan.stockClassId }, signal }), [orgId, plan.stockClassId]);
  const issued = securities.data?.items.filter((security) => security.stockPlanId === plan.id && (security.family === "EQUITY_COMPENSATION" || security.family === "STOCK")) ?? null;
  const awards = issued ? sumDecimals(issued.filter((security) => security.family === "EQUITY_COMPENSATION").map((security) => security.numbers?.outstanding)) : null;
  const fromExercises = awards === null ? null : subtractDecimals(plan.equityOutstanding, awards);
  const used = subtractDecimals(plan.poolSize, plan.availableToGrant);
  const windows = new Map(plan.defaultTerminationWindows.map((window) => [window.reason, window]));
  const confirmation = plan.returnRulesConfirmation;
  return (
    <Card>
      <PageHead title={plan.name} after={<Badge tone={plan.status === "active" ? "green" : "grey"}>{plan.status === "active" ? "Active" : "Terminated"}</Badge>} />
      <SectionTitle>Details</SectionTitle>
      <DescriptionList
        rows={[
          ["Plan size", format.shares(plan.poolSize)],
          ["Available to grant", format.shares(plan.availableToGrant)],
          ["Equity outstanding", awards !== null && fromExercises !== null
            ? <>{format.shares(plan.equityOutstanding)} <span className="muted small">({format.shares(awards)} outstanding options + {format.shares(isPositive(fromExercises) ? fromExercises : "0")} shares issued from exercises)</span></>
            : format.shares(plan.equityOutstanding)],
          ["Equity retired", format.shares(plan.equityRetired)],
        ]}
      />
      <div className="mt-12">
        <Meter used={used} size={plan.poolSize} label="Plan used" />
        <div className="small muted mt-4">{formatFractionPercent(fractionOf(used, plan.poolSize))} used</div>
      </div>
      <SectionTitle>Additional Information</SectionTitle>
      <DescriptionList
        rows={[
          ["Share class", <Pending resource={stockClass} what="the share class" inline>{(data) => <Link to={href(`share-classes/${plan.stockClassId}`)}>{data.name}</Link>}</Pending>],
          ["Term", termLabel(plan)],
          ["Board approval", formatDate(plan.boardApprovalDate)],
          ["Stockholder approval", formatDate(plan.stockholderApprovalDate)],
          ["Repurchase period", plan.defaultRepurchaseWindow ? `${periodLabel(plan.defaultRepurchaseWindow)} after termination` : DASH],
        ]}
      />
      <SectionTitle>Post-Termination Exercise</SectionTitle>
      <DescriptionList rows={WINDOW_ORDER.map((reason) => [TERMINATION_WINDOW_LABELS[reason], periodLabel(windows.get(reason))] as const)} />
      <SectionTitle>Return-to-pool rules</SectionTitle>
      <DescriptionList rows={RULES.map(([key, label]) => [label, <Badge tone={plan.returnRules[key] === "RETURN" ? "teal" : "grey"}>{plan.returnRules[key] === "RETURN" ? "Return" : "Retire"}</Badge>] as const)} />
      <p className="small muted">Confirmed against the plan document by {confirmation.confirmedBy} on {formatDate(format.localDate(confirmation.confirmedAt))}, effective {formatDate(confirmation.effectiveDate)}.</p>
      <SectionTitle>Shares and Options Issued</SectionTitle>
      <Pending resource={securities} what="the shares and options issued">
        {() => (
          <DataTable
            id="plan-securities"
            label="Shares and options issued"
            rows={issued ?? []}
            rowKey={(security) => security.id}
            defaultSort={["fd", "desc"]}
            search={(security) => `${security.displayId} ${security.stakeholderName}`}
            empty="Nothing has been issued from this plan."
            columns={[
              { key: "id", label: "Security", render: (security) => <SecurityLink id={security.id} family={security.family} displayId={security.displayId} />, compare: byDisplayId((security) => security.displayId) },
              { key: "holder", label: "Issued to", render: (security) => <HolderLink id={security.stakeholderId} name={security.stakeholderName} />, compare: byText((security) => security.stakeholderName) },
              {
                key: "status", label: "Status",
                render: (security) => <><Badge tone={SECURITY_STATUS_TONES[security.status]}>{SECURITY_STATUS_LABELS[security.status]}</Badge>{isExecutionPending(security.executionStatus) && isPositive(security.numbers?.outstanding) ? <> <Badge tone="amber">Execution pending</Badge></> : null}</>,
              },
              { key: "fd", label: "Fully diluted shares", numeric: true, render: (security) => format.shares(security.numbers?.fullyDiluted ?? null), compare: byDecimal((security) => security.numbers?.fullyDiluted) },
            ]}
          />
        )}
      </Pending>
      <SectionTitle>Amendments</SectionTitle>
      {plan.amendments.length ? (
        <div className="tbl-scroll">
          <table className="tbl" aria-label="Plan amendments">
            <thead><tr><th scope="col">#</th><th scope="col" className="num">Plan size after</th><th scope="col">Effective</th></tr></thead>
            <tbody>
              {plan.amendments.map((amendment, index) => (
                <tr key={amendment.transactionId}><td>{index + 1}</td><td className="num">{amendment.poolSize ? format.shares(amendment.poolSize) : DASH}</td><td>{formatDate(amendment.effectiveDate)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No amendments.</p>
      )}
      <SectionTitle>Documents</SectionTitle>
      <LinkedDocuments targetType="stock_plan" targetId={plan.id} />
      <SectionTitle>Activity</SectionTitle>
      <RecordActivity targetId={plan.id} />
    </Card>
  );
}
