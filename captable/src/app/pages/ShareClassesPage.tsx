import { Link, useParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { RecordActivity } from "../components/Activity.tsx";
import { DataTable, byDecimal, byDisplayId, byNumber, byText } from "../components/DataTable.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { LinkedDocuments } from "../components/Documents.tsx";
import { Badge, Pending, ResourceView } from "../components/Feedback.tsx";
import { HolderLink, SecurityLink } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead, SectionTitle } from "../components/Page.tsx";
import { fromUnits, toUnits } from "../lib/decimal.ts";
import { DASH, formatDate } from "../lib/format.ts";
import { SECURITY_STATUS_LABELS, SECURITY_STATUS_TONES } from "../lib/labels.ts";
import { useResource, type Resource } from "../lib/useResource.ts";

// Share classes, view only: the list, and a class's summary, terms, amendments, securities,
// documents and activity. There is no form to edit or amend one: share classes come in with the import.

const PARTICIPATION_LABELS = { NON_PARTICIPATING: "non-participating", PARTICIPATING: "participating", CAPPED: "capped participation" } as const;
const ANTI_DILUTION_LABELS = { NONE: "None", BROAD_BASED_WEIGHTED_AVERAGE: "Broad-based weighted average", NARROW_BASED_WEIGHTED_AVERAGE: "Narrow-based weighted average", FULL_RATCHET: "Full ratchet" } as const;

function notRecorded(stockClass: api.StockClass, field: string): boolean {
  return stockClass.terms.notRecordedInPulley.includes(field);
}

export function liquidationLabel(stockClass: api.StockClass): string {
  if (notRecorded(stockClass, "liquidationPreferenceMultiple")) return "not recorded in Pulley";
  const multiple = stockClass.terms.liquidationPreferenceMultiple;
  if (!multiple) return DASH;
  const participation = stockClass.terms.participation ? ` ${PARTICIPATION_LABELS[stockClass.terms.participation]}` : "";
  return `${multiple}×${participation}`;
}

function ratioLabel(ratio: api.StockClass["conversionRatio"]): string {
  return `${ratio.numerator}:${ratio.denominator}`;
}

export function ShareClassesPage() {
  const { orgId, format, href } = useWorkspace();
  const classes = useResource((signal) => apiRequest(api.routes.listStockClasses, { params: { orgId }, signal }), [orgId]);
  return (
    <Page title="Share Classes" crumbs={[["Cap Table", href("captable")], ["Share Classes"]]}>
      <Card>
        <PageHead title="Share Classes" sub="View only. Share classes come in with the import; the app has no form to change them." />
        <ResourceView resource={classes}>
          {(data) => (
            <DataTable
              id="share-classes"
              label="Share classes"
              rows={data.items}
              rowKey={(item) => item.id}
              paginate={false}
              search={(item) => `${item.name} ${item.defaultIdPrefix}`}
              empty="No share classes yet."
              columns={[
                { key: "name", label: "Name", render: (item) => <Link className="cell-link" to={href(`share-classes/${item.id}`)}>{item.name} ({item.defaultIdPrefix})</Link>, compare: byText((item) => item.name) },
                { key: "type", label: "Type", render: (item) => (item.classType === "COMMON" ? "Common" : "Preferred"), compare: byText((item) => item.classType) },
                { key: "par", label: "Par value", numeric: true, render: (item) => format.price(item.parValue), compare: byDecimal((item) => item.parValue) },
                { key: "oip", label: "Original issue price", numeric: true, render: (item) => (item.originalIssuePrice ? format.price(item.originalIssuePrice) : DASH), compare: byDecimal((item) => item.originalIssuePrice) },
                {
                  key: "auth", label: "Authorized", numeric: true,
                  render: (item) => <>{format.shares(item.authorizedShares)}<div className="small muted">{format.shares(item.numbers.issuedAndOutstanding)} outstanding</div></>,
                  compare: byDecimal((item) => item.authorizedShares),
                },
                { key: "liq", label: "Liquidation preference", render: liquidationLabel },
                { key: "sen", label: "Seniority", render: (item) => (item.terms.seniority === null ? DASH : String(item.terms.seniority)), compare: byNumber((item) => item.terms.seniority) },
                { key: "cert", label: "Certificated", render: (item) => (item.isCertificated ? "Yes" : "No") },
              ]}
            />
          )}
        </ResourceView>
      </Card>
    </Page>
  );
}

export function ShareClassPage() {
  const { orgId, href } = useWorkspace();
  const { classId = "" } = useParams();
  const detail = useResource((signal) => apiRequest(api.routes.getStockClass, { params: { orgId, id: classId }, signal }), [orgId, classId]);
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, signal }), [orgId]);
  const title = detail.data?.name ?? "Share class";
  return (
    <Page title={title} crumbs={[["Share Classes", href("share-classes")], [title]]}>
      <ResourceView resource={detail} notFound="This share class does not exist.">
        {(stockClass) => <ShareClassBody stockClass={stockClass} securities={securities} />}
      </ResourceView>
    </Page>
  );
}

