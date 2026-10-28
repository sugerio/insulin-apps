import { useState } from "react";
import { Link } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { WriteButton } from "../components/Actions.tsx";
import { CapTableDownloadButton } from "../components/CapTableDownload.tsx";
import { DonutChart, Meter } from "../components/Charts.tsx";
import { DataTable, byDecimal, byRatio, byText } from "../components/DataTable.tsx";
import { Banner, InlineError, ResourceView } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { HolderLink } from "../components/Links.tsx";
import { useWorkspace, type Workspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, SeeMore } from "../components/Page.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { useToast } from "../components/Toast.tsx";
import { compareDecimals, formatFractionPercent, fractionOf, parseRatio, sumDecimals } from "../lib/decimal.ts";
import { describeError } from "../lib/errors.ts";
import { daysBetween, formatDate, formatDaysLeft, plural } from "../lib/format.ts";
import { CATEGORY_COLORS, OWNERSHIP_CATEGORIES, ownershipCategory, type OwnershipCategory } from "../lib/labels.ts";
import { useResource, type Resource } from "../lib/useResource.ts";
import { currentValuation, openMaterialEvents } from "../lib/valuations.ts";

// Dashboard: left column with the company card, employee equity and ownership; right rail with
// Needs attention, in-progress securities, in-app reminders and recent activity. Computed live as of today. The one
// write is "Process due items": there is no scheduler, so scheduled terminations and expirations that have fallen due
// are recorded when an admin opens the app or asks here.

type NeedsKind = api.NeedsAttention["kind"];
type Tone = "ok" | "warn" | "bad" | "info";

interface AttentionLine {
  kind: NeedsKind;
  label: string;
  text: string;
  tone: Tone;
  to: string;
  count: number | null;
}

/** Where each line links when the server sends an org-relative path or none. */
const DEFAULT_HREFS: Record<NeedsKind, string> = {
  EXECUTION_PENDING: "securities-status#exec",
  SCHEDULED_TERMINATION: "securities-status#sched",
  ISO_DEADLINE_SOON: "securities-status#term",
  REPURCHASE_WINDOW_CLOSING: "securities-status#rep",
  VALUATION_STATUS: "compliance/409a",
  EXPIRY_RUN_TO_CONFIRM: api.EXPIRY_RUNS_HREF,
};

/** The lines always shown; an expiry run to confirm follows when the server reports one. */
const ALWAYS: readonly NeedsKind[] = ["EXECUTION_PENDING", "SCHEDULED_TERMINATION", "ISO_DEADLINE_SOON", "REPURCHASE_WINDOW_CLOSING", "VALUATION_STATUS"];
const OPTIONAL: readonly NeedsKind[] = ["EXPIRY_RUN_TO_CONFIRM"];

function resolveHref(workspace: Workspace, href: string | undefined, kind: NeedsKind): string {
  if (href?.startsWith("/companies/")) return href;
  return workspace.href(href && href !== "/" ? href : DEFAULT_HREFS[kind]);
}

interface ValuationLine {
  text: string;
  tone: Tone;
  reminder: { tone: "warn" | "bad"; title: string; body: string } | null;
  /** The valuations are still loading, or failed: the line says so rather than guessing a status. */
  state: "loading" | "failed" | "ready";
  error?: unknown;
}

