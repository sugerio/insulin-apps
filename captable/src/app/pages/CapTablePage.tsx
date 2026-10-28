import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { ActionsMenu } from "../components/Actions.tsx";
import { CapTableDownloadButton } from "../components/CapTableDownload.tsx";
import { DataTable, byDecimal, byDisplayId, byRatio, byText, type Column, type Filter } from "../components/DataTable.tsx";
import { Badge, Banner, ResourceView } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { LinkTabs } from "../components/LinkTabs.tsx";
import { HolderLink, SecurityLink, holderState, type HolderState } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { usePii } from "../components/Pii.tsx";
import { Tiles, type Tile } from "../components/Tiles.tsx";
import { BulkCancelDialog } from "../components/flows/BulkCancelDialog.tsx";
import { formatFractionPercent, fractionOf, isPositive, multiplyDecimals, sumDecimals } from "../lib/decimal.ts";
import { DASH, formatDate, sharesOrDash } from "../lib/format.ts";
import {
  EXECUTION_LABELS,
  FEDERAL_EXEMPTION_LABELS,
  RELATIONSHIP_LABELS,
  SECURITY_STATUS_LABELS,
  SECURITY_STATUS_TONES,
  isExecutionPending,
  optionType,
} from "../lib/labels.ts";
import * as terms from "../lib/terms.ts";
import { allOf, useResource } from "../lib/useResource.ts";

// Cap Table: Ownership, then one tab per instrument present, with counts; summary tiles, the
// toolbar, the table and a 50-row pager. Every number is recomputed for the As-of date by the server's replay;
// the Ownership tab pins "Available pool" and "Totals" at the bottom.

type Tab = "ownership" | "shares" | "options" | "safes" | "warrants";
const TABS: readonly Tab[] = ["ownership", "shares", "options", "safes", "warrants"];
const FAMILY_OF: Record<Exclude<Tab, "ownership">, api.SecurityFamily> = {
  shares: "STOCK",
  options: "EQUITY_COMPENSATION",
  safes: "CONVERTIBLE",
  warrants: "WARRANT",
};
const TAB_LABELS: Record<Tab, string> = { ownership: "Ownership", shares: "Shares", options: "Options", safes: "SAFEs", warrants: "Warrants" };
const REL_OPTIONS = (Object.keys(RELATIONSHIP_LABELS) as api.Relationship[]).map((key) => [key, RELATIONSHIP_LABELS[key]] as const);
const STATUS_OPTIONS = [["active", "Active"], ["terminating", "Terminating"], ["terminated", "Terminated"]] as const;
type OwnershipRow = NonNullable<api.CapTableResponse["ownership"]>[number];
type SafeRow = NonNullable<api.CapTableResponse["safes"]>[number];

interface Context {
  capTable: api.CapTableResponse;
  securities: readonly api.Security[];
  stakeholders: ReadonlyMap<string, api.Stakeholder>;
  asOf: string;
}

function parseTab(value: string | null): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : "ownership";
}