function ShareClassBody({ stockClass, securities }: { stockClass: api.StockClassDetail; securities: Resource<api.SecurityList> }) {
  const { format, href } = useWorkspace();
  const { numbers, terms } = stockClass;
  // The contract's availableToIssue is non-negative, so the shortfall is recomputed here to warn about it.
  const available = toUnits(stockClass.authorizedShares) - toUnits(numbers.issuedAndOutstanding) - toUnits(numbers.reserved);
  return (
    <Card>
      <PageHead title={stockClass.name} />
      <SectionTitle>Summary</SectionTitle>
      <DescriptionList
        rows={[
          ["Authorized", format.shares(stockClass.authorizedShares)],
          ["Issued and outstanding", format.shares(numbers.issuedAndOutstanding)],
          ["Reserved", format.shares(numbers.reserved)],
          ["Available to issue", available < 0n
            ? <span style={{ color: "var(--danger-text)", fontWeight: 650 }}>−{format.shares(fromUnits(-available))} — authorized exceeded</span>
            : format.shares(fromUnits(available))],
        ]}
      />
      <SectionTitle>Terms</SectionTitle>
      <DescriptionList
        rows={[
          ["Type", stockClass.classType === "COMMON" ? "Common" : "Preferred"],
          ["Par value", format.price(stockClass.parValue)],
          ["Original issue price", stockClass.originalIssuePrice ? format.price(stockClass.originalIssuePrice) : DASH],
          ["Conversion ratio (effective)", ratioLabel(stockClass.conversionRatio)],
          ["Liquidation preference", liquidationLabel(stockClass)],
          ["Participation", notRecorded(stockClass, "participation") ? "not recorded in Pulley" : terms.participation ? PARTICIPATION_LABELS[terms.participation] : DASH],
          ["Seniority", terms.seniority === null ? DASH : String(terms.seniority)],
          ["Dividends", notRecorded(stockClass, "dividendTerms") ? "not recorded in Pulley" : terms.dividendTerms ? "As recorded" : DASH],
          ["Voting", `${terms.votesPerShare} vote${terms.votesPerShare === "1" ? "" : "s"} per share`],
          ["Anti-dilution", notRecorded(stockClass, "antiDilution") ? "not recorded in Pulley" : terms.antiDilution ? ANTI_DILUTION_LABELS[terms.antiDilution] : DASH],
          ["Prefix", stockClass.defaultIdPrefix],
          ["Certificated", stockClass.isCertificated ? "Yes" : "No"],
          ["Board approval", formatDate(stockClass.boardApprovalDate)],
          ["Stockholder approval", formatDate(stockClass.stockholderApprovalDate)],
          ["Certificate terms", <Link to={href("certificates/terms")}>View certificate terms</Link>],
        ]}
      />
      <SectionTitle>Amendments</SectionTitle>
      {stockClass.history.length ? (
        <div className="tbl-scroll">
          <table className="tbl" aria-label="Amendments">
            <thead><tr><th scope="col">Effective</th><th scope="col">Change</th></tr></thead>
            <tbody>{stockClass.history.map((entry) => <tr key={entry.transactionId}><td>{formatDate(entry.effectiveDate)}</td><td>{entry.summary}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No amendments.</p>
      )}
      <SectionTitle>Securities of this class</SectionTitle>
      <Pending resource={securities} what="the securities of this class">
        {(data) => (
          <DataTable
            id="class-securities"
            label="Securities of this class"
            rows={data.items.filter((security) => security.stockClassId === stockClass.id && (security.family === "STOCK" || security.family === "WARRANT"))}
            rowKey={(security) => security.id}
            toolbar={false}
            defaultSort={["id", "asc"]}
            empty="No securities of this class."
            columns={[
              { key: "id", label: "ID", render: (security) => <SecurityLink id={security.id} family={security.family} displayId={security.displayId} />, compare: byDisplayId((security) => security.displayId) },
              { key: "holder", label: "Holder", render: (security) => <HolderLink id={security.stakeholderId} name={security.stakeholderName} />, compare: byText((security) => security.stakeholderName) },
              { key: "qty", label: "Quantity", numeric: true, render: (security) => format.shares(security.numbers?.issued ?? null), compare: byDecimal((security) => security.numbers?.issued) },
              { key: "date", label: "Issued on", render: (security) => formatDate(security.issueDate), compare: byText((security) => security.issueDate) },
              { key: "status", label: "Status", render: (security) => <Badge tone={SECURITY_STATUS_TONES[security.status]}>{SECURITY_STATUS_LABELS[security.status]}</Badge> },
            ]}
          />
        )}
      </Pending>
      <SectionTitle>Documents</SectionTitle>
      <LinkedDocuments targetType="stock_class" targetId={stockClass.id} />
      <SectionTitle>Activity</SectionTitle>
      <RecordActivity targetId={stockClass.id} />
    </Card>
  );
}