/** The 409A line and reminder from the valuation in effect today. */
function valuationLine(valuations: Resource<api.ValuationList>, today: string): ValuationLine {
  if (!valuations.data) {
    return valuations.error !== undefined
      ? { text: "Couldn't load the 409A status — open Compliance & Tax", tone: "warn", reminder: null, state: "failed", error: valuations.error }
      : { text: "Checking the 409A status…", tone: "info", reminder: null, state: "loading" };
  }
  const all = valuations.data.items;
  const current = currentValuation(all, today);
  if (!current) return { text: "No 409A valuation recorded", tone: "bad", reminder: null, state: "ready" };
  if (current.status === "review_required") {
    const event = openMaterialEvents(current, all, today)[0];
    return {
      text: `${current.name}: review required (material event flagged)`,
      tone: "bad",
      state: "ready",
      reminder: {
        tone: "bad",
        title: `409A review required — material event on ${formatDate(event?.eventDate)}`,
        body: `${event ? `${event.description}. ` : ""}New grants are blocked until a new valuation (or written confirmation) is recorded.`,
      },
    };
  }
  if (current.status === "expired") {
    return {
      text: `409A expired on ${formatDate(current.expirationDate)}`,
      tone: "bad",
      state: "ready",
      reminder: { tone: "bad", title: `409A expired on ${formatDate(current.expirationDate)}`, body: "New grants are blocked until the new provider's report is recorded." },
    };
  }
  const until = current.presumptivelyValidUntil ?? current.expirationDate;
  const days = until ? daysBetween(today, until) : null;
  return {
    text: until ? `Presumptively valid until ${formatDate(until)} (${formatDaysLeft(today, until)})` : "Presumptively valid",
    tone: current.status === "expiring_soon" ? "warn" : "ok",
    state: "ready",
    reminder: until && days !== null && days <= 60
      ? { tone: "warn", title: `409A expires in ${days} days (${formatDate(until)}) — record the new provider's report`, body: "New grants after that date need a new valuation." }
      : null,
  };
}

function attentionLines(workspace: Workspace, dashboard: api.DashboardResponse, valuation: ValuationLine): AttentionLine[] {
  const byKind = new Map(dashboard.needsAttention.map((item) => [item.kind, item]));
  const kinds = [...ALWAYS, ...OPTIONAL.filter((kind) => byKind.has(kind))];
  return kinds.map((kind): AttentionLine => {
    const item = byKind.get(kind);
    // A line the server didn't report is unknown, not zero: say so instead of showing a count.
    if (!item && kind !== "VALUATION_STATUS") {
      return { kind, to: resolveHref(workspace, undefined, kind), count: null, label: ATTENTION_LABELS[kind], text: "Not reported", tone: "info" };
    }
    const count = item?.count ?? 0;
    const due = item?.dueDate ? formatDate(item.dueDate) : null;
    const to = resolveHref(workspace, item?.href, kind);
    switch (kind) {
      case "EXECUTION_PENDING":
        return { kind, to, count, label: "Execution pending (migrated)", text: `${plural(count, "grant")} awaiting signatures`, tone: count ? "warn" : "ok" };
      case "SCHEDULED_TERMINATION":
        return { kind, to, count, label: "Scheduled terminations", text: count ? `${plural(count, "termination")} scheduled${due ? ` · next ${due}` : ""}` : "None", tone: count ? "info" : "ok" };
      case "ISO_DEADLINE_SOON":
        return { kind, to, count: null, label: "ISO deadlines within 30 days", text: count ? `${plural(count, "ISO deadline")}${due ? ` · first ${due}` : ""}` : "None", tone: count ? "bad" : "ok" };
      case "REPURCHASE_WINDOW_CLOSING":
        return { kind, to, count, label: "Repurchase windows open", text: count ? `${plural(count, "window")}${due ? `, closes ${due}` : ""} — follow the offline repurchase procedure` : "None", tone: count ? "warn" : "ok" };
      case "VALUATION_STATUS":
        return { kind, to, count: null, label: "409A", text: valuation.text, tone: valuation.tone };
      case "EXPIRY_RUN_TO_CONFIRM":
        // Present only while a report-only run awaits confirmation; the count is those runs, and the link
        // (EXPIRY_RUNS_HREF) leads every admin to them.
        return { kind, to, count, label: "Expiry run to confirm", text: `${plural(count, "expiry run")} waiting for an admin${due ? ` · ${due}` : ""}`, tone: count ? "warn" : "ok" };
    }
  });
}