export function CapTablePage() {
  const workspace = useWorkspace();
  const { orgId, today, href } = workspace;
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"));
  const requested = params.get("asOf");
  const asOf = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : today;
  const capTable = useResource((signal) => apiRequest(api.routes.getCapTable, { params: { orgId }, query: { asOf, tab }, signal }), [orgId, asOf, tab]);
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, query: { asOf }, signal }), [orgId, asOf]);
  const stakeholders = useResource((signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, query: { asOf }, signal }), [orgId, asOf]);

  const linkFor = (nextTab: Tab, nextAsOf: string | null) => {
    const search = new URLSearchParams();
    if (nextTab !== "ownership") search.set("tab", nextTab);
    if (nextAsOf && nextAsOf !== today) search.set("asOf", nextAsOf);
    const text = search.toString();
    return `${href("captable")}${text ? `?${text}` : ""}`;
  };
  const counts = securities.data ? countByTab(securities.data.items, asOf) : null;
  const tabs = TABS.filter((id) => id === "ownership" || id === tab || !counts || counts[id] > 0).map((id) => ({
    id,
    label: id === "ownership" || !counts ? TAB_LABELS[id] : `${TAB_LABELS[id]} (${counts[id]})`,
    to: linkFor(id, asOf),
  }));
  const [bulkCancel, setBulkCancel] = useState<"option" | "warrant" | null>(null);
  const addOptions = { label: "Add options", icon: "plus" as const, to: href("issue/options") };
  const actions = {
    ownership: [addOptions],
    options: [addOptions, { label: "Cancel options", icon: "x" as const, onSelect: () => setBulkCancel("option") }],
    warrants: [{ label: "Cancel warrants", icon: "x" as const, onSelect: () => setBulkCancel("warrant") }],
    shares: [],
    safes: [],
  }[tab];

  const setAsOf = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    const next = new URLSearchParams(params);
    if (value >= today) next.delete("asOf");
    else next.set("asOf", value);
    setParams(next);
  };

  return (
    <Page title="Cap Table" crumbs={[["Cap Table"]]}>
      <Card>
        <PageHead
          title="Cap Table"
          actions={
            <>
              <label className="asof" title="Recompute every number as of this date">
                As of
                <input type="date" className="inp" value={asOf} max={today} aria-label="Cap table as-of date" onChange={(event) => setAsOf(event.target.value)} />
              </label>
              {asOf !== today ? <Link className="small" to={linkFor(tab, null)}>Today</Link> : null}
              <CapTableDownloadButton asOf={asOf} />
              <ActionsMenu items={actions} />
            </>
          }
        />
        <LinkTabs tabs={tabs} selected={tab} label="Cap table views" />
        {asOf !== today ? (
          <Banner kind="info" title={`Showing the cap table as of ${formatDate(asOf)}`}>
            Every number below is recomputed from the effective-dated ledger for that date. <Link to={linkFor(tab, null)}>Back to today</Link>
          </Banner>
        ) : null}
        {/* The tab needs all three answers: its columns, tiles and badges combine them. A lookup that is still loading or
            failed must never read as zero (vested, pending, capital, SAFE totals) or as a missing badge. */}
        <ResourceView resource={allOf(capTable, securities, stakeholders)}>
          {([data, securityList, stakeholderList]) => {
            const context: Context = {
              capTable: data,
              securities: securityList.items,
              stakeholders: new Map(stakeholderList.items.map((item) => [item.id, item])),
              asOf,
            };
            return <TabBody tab={tab} context={context} />;
          }}
        </ResourceView>
      </Card>
      {bulkCancel ? (
        <BulkCancelDialog
          kind={bulkCancel}
          onClose={() => setBulkCancel(null)}
          onDone={() => {
            setBulkCancel(null);
            capTable.reload();
            securities.reload();
            stakeholders.reload();
          }}
        />
      ) : null}
    </Page>
  );
}

function countByTab(securities: readonly api.Security[], asOf: string): Record<Exclude<Tab, "ownership">, number> {
  const counts = { shares: 0, options: 0, safes: 0, warrants: 0 };
  for (const security of securities) {
    if (security.issueDate > asOf) continue;
    if (security.family === "STOCK") counts.shares += 1;
    else if (security.family === "EQUITY_COMPENSATION") counts.options += 1;
    else if (security.family === "CONVERTIBLE") counts.safes += 1;
    else counts.warrants += 1;
  }
  return counts;
}

function TabBody({ tab, context }: { tab: Tab; context: Context }) {
  const latestOpening = context.capTable.openingBalances.filter((item) => item.date > context.asOf).map((item) => item.date).sort().at(-1);
  return (
    <>
      {latestOpening ? (
        <Banner kind="info" title="Opening balance">
          History before {formatDate(latestOpening)} came in with the import as opening balances: those securities start from their balance on that date.
        </Banner>
      ) : null}
      {tab === "ownership" ? <OwnershipTab context={context} /> : tab === "safes" ? <SafesTab context={context} /> : <InstrumentTab tab={tab} context={context} />}
    </>
  );
}

function classTiles(capTable: api.CapTableResponse, format: ReturnType<typeof useWorkspace>["format"]): Tile[] {
  return capTable.classes.map((item) => ({ label: `${item.name} issued`, value: format.shares(item.issuedAndOutstanding) }));
}

function safeTile(securities: readonly api.Security[], format: ReturnType<typeof useWorkspace>["format"]): Tile {
  const safes = securities.filter((security) => security.family === "CONVERTIBLE");
  const outstanding = sumDecimals(safes.filter((security) => security.status === "OUTSTANDING").map((security) => terms.safeTerms(security.terms).principal));
  const converted = safes.filter((security) => security.status === "CONVERTED").length;
  return { label: "SAFEs", value: isPositive(outstanding) ? format.money(outstanding, 0) : "None outstanding", sub: `${converted} converted` };
}

function holderOf(context: Context, stakeholderId: string): { name: string | null; state: HolderState } {
  const stakeholder = context.stakeholders.get(stakeholderId);
  return { name: stakeholder?.displayName ?? null, state: holderState(stakeholder) };
}

// ---------------------------------------------------------------------------
// Ownership

function OwnershipTab({ context }: { context: Context }) {
  const workspace = useWorkspace();
  const { format } = workspace;
  const pii = usePii();
  const { capTable } = context;
  const rows = capTable.ownership ?? [];
  const options = context.securities.filter((security) => security.family === "EQUITY_COMPENSATION" && security.status === "OUTSTANDING");
  const optionSums = (stakeholderId: string, pick: (numbers: api.SecurityNumbers, security: api.Security) => string | null) =>
    sumDecimals(options.filter((security) => security.stakeholderId === stakeholderId && security.numbers).map((security) => pick(security.numbers!, security)));
  const emailOf = (row: OwnershipRow) => context.stakeholders.get(row.stakeholderId)?.emails.find((email) => email.removedAt === null)?.email ?? null;
  const totalsFor = (row: OwnershipRow) => context.stakeholders.get(row.stakeholderId)?.totals;

  const numberColumn = (key: string, label: string, get: (row: OwnershipRow) => string, extra: Partial<Column<OwnershipRow>> = {}): Column<OwnershipRow> => ({
    key, label, numeric: true, render: (row) => sharesOrDash(format, get(row)), compare: byDecimal(get), ...extra,
  });
  const vested = (row: OwnershipRow) => optionSums(row.stakeholderId, (numbers) => numbers.vestedOutstanding);
  const unvested = (row: OwnershipRow) => optionSums(row.stakeholderId, (numbers) => numbers.unvested);
  const pending = (row: OwnershipRow) => optionSums(row.stakeholderId, (numbers, security) => (isExecutionPending(security.executionStatus) ? numbers.outstanding : "0"));
  // Capital comes from the stakeholder's totals; a row whose totals didn't come back shows "—", not $0.
  const capital = (row: OwnershipRow) => totalsFor(row)?.capitalContribution ?? null;

  const columns: Column<OwnershipRow>[] = [
    { key: "ext", label: "External ID", render: (row) => row.issuerAssignedId ?? DASH, compare: byText((row) => row.issuerAssignedId) },
    {
      key: "name", label: "Stakeholder", locked: true, sticky: true, minWidth: 230,
      render: (row) => <HolderLink id={row.stakeholderId} name={row.name} state={{ status: row.status, date: holderState(context.stakeholders.get(row.stakeholderId)).date }} />,
      compare: byText((row) => row.name),
    },
    { key: "rel", label: "Stakeholder type", render: (row) => RELATIONSHIP_LABELS[row.relationship], compare: byText((row) => RELATIONSHIP_LABELS[row.relationship]) },
    { key: "email", label: "E-mail", defaultHidden: true, render: (row) => pii.email(emailOf(row)) },
    { key: "kind", label: "Individual / Institution", defaultHidden: true, render: (row) => kindLabel(context.stakeholders.get(row.stakeholderId)?.kind) },
    ...capTable.classes.map((item) => numberColumn(`c_${item.stockClassId}`, item.name, (row) => row.byClass[item.stockClassId] ?? "0")),
    numberColumn("issued", "Issued and outstanding", (row) => row.issuedAndOutstanding),
    { key: "issuedPct", label: "Issued and outstanding %", numeric: true, render: (row) => (isPositive(row.issuedAndOutstanding) ? format.percent(row.issuedAndOutstandingPct) : DASH), compare: byRatio((row) => row.issuedAndOutstandingPct) },
    ...capTable.plans.map((plan) => numberColumn(`p_${plan.stockPlanId}`, plan.name, (row) => row.planAwards[plan.stockPlanId] ?? "0")),
    numberColumn("noplan", "Awards outside a plan", (row) => row.awardsOutsidePlans),
    numberColumn("war", "Warrants", (row) => row.warrants),
    { key: "fd", label: "Fully diluted", numeric: true, render: (row) => format.shares(row.fullyDiluted), compare: byDecimal((row) => row.fullyDiluted) },
    { key: "fdPct", label: "Fully diluted %", numeric: true, render: (row) => format.percent(row.fullyDilutedPct), compare: byRatio((row) => row.fullyDilutedPct) },
    { key: "capital", label: "Capital contributed", numeric: true, defaultHidden: true, render: (row) => { const value = capital(row); return value === null ? DASH : isPositive(value) ? format.money(value) : DASH; }, compare: byDecimal(capital) },
    numberColumn("vested", "Vested options", vested, { defaultHidden: true }),
    numberColumn("unvested", "Unvested options", unvested, { defaultHidden: true }),
    numberColumn("pending", "Execution pending", pending, { defaultHidden: true }),
  ];

  const filters: Filter<OwnershipRow>[] = [
    { key: "rel", label: "Relationship", type: "multi", options: REL_OPTIONS, test: (row, values) => values.includes(row.relationship) },
    { key: "kind", label: "Individual / Institution", options: [["individual", "Individual"], ["institution", "Institution"]], test: (row, value) => context.stakeholders.get(row.stakeholderId)?.kind === value },
    { key: "status", label: "Status", options: STATUS_OPTIONS, test: (row, value) => row.status === value },
    { key: "plan", label: "Plan", options: capTable.plans.map((plan) => [plan.stockPlanId, plan.name] as const), test: (row, value) => isPositive(row.planAwards[value]) },
    { key: "cls", label: "Holds class", options: capTable.classes.map((item) => [item.stockClassId, item.name] as const), test: (row, value) => isPositive(row.byClass[value]) },
  ];

  const sumOf = (list: readonly OwnershipRow[], key: string): string | null => {
    const column = columns.find((item) => item.key === key);
    if (!column) return null;
    if (key.startsWith("c_")) return sumDecimals(list.map((row) => row.byClass[key.slice(2)]));
    if (key.startsWith("p_")) return sumDecimals(list.map((row) => row.planAwards[key.slice(2)]));
    switch (key) {
      case "issued": return sumDecimals(list.map((row) => row.issuedAndOutstanding));
      case "noplan": return sumDecimals(list.map((row) => row.awardsOutsidePlans));
      case "war": return sumDecimals(list.map((row) => row.warrants));
      case "fd": return sumDecimals(list.map((row) => row.fullyDiluted));
      case "capital": return sumDecimals(list.map(capital));
      case "vested": return sumDecimals(list.map(vested));
      case "unvested": return sumDecimals(list.map(unvested));
      case "pending": return sumDecimals(list.map(pending));
      default: return null;
    }
  };

  const tiles: Tile[] = [
    ...classTiles(capTable, format),
    ...capTable.plans.map((plan) => ({
      label: `${plan.name} outstanding`,
      value: format.shares(sumDecimals(rows.map((row) => row.planAwards[plan.stockPlanId]))),
      sub: `${format.shares(plan.available)} available`,
    })),
    { label: "Warrants", value: format.shares(sumDecimals(rows.map((row) => row.warrants))) },
    safeTile(context.securities, format),
  ];

  return (
    <>
      <Tiles items={tiles} label="Cap table summary" />
      <DataTable
        id="cap-own"
        label="Ownership"
        rows={rows}
        rowKey={(row) => row.stakeholderId}
        columns={columns}
        defaultSort={["fd", "desc"]}
        pageSize={50}
        filters={filters}
        search={(row) => `${row.name} ${row.issuerAssignedId ?? ""} ${pii.canSeePii ? (emailOf(row) ?? "") : ""}`}
        searchPlaceholder="Search stakeholders…"
        empty="No stakeholders hold securities on this date."
        pinned={({ columns: visible, rows: shown, filtered }) => {
          const pool = filtered ? null : (
            <tr className="pool">
              {visible.map((column) => {
                let value: ReactNode = "";
                if (column.key === "name") value = "Available pool";
                else if (column.key.startsWith("p_")) value = format.shares(capTable.plans.find((plan) => plan.stockPlanId === column.key.slice(2))?.available ?? null);
                else if (column.key === "fd") value = format.shares(capTable.availablePool.fullyDiluted);
                else if (column.key === "fdPct") value = format.percent(capTable.availablePool.fullyDilutedPct);
                return <td key={column.key} className={[column.numeric ? "num" : "", column.sticky ? "sticky-col" : ""].join(" ").trim() || undefined}>{value}</td>;
              })}
            </tr>
          );
          const totals = (
            <tr className="totals">
              {visible.map((column) => {
                let value: ReactNode = "";
                if (column.key === "name") value = filtered ? `Totals (${shown.length} shown)` : "Totals";
                else if (column.key === "fd") value = format.shares(filtered ? sumOf(shown, "fd") : capTable.totals.fullyDiluted);
                else if (column.key === "issued") value = format.shares(filtered ? sumOf(shown, "issued") : capTable.totals.issuedAndOutstanding);
                else if (column.key === "fdPct") value = filtered ? formatFractionPercent(fractionOf(sumOf(shown, "fd"), capTable.totals.fullyDiluted)) : "100.00%";
                else if (column.key === "issuedPct") value = filtered ? formatFractionPercent(fractionOf(sumOf(shown, "issued"), capTable.totals.issuedAndOutstanding)) : "100.00%";
                else if (column.key === "capital") value = format.money(sumOf(shown, "capital"));
                else if (column.numeric) value = format.shares(sumOf(shown, column.key));
                return <td key={column.key} className={[column.numeric ? "num" : "", column.sticky ? "sticky-col" : ""].join(" ").trim() || undefined}>{value}</td>;
              })}
            </tr>
          );
          return <>{pool}{totals}</>;
        }}
      />
    </>
  );
}