const ATTENTION_LABELS: Record<NeedsKind, string> = {
  EXECUTION_PENDING: "Execution pending (migrated)",
  SCHEDULED_TERMINATION: "Scheduled terminations",
  ISO_DEADLINE_SOON: "ISO deadlines within 30 days",
  REPURCHASE_WINDOW_CLOSING: "Repurchase windows open",
  VALUATION_STATUS: "409A",
  EXPIRY_RUN_TO_CONFIRM: "Expiry run to confirm",
};

const IN_PROGRESS = [
  ["executionPending", "Execution pending (migrated)", "securities-status#exec"],
  ["unvestedSharesFromTerminated", "Unvested shares — repurchase window", "securities-status#rep"],
  ["optionsFromTerminated", "Options from terminated holders — open windows", "securities-status#term"],
  ["scheduledTerminations", "Scheduled terminations", "securities-status#sched"],
] as const;

export function DashboardPage() {
  const workspace = useWorkspace();
  const { orgId, today } = workspace;
  const dashboard = useResource((signal) => apiRequest(api.routes.getDashboard, { params: { orgId }, signal }), [orgId]);
  const valuations = useResource((signal) => apiRequest(api.routes.listValuations, { params: { orgId }, signal }), [orgId]);
  return (
    <Page title="Dashboard">
      <h1 className="sr-only">Dashboard</h1>
      {workspace.canWrite && workspace.org.ledgerSeq === 0 ? <ImportInvite to={workspace.href("import")} /> : null}
      <ResourceView resource={dashboard}>
        {(data) => <DashboardBody data={data} valuation={valuationLine(valuations, today)} retryValuations={valuations.reload} onProcessed={dashboard.reload} />}
      </ResourceView>
    </Page>
  );
}

/**
 * A company set up empty can't get share classes, equity plans or shares from the app's forms: its cap table comes in
 * through the import, which owners and admins are offered here until the ledger records anything.
 */
function ImportInvite({ to }: { to: string }) {
  return (
    <Banner kind="info" title="Nothing is recorded in this cap table yet" action={<Link className="btn btn-primary btn-sm" to={to}>Import the cap table</Link>}>
      Moving from Pulley or a spreadsheet? Import the company's stakeholders, share classes, equity plans and holdings in one step.
    </Banner>
  );
}

/** What processing due items did, in words. */
export function processedMessage(result: api.RouteResult<typeof api.routes.processDue>): string {
  const done = [
    result.appliedTerminations ? plural(result.appliedTerminations, "scheduled termination") + " recorded" : null,
    result.expiredSecurities ? plural(result.expiredSecurities, "security", "securities") + " expired" : null,
    result.proposedExpirations ? plural(result.proposedExpirations, "expiry", "expiries") + " waiting for review" : null,
    result.remainingExpirations ? plural(result.remainingExpirations, "automatic expiry", "automatic expiries") + " left for the next load" : null,
  ].filter((item): item is string => item !== null);
  const failed = result.failures ? ` ${plural(result.failures, "item")} couldn't be processed; try again later.` : "";
  return `${done.length ? `Due items processed: ${done.join(", ")}.` : "Nothing was due."}${failed}`;
}

/** Records what has fallen due (scheduled terminations, expirations) now, instead of at the next admin visit. */
function ProcessDueButton({ onDone }: { onDone: () => void }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const result = await apiRequest(api.routes.processDue, { params: { orgId } });
      toast({ message: processedMessage(result) });
      onDone();
    } catch (error) {
      toast({ tone: "warn", message: `Nothing was processed. ${describeError(error, { not_found: "Processing due items isn't available." })}` });
    } finally {
      setBusy(false);
    }
  };
  return <WriteButton label={busy ? "Processing…" : "Process due items"} size="sm" icon="refresh" disabledReason={busy ? "Processing due items" : undefined} onClick={() => void run()} />;
}