function kindLabel(kind: api.Stakeholder["kind"] | undefined): string {
  return kind === "institution" ? "Institution" : kind === "individual" ? "Individual" : DASH;
}

// ---------------------------------------------------------------------------
// Shares, Options, Warrants

function InstrumentTab({ tab, context }: { tab: "shares" | "options" | "warrants"; context: Context }) {
  const workspace = useWorkspace();
  const { format } = workspace;
  const { capTable } = context;
  const family = FAMILY_OF[tab];
  const rows = (capTable.rows ?? []).filter((security) => security.family === family);
  const classNames = new Map(capTable.classes.map((item) => [item.stockClassId, item.name]));
  const planNames = new Map(capTable.plans.map((plan) => [plan.stockPlanId, plan.name]));
  const byId = new Map(context.securities.map((security) => [security.id, security]));
  const opening = new Set(capTable.openingBalances.map((item) => item.securityId));
  const number = (security: api.Security, key: keyof api.SecurityNumbers) => (security.numbers ? String(security.numbers[key]) : null);
  const status = (security: api.Security) => <Badge tone={SECURITY_STATUS_TONES[security.status]}>{SECURITY_STATUS_LABELS[security.status]}</Badge>;
  const pendingRow = (security: api.Security) => isExecutionPending(security.executionStatus) && isPositive(number(security, "outstanding"));

  const base: Column<api.Security>[] = [
    {
      key: "cert", label: "Certificate", locked: true, sticky: true,
      render: (security) => (
        <>
          <SecurityLink id={security.id} family={security.family} displayId={security.displayId} />
          {pendingRow(security) ? <> <Badge tone="amber">Execution pending</Badge></> : null}
          {opening.has(security.id) ? <span className="faint" title={`Opening balance: earlier history was not provable from ${api.importSourceName(workspace.org.importSource)}`}> <Icon name="info" /></span> : null}
        </>
      ),
      compare: byDisplayId((security) => security.displayId),
    },
    {
      key: "holder", label: "Stakeholder", minWidth: 200,
      render: (security) => <HolderLink id={security.stakeholderId} name={security.stakeholderName} state={holderOf(context, security.stakeholderId).state} />,
      compare: byText((security) => security.stakeholderName),
    },
    { key: "cls", label: "Share Class", render: (security) => (security.stockClassId ? classNames.get(security.stockClassId) ?? DASH : DASH), compare: byText((security) => (security.stockClassId ? classNames.get(security.stockClassId) : null)) },
    { key: "date", label: "Issued On", render: (security) => formatDate(security.issueDate), compare: byText((security) => security.issueDate) },
    { key: "fd", label: "Fully Diluted", numeric: true, render: (security) => sharesOrDash(format, number(security, "fullyDiluted")), compare: byDecimal((security) => number(security, "fullyDiluted")) },
    { key: "pct", label: "Ownership", numeric: true, render: (security) => (isPositive(number(security, "fullyDiluted")) ? format.percent(security.numbers?.fullyDilutedPct) : DASH), compare: byRatio((security) => security.numbers?.fullyDilutedPct) },
    { key: "price", label: "Price/Share", numeric: true, render: (security) => (tab === "shares" ? format.price(terms.sharePrice(security.terms)) : DASH), compare: byDecimal((security) => terms.sharePrice(security.terms)) },
    { key: "strike", label: "Exercise Price", numeric: true, render: (security) => (tab === "shares" ? DASH : format.price(terms.exercisePrice(security.terms))), compare: byDecimal((security) => terms.exercisePrice(security.terms)) },
  ];
  const quantity = (key: keyof api.SecurityNumbers, label: string): Column<api.Security> => ({
    key, label, numeric: true, defaultHidden: true, render: (security) => format.shares(number(security, key)), compare: byDecimal((security) => number(security, key)),
  });
  const statusColumn: Column<api.Security> = { key: "status", label: "Status", defaultHidden: true, render: status, compare: byText((security) => SECURITY_STATUS_LABELS[security.status]) };
  const expiration: Column<api.Security> = { key: "exp", label: "Expiration", defaultHidden: true, render: (security) => formatDate(terms.expirationDate(security.terms)), compare: byText((security) => terms.expirationDate(security.terms)) };

  let columns: Column<api.Security>[];
  let filters: Filter<api.Security>[];
  let tiles: Tile[];
  if (tab === "shares") {
    const capital = (security: api.Security) => terms.capitalContribution(security.terms) ?? (terms.sharePrice(security.terms) ? multiplyDecimals(terms.sharePrice(security.terms), number(security, "issued")) : null);
    columns = [
      ...base,
      quantity("issued", "Quantity"),
      { key: "capital", label: "Capital contribution", numeric: true, defaultHidden: true, render: (security) => format.money(capital(security)), compare: byDecimal(capital) },
      {
        key: "vest", label: "Vesting", defaultHidden: true,
        render: (security) => (terms.vestingTermsId(security.terms) ? (isPositive(number(security, "unvested")) ? `${format.shares(number(security, "unvested"))} unvested` : "Fully vested") : DASH),
      },
      statusColumn,
      { key: "board", label: "Board approval date", defaultHidden: true, render: (security) => boardApproval(security, workspace.org.importSource), compare: byText((security) => security.boardApprovalDate) },
      { key: "ex", label: "Exemption", defaultHidden: true, render: (security) => (security.exemption.federal ? FEDERAL_EXEMPTION_LABELS[security.exemption.federal] : DASH) },
      { key: "certst", label: "Certificate status", defaultHidden: true, render: (security) => certificateLabel(security) },
      { key: "src", label: "Source", defaultHidden: true, render: (security) => sourceLabel(security, byId) },
    ];
    filters = [
      { key: "cls", label: "Share class", options: capTable.classes.map((item) => [item.stockClassId, item.name] as const), test: (security, value) => security.stockClassId === value },
      { key: "status", label: "Status", options: (["OUTSTANDING", "REPURCHASED", "TRANSFERRED", "CONVERTED"] as const).map((value) => [value, SECURITY_STATUS_LABELS[value]] as const), test: (security, value) => security.status === value },
      { key: "date", label: "Issue date", type: "daterange", test: (security, range) => (!range.from || security.issueDate >= range.from) && (!range.to || security.issueDate <= range.to) },
      { key: "src", label: "Source", options: [["issued", "Issued"], ["EXERCISE", "Exercise"], ["CONVERSION", "Conversion"], ["TRANSFER", "Transfer"]], test: (security, value) => (value === "issued" ? security.parentSecurityId === null : terms.origin(security.terms) === value) },
    ];
    tiles = [...classTiles(capTable, format), { label: "Issued & outstanding", value: format.shares(capTable.metrics.issuedAndOutstanding) }];
  } else if (tab === "options") {
    const outstandingRows = rows.filter((security) => security.status === "OUTSTANDING");
    columns = [
      ...base,
      { key: "plan", label: "Plan", defaultHidden: true, render: (security) => (security.stockPlanId ? planNames.get(security.stockPlanId) ?? DASH : "Outside a plan") },
      { key: "type", label: "Type", defaultHidden: true, render: (security) => optionType(security.subtype) ?? DASH },
      quantity("issued", "Granted"),
      quantity("vested", "Vested"),
      quantity("unvested", "Unvested"),
      quantity("exercised", "Exercised"),
      quantity("cancelled", "Cancelled"),
      quantity("outstanding", "Outstanding"),
      expiration,
      statusColumn,
      { key: "exec", label: "Execution status", defaultHidden: true, render: (security) => EXECUTION_LABELS[security.executionStatus] },
      { key: "fed", label: "Federal exemption", defaultHidden: true, render: (security) => exemptionLabel(security) },
      { key: "dl", label: "Contractual deadline", defaultHidden: true, render: (security) => formatDate(security.deadlines?.contractual), compare: byText((security) => security.deadlines?.contractual) },
      { key: "isodl", label: "ISO deadline", defaultHidden: true, render: (security) => formatDate(security.deadlines?.iso), compare: byText((security) => security.deadlines?.iso) },
      { key: "early", label: "Early exercise allowed", defaultHidden: true, render: (security) => yesNo(terms.earlyExercisable(security.terms)) },
    ];
    filters = [
      { key: "plan", label: "Plan", options: capTable.plans.map((plan) => [plan.stockPlanId, plan.name] as const), test: (security, value) => security.stockPlanId === value },
      { key: "type", label: "Type", type: "multi", options: [["ISO", "ISO"], ["NSO", "NSO"]], test: (security, values) => values.includes(optionType(security.subtype) ?? "") },
      { key: "status", label: "Status", options: (["OUTSTANDING", "EXERCISED", "CANCELLED", "EXPIRED"] as const).map((value) => [value, SECURITY_STATUS_LABELS[value]] as const), test: (security, value) => security.status === value },
      { key: "exec", label: "Execution pending", options: [["yes", "Execution pending only"]], test: (security) => pendingRow(security) },
      { key: "term", label: "Terminated holders", options: [["yes", "Terminated holders only"]], test: (security) => holderOf(context, security.stakeholderId).state.status === "terminated" },
      { key: "nonus", label: "Non-US", options: [["yes", "Non-US grants only"]], test: (security) => security.exemption.federal === "NON_US" },
      { key: "early", label: "Early exercise allowed", options: [["yes", "Early exercise allowed"]], test: (security) => terms.earlyExercisable(security.terms) === true },
    ];
    tiles = [
      { label: "Options outstanding", value: format.shares(sumDecimals(outstandingRows.map((security) => number(security, "outstanding")))) },
      { label: "Vested & unexercised", value: format.shares(sumDecimals(rows.map((security) => number(security, "exercisable")))) },
      { label: "Unvested", value: format.shares(sumDecimals(rows.map((security) => number(security, "unvested")))) },
      { label: "Execution pending", value: String(rows.filter(pendingRow).length), sub: "grants (counted in FD)" },
      ...capTable.plans.map((plan) => ({ label: `${plan.name} available`, value: format.shares(plan.available), sub: `of ${format.shares(plan.poolSize)}` })),
    ];
  } else {
    columns = [...base, quantity("issued", "Quantity"), quantity("exercised", "Exercised"), quantity("outstanding", "Outstanding"), expiration, statusColumn];
    filters = [];
    const byClass = new Map<string, string>();
    for (const security of rows) {
      if (!security.stockClassId) continue;
      byClass.set(security.stockClassId, sumDecimals([byClass.get(security.stockClassId), number(security, "outstanding")]));
    }
    tiles = [
      { label: "Warrants outstanding", value: format.shares(sumDecimals(rows.map((security) => number(security, "outstanding")))) },
      ...[...byClass].map(([classId, total]) => ({ label: `On ${classNames.get(classId) ?? "another class"}`, value: format.shares(total) })),
    ];
  }

  return (
    <>
      <Tiles items={tiles} label={`${TAB_LABELS[tab]} summary`} />
      <DataTable
        id={`cap-${tab}`}
        label={TAB_LABELS[tab]}
        rows={rows}
        rowKey={(security) => security.id}
        columns={columns}
        defaultSort={["cert", "asc"]}
        pageSize={50}
        filters={filters}
        search={(security) => `${security.displayId} ${security.stakeholderName}`}
        empty={`No ${TAB_LABELS[tab].toLowerCase()} on this date.`}
      />
    </>
  );
}

export function boardApproval(security: Pick<api.Security, "boardApprovalDate" | "boardApprovalNotRecordedInPulley">, source: api.ImportSource | null | undefined = null): string {
  if (security.boardApprovalDate) return formatDate(security.boardApprovalDate);
  return security.boardApprovalNotRecordedInPulley ? `not recorded in ${api.importSourceName(source)}` : DASH;
}

export function exemptionLabel(security: Pick<api.Security, "exemption">): string {
  const federal = security.exemption.federal;
  if (!federal) return DASH;
  return federal === "NON_US" && security.exemption.country ? `Non-US (${security.exemption.country})` : FEDERAL_EXEMPTION_LABELS[federal];
}

export function certificateLabel(security: Pick<api.Security, "certificate">): string {
  const certificate = security.certificate;
  if (!certificate) return "Uncertificated";
  if (certificate.status === "VOID") return "Voided (migrated)";
  if (certificate.status === "CANCELLED") return "Cancelled";
  return "Unsigned PDF (migrated)";
}

/** "Issued", "Exercise of OPT-1", "Conversion of SAFE-6", "Transfer from CS-2". */
export function sourceLabel(security: api.Security, byId: ReadonlyMap<string, api.Security>): string {
  const parent = security.parentSecurityId ? byId.get(security.parentSecurityId)?.displayId ?? "another security" : null;
  if (!parent) return "Issued";
  switch (terms.origin(security.terms)) {
    case "EXERCISE": return `Exercise of ${parent}`;
    case "CONVERSION": return `Conversion of ${parent}`;
    case "TRANSFER": return `Transfer from ${parent}`;
    case "BALANCE": return `Remainder of ${parent}`;
    default: return `From ${parent}`;
  }
}