function DashboardBody({ data, valuation, retryValuations, onProcessed }: { data: api.DashboardResponse; valuation: ValuationLine; retryValuations: () => void; onProcessed: () => void }) {
  const workspace = useWorkspace();
  const { format, href } = workspace;
  const fd = data.company.fullyDilutedShares;
  const lines = attentionLines(workspace, data, valuation);
  const repurchase = data.needsAttention.find((item) => item.kind === "REPURCHASE_WINDOW_CLOSING");
  const reminders = [
    valuation.reminder ? { ...valuation.reminder, key: "409a", to: href("compliance/409a") } : null,
    repurchase && repurchase.count > 0
      ? {
          key: "rep",
          tone: "warn" as const,
          title: `${plural(repurchase.count, "repurchase window")} closing${repurchase.dueDate ? ` ${formatDate(repurchase.dueDate)}` : ""} — follow the offline repurchase procedure`,
          body: "Unvested shares from terminated holders.",
          to: href("securities-status#rep"),
        }
      : null,
  ].filter((item) => item !== null);

  const categories = new Map<OwnershipCategory, string>();
  for (const item of data.ownershipByRelationship) {
    const category = ownershipCategory(item.relationship);
    categories.set(category, sumDecimals([categories.get(category), item.fullyDiluted]));
  }
  const segments = OWNERSHIP_CATEGORIES.filter((category) => compareDecimals(categories.get(category), "0") > 0).map((category) => ({
    label: category,
    value: categories.get(category)!,
    color: CATEGORY_COLORS[category],
    hatched: category === "Available",
  }));

  return (
    <div className="grid-dash">
      <div className="stack">
        <Card>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="spacer co-card">
              <h2>{workspace.legalName}</h2>
              <div className="co-metrics">
                <div><b>{format.money(data.company.totalCapitalContribution)}</b> Total capital contribution</div>
                <div><b>{format.shares(fd)}</b> Fully diluted shares</div>
                <div><b>{data.company.stakeholdersWithSecurities.toLocaleString("en-US")}</b> Stakeholders with securities</div>
              </div>
            </div>
            <CapTableDownloadButton />
          </div>
        </Card>
        <Card title="Employee Equity" right={<SeeMore to={href("equity-plans")} />}>
          <div className="legend-inline">
            <span><i className="sw" style={{ background: "var(--primary-button)" }} />Granted</span>
            <span><i className="sw" style={{ background: "var(--primary-soft)", border: "1px solid var(--border)" }} />Available</span>
          </div>
          {data.employeeEquity.length === 0 ? <p className="muted small">No equity plans yet.</p> : null}
          {data.employeeEquity.map((plan) => {
            const used = parseRatio(plan.usedPct);
            const available = { num: used.den - used.num, den: used.den };
            const size = sumDecimals([plan.granted, plan.available]);
            return (
              <div className="pool-row" key={plan.stockPlanId}>
                <div className="pr-h">
                  <Link to={href(`equity-plans/${plan.stockPlanId}`)}>{plan.name}</Link>
                  <span className="spacer" />
                  <span className="muted">
                    {format.shares(plan.granted)} granted ({formatFractionPercent(used)}) · {format.shares(plan.available)} available ({formatFractionPercent(available)})
                  </span>
                </div>
                <Meter used={plan.granted} size={size} label={`${plan.name} used`} />
                {used.num * 10n > used.den * 9n ? (
                  <div className="small mt-4" style={{ color: "var(--warning-text)" }}>More than 90% of the plan is used. A grant above the available count is blocked.</div>
                ) : null}
              </div>
            );
          })}
          {workspace.canWrite ? (
            <div className="hint-box">
              <Link to={href("issue/options")}>Record a new option grant</Link> from a signed agreement and board consent.
            </div>
          ) : null}
        </Card>
        <Card title="Ownership" right={<SeeMore to={href("captable")} />}>
          {segments.length ? (
            <div className="own-wrap">
              <DonutChart segments={segments} center={format.compact(fd)} label="Ownership by category" />
              <ul className="legend" aria-label="Ownership by category">
                {segments.map((segment) => (
                  <li className="lg" key={segment.label}>
                    <i className="sw" aria-hidden="true" style={{ background: segment.hatched ? "repeating-linear-gradient(135deg,var(--s-pool) 0 3px,var(--hatch) 3px 5px)" : segment.color }} />
                    <span>{segment.label}</span>
                    <span className="v">{formatFractionPercent(fractionOf(segment.value, fd))}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted small">Nothing is issued yet.</p>
          )}
          <h3 className="section-title mt-24">Top Stakeholders</h3>
          <DataTable
            id="dash-top"
            label="Top stakeholders"
            rows={data.topStakeholders}
            rowKey={(row) => row.stakeholderId}
            toolbar={false}
            paginate={false}
            defaultSort={["fd", "desc"]}
            empty="No stakeholders hold securities yet."
            columns={[
              { key: "name", label: "Stakeholder", render: (row) => <HolderLink id={row.stakeholderId} name={row.name} />, compare: byText((row) => row.name) },
              { key: "fd", label: "Fully diluted", numeric: true, render: (row) => format.shares(row.fullyDiluted), compare: byDecimal((row) => row.fullyDiluted) },
              { key: "pct", label: "Ownership", numeric: true, render: (row) => format.percent(row.pct), compare: byRatio((row) => row.pct) },
            ]}
          />
        </Card>
      </div>
      <div className="stack">
        <Card title={<><Icon name="clipboard" /> Needs attention</>} right={<ProcessDueButton onDone={onProcessed} />}>
          <ul className="na-list" aria-label="Needs attention">
            {lines.map((line) => (
              <li key={line.kind}>
                <Link className={`na ${line.tone}`} to={line.to}>
                  <span className="na-ic"><Icon name={line.tone === "ok" ? "check" : line.tone === "info" ? "info" : "alert"} /></span>
                  <span className="na-b">
                    <span className="na-l">{line.label}</span>
                    <span className="na-t">{line.text}</span>
                  </span>
                  {line.count !== null ? <span className={line.count ? "cnt" : "cnt zero"}>{line.count}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="In-progress securities">
          <ul className="list-links">
            {IN_PROGRESS.map(([key, label, to]) => {
              // A queue the server didn't report is unknown: no count rather than a zero.
              const count = data.inProgress[key];
              return (
                <li key={key}>
                  <Link to={href(to)}>{label}{count === undefined ? <span className="cnt zero" title="Not reported">—</span> : <span className={count ? "cnt" : "cnt zero"}>{count}</span>}</Link>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title="Reminders" right={<span className="small muted">in-app only</span>}>
          {reminders.map((reminder) => (
            <div className={`reminder ${reminder.tone}`} key={reminder.key}>
              <Link className="r-t" to={reminder.to}>{reminder.title}</Link>
              <div className="r-b">{reminder.body}</div>
            </div>
          ))}
          {/* "No reminders" only once every source is known: a 409A reminder may still be on its way. */}
          {valuation.state === "failed" ? <InlineError what="the 409A status" error={valuation.error} onRetry={retryValuations} /> : null}
          {valuation.state === "loading" ? (
            <p className="muted small" role="status">Checking reminders…</p>
          ) : reminders.length === 0 && valuation.state === "ready" ? (
            <p className="muted">No reminders.</p>
          ) : null}
        </Card>
        <Card title="Recent activity" right={<SeeMore to={href("activity")} />}>
          <Timeline
            label="Recent activity"
            items={data.recentActivity.slice(0, 8).map((event) => ({
              key: String(event.id),
              title: event.description,
              meta: `${event.actor} · ${format.relative(event.occurredAt)}`,
            }))}
          />
        </Card>
      </div>
    </div>
  );
}