/** A discount stored as a fraction (OCF: "0.2") shown as "20%". */
export function discountLabel(rate: string | null | undefined): string {
  return rate ? formatFractionPercent(fractionOf(rate, "1")).replace(/\.00%$/, "%") : "0%";
}

export function yesNo(value: boolean | null): string {
  return value === null ? DASH : value ? "Yes" : "No";
}

// ---------------------------------------------------------------------------
// SAFEs (converted history)

function SafesTab({ context }: { context: Context }) {
  const { format, org } = useWorkspace();
  const rows = context.capTable.safes ?? [];
  const byId = new Map(context.securities.map((security) => [security.id, security]));
  const timing = (row: SafeRow) => (row.conversionTiming === "POST_MONEY" ? "Post-money" : row.conversionTiming === "PRE_MONEY" ? "Pre-money" : row.conversionTiming ?? DASH);
  const holder = (row: SafeRow) => holderOf(context, row.stakeholderId).name ?? byId.get(row.securityId)?.stakeholderName ?? DASH;
  const converted = rows.filter((row) => row.status === "CONVERTED");
  const columns: Column<SafeRow>[] = [
    { key: "cert", label: "Certificate", locked: true, sticky: true, render: (row) => <SecurityLink id={row.securityId} family="CONVERTIBLE" displayId={row.displayId} />, compare: byDisplayId((row) => row.displayId) },
    { key: "holder", label: "Stakeholder", minWidth: 200, render: (row) => <HolderLink id={row.stakeholderId} name={holder(row)} state={holderOf(context, row.stakeholderId).state} />, compare: byText(holder) },
    { key: "principal", label: "Principal", numeric: true, render: (row) => format.money(row.principal, 0), compare: byDecimal((row) => row.principal) },
    { key: "date", label: "Issued on", render: (row) => formatDate(row.issueDate), compare: byText((row) => row.issueDate) },
    { key: "cap", label: "Valuation cap", numeric: true, render: (row) => (row.valuationCap ? format.money(row.valuationCap, 0) : "Uncapped"), compare: byDecimal((row) => row.valuationCap) },
    { key: "type", label: "Conversion type", render: timing, compare: byText(timing) },
    { key: "disc", label: "Discount", numeric: true, render: (row) => discountLabel(row.discountRate), compare: byDecimal((row) => row.discountRate) },
    { key: "status", label: "Status", render: (row) => <Badge tone={SECURITY_STATUS_TONES[row.status]}>{SECURITY_STATUS_LABELS[row.status]}</Badge>, compare: byText((row) => row.status) },
    {
      key: "into", label: "Converted into",
      render: (row) => (row.convertedInto.length ? row.convertedInto.map((item, index) => <span key={item.securityId}>{index ? ", " : ""}<SecurityLink id={item.securityId} family="STOCK" displayId={item.displayId} /></span>) : DASH),
    },
    { key: "cprice", label: "Conversion price (per closing memo)", numeric: true, render: (row) => format.price(terms.safeTerms(byId.get(row.securityId)?.terms ?? {}).conversionPrice) },
    { key: "funds", label: "Funds received", defaultHidden: true, render: (row) => formatDate(terms.safeTerms(byId.get(row.securityId)?.terms ?? {}).fundsReceivedOn) },
    { key: "board", label: "Board approval date", defaultHidden: true, render: (row) => { const security = byId.get(row.securityId); return security ? boardApproval(security, org.importSource) : DASH; } },
  ];
  const timings = [...new Set(rows.map(timing))].map((value) => [value, value] as const);
  return (
    <>
      <Tiles
        label="SAFEs summary"
        items={[safeTile(context.securities, format), { label: "Principal converted", value: format.money(sumDecimals(converted.map((row) => row.principal)), 0) }]}
      />
      <DataTable
        id="cap-safes"
        label="SAFEs"
        rows={rows}
        rowKey={(row) => row.securityId}
        columns={columns}
        defaultSort={["cert", "asc"]}
        pageSize={50}
        search={(row) => `${row.displayId} ${holder(row)}`}
        filters={[{ key: "type", label: "Conversion type", options: timings, test: (row, value) => timing(row) === value }]}
        empty="No SAFEs on this date."
      />
    </>
  );
}
