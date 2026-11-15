import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { DownloadError, useCanDownload, useDownload } from "../components/Documents.tsx";
import { Badge, EmptyState, Pending } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { LinkTabs } from "../components/LinkTabs.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { electionDueDate, electionsInForce } from "../lib/elections.ts";
import { DASH, formatDate, plural } from "../lib/format.ts";
import { ELECTION_83B_LABELS, SECURITY_STATUS_LABELS, type Tone } from "../lib/labels.ts";
import * as terms from "../lib/terms.ts";
import { allOf, useResource } from "../lib/useResource.ts";
import { currentValuation } from "../lib/valuations.ts";

// Compliance & Tax › 83(b) elections and Checks: read-only views of what the existing admin routes already hold. The
// 83(b) tab lists each share's election record in force; Checks lists what the company still has to complete: its EIN
// and address, securities whose board approval the import didn't record (the list counsel ratifies), a 409A in effect
// without a board adoption date, and restricted shares with no 83(b) record. Nothing here writes or sends a reminder.

type ComplianceTab = "409a" | "83b" | "checks";

/** The Compliance & Tax tabs, one route each. */
export function ComplianceTabs({ selected }: { selected: ComplianceTab }) {
  const { href } = useWorkspace();
  return (
    <LinkTabs
      label="Compliance and tax"
      selected={selected}
      tabs={[
        { id: "409a", label: "409A Valuations", to: href("compliance/409a") },
        { id: "83b", label: "83(b) elections", to: href("compliance/83b") },
        { id: "checks", label: "Checks", to: href("compliance/checks") },
      ]}
    />
  );
}

function ComplianceShell({ selected, children }: { selected: ComplianceTab; children: ReactNode }) {
  return (
    <Page title="Compliance & Tax" crumbs={[["Compliance & Tax"]]}>
      <Card>
        <PageHead title="Compliance & Tax" />
        <ComplianceTabs selected={selected} />
        <div className="form mt-16">{children}</div>
      </Card>
    </Page>
  );
}

function SecurityCell({ security }: { security: Pick<api.Security, "id" | "family" | "displayId"> }) {
  const { href } = useWorkspace();
  return <Link className="mono" to={href(terms.securityHref(security))}>{security.displayId}</Link>;
}

function HolderCell({ security }: { security: Pick<api.Security, "stakeholderId" | "stakeholderName"> }) {
  const { href } = useWorkspace();
  return <Link to={href(`stakeholders/${security.stakeholderId}`)}>{security.stakeholderName}</Link>;
}

// ---------------------------------------------------------------------------
// 83(b) elections

const ELECTION_TONES: Record<api.Election83b["status"], Tone> = {
  FILED: "green",
  NOT_REQUIRED: "grey",
  PENDING: "amber",
  UNCONFIRMED_DEADLINE_PASSED: "red",
  PROOF_MISSING: "red",
};

export function ElectionsPage() {
  const { orgId } = useWorkspace();
  const elections = useResource((signal) => apiRequest(api.routes.listElections83b, { params: { orgId }, signal }), [orgId]);
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, signal }), [orgId]);
  return (
    <ComplianceShell selected="83b">
      <p className="small muted">
        Each share's 83(b) election as recorded: the record in force, after any correction. The deadline is 30 days after the transfer, moved to the next business day
        when it falls on a weekend or legal holiday. Read-only.
      </p>
      <Pending resource={allOf(elections, securities)} what="the 83(b) elections">
        {([list, securityList]) => <ElectionsTable records={list.items} securities={securityList.items} />}
      </Pending>
    </ComplianceShell>
  );
}

function ElectionsTable({ records, securities }: { records: readonly api.Election83b[]; securities: readonly api.Security[] }) {
  const { format } = useWorkspace();
  const canDownload = useCanDownload();
  const { download, error, busy } = useDownload();
  const byId = new Map(securities.map((security) => [security.id, security]));
  const rows = [...electionsInForce(records).values()]
    .map((record) => ({ record, security: byId.get(record.securityId) }))
    .sort((a, b) => (b.record.transferDate ?? "").localeCompare(a.record.transferDate ?? "") || (a.security?.displayId ?? "").localeCompare(b.security?.displayId ?? "", "en", { numeric: true }));
  if (rows.length === 0) {
    return (
      <EmptyState>
        <p className="b-title">No 83(b) elections recorded</p>
        <p className="small muted">Restricted shares without a record are listed under Checks.</p>
      </EmptyState>
    );
  }
  return (
    <>
      <div className="tbl-scroll">
        <table className="tbl" aria-label="83(b) elections">
          <thead>
            <tr>
              <th scope="col">Certificate</th>
              <th scope="col">Holder</th>
              <th scope="col" className="num">Quantity</th>
              <th scope="col">Transfer date</th>
              <th scope="col">Due date</th>
              <th scope="col">Status</th>
              <th scope="col">Proof</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ record, security }) => (
              <tr key={record.id}>
                <td>{security ? <SecurityCell security={security} /> : DASH}</td>
                <td>{security ? <HolderCell security={security} /> : DASH}</td>
                <td className="num">{format.shares(security?.numbers?.issued ?? null)}</td>
                <td>{formatDate(record.transferDate)}</td>
                <td>{formatDate(electionDueDate(record))}</td>
                <td>
                  <Badge tone={ELECTION_TONES[record.status]}>
                    {record.status === "FILED" && record.filedDate ? `Filed ${formatDate(record.filedDate)}` : ELECTION_83B_LABELS[record.status] ?? record.status}
                  </Badge>
                </td>
                <td>
                  {record.proofDocumentId === null ? (
                    <span className="muted">None</span>
                  ) : canDownload ? (
                    <button type="button" className="btn-link" disabled={busy === record.proofDocumentId}
                      onClick={() => void download(record.proofDocumentId!, `83(b) proof ${security?.displayId ?? record.id}.pdf`)}>
                      Download proof<span className="sr-only"> of {security?.displayId ?? "this election"}</span>
                    </button>
                  ) : (
                    "On file"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DownloadError error={error} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Checks

/** One check: its title with the count of what needs completing, what it means, and the items (or that there are none). */
function Check({ title, count, description, done, children }: { title: string; count: number; description: ReactNode; done: string; children?: ReactNode }) {
  const id = useId();
  return (
    <section className="review-panel check" aria-labelledby={id}>
      <div className="card-h">
        <h3 id={id}>{title}</h3>
        <Badge tone={count ? "red" : "green"}>{count ? plural(count, "to complete", "to complete") : "Complete"}</Badge>
      </div>
      <p className="small muted">{description}</p>
      {count ? children : <p className="small"><Icon name="check" /> {done}</p>}
    </section>
  );
}

/** The families of the ratification list, SAFEs a group of their own. */
const FAMILY_GROUPS: readonly [api.SecurityFamily, string][] = [
  ["EQUITY_COMPENSATION", "Option grants"],
  ["STOCK", "Shares"],
  ["WARRANT", "Warrants"],
  ["CONVERTIBLE", "SAFEs"],
];

export function ComplianceChecksPage() {
  const { orgId } = useWorkspace();
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, signal }), [orgId]);
  const elections = useResource((signal) => apiRequest(api.routes.listElections83b, { params: { orgId }, signal }), [orgId]);
  const valuations = useResource((signal) => apiRequest(api.routes.listValuations, { params: { orgId }, signal }), [orgId]);
  return (
    <ComplianceShell selected="checks">
      <p className="small muted">Records the company still has to complete, from what the cap table holds today. Nothing here sends a reminder.</p>
      <CompanyCheck />
      <Pending resource={allOf(securities, elections, valuations)} what="the checks">
        {([securityList, electionList, valuationList]) => (
          <>
            <BoardApprovalCheck securities={securityList.items} />
            <ValuationAdoptionCheck valuations={valuationList.items} />
            <ElectionCheck securities={securityList.items} elections={electionList.items} />
          </>
        )}
      </Pending>
    </ComplianceShell>
  );
}

function CompanyCheck() {
  const { org, href } = useWorkspace();
  const missing = [
    org.ein === null ? "EIN" : null,
    org.address === null || org.address.line1.trim() === "" ? "Street address" : null,
  ].filter((item) => item !== null);
  return (
    <Check
      title="Company EIN and address"
      count={missing.length}
      description={<>An import doesn't bring them over. Anyone who records changes enters them in the <Link to={href("company")}>Company profile</Link>.</>}
      done="The EIN and the company's street address are recorded."
    >
      <ul className="small" aria-label="Missing company details">
        {missing.map((item) => <li key={item}>{item} not recorded</li>)}
      </ul>
    </Check>
  );
}

function BoardApprovalCheck({ securities }: { securities: readonly api.Security[] }) {
  const { org } = useWorkspace();
  const source = api.importSourceName(org.importSource);
  const flagged = securities.filter((security) => security.boardApprovalNotRecordedInPulley);
  const groups = FAMILY_GROUPS.map(([family, label]) => ({ family, label, items: flagged.filter((security) => security.family === family) })).filter((group) => group.items.length);
  return (
    <Check
      title={`Board approval not recorded in ${source}`}
      count={flagged.length}
      description={`The securities ${source} held no board approval date for: the list for counsel's ratification consent. A ratification is linked to each security as a document; it never becomes the original approval date.`}
      done="Every security has a board approval date."
    >
      {groups.map((group) => (
        <div key={group.family} className="mt-12">
          <h4>{group.label} ({group.items.length})</h4>
          <div className="tbl-scroll mt-8">
            <table className="tbl dense" aria-label={`${group.label} without a recorded board approval`}>
              <thead>
                <tr><th scope="col">Security</th><th scope="col">Holder</th><th scope="col">Issue date</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                {[...group.items].sort((a, b) => a.displayId.localeCompare(b.displayId, "en", { numeric: true })).map((security) => (
                  <tr key={security.id}>
                    <td><SecurityCell security={security} /></td>
                    <td><HolderCell security={security} /></td>
                    <td>{formatDate(security.issueDate)}</td>
                    <td>{SECURITY_STATUS_LABELS[security.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </Check>
  );
}

function ValuationAdoptionCheck({ valuations }: { valuations: readonly api.Valuation[] }) {
  const { href, today } = useWorkspace();
  const current = currentValuation(valuations, today);
  const unadopted = current !== null && current.boardApprovalDate === null;
  return (
    <Check
      title="409A in effect without board adoption"
      count={current === null || unadopted ? 1 : 0}
      description="The board adopts each 409A the company relies on for grants. An imported valuation carries no adoption date; a 409A recorded here takes it from the board's consent."
      done={current ? `${current.name} was adopted by the board on ${formatDate(current.boardApprovalDate)}.` : ""}
    >
      <p className="small">
        {current === null ? (
          <>No 409A valuation is in effect: see <Link to={href("compliance/409a")}>409A Valuations</Link>.</>
        ) : (
          <><Link to={href(`compliance/409a/${current.id}`)}>{current.name}</Link>, effective {formatDate(current.effectiveDate)}, has no board adoption date.</>
        )}
      </p>
    </Check>
  );
}

function ElectionCheck({ securities, elections }: { securities: readonly api.Security[]; elections: readonly api.Election83b[] }) {
  const { format } = useWorkspace();
  const recorded = new Set(elections.map((record) => record.securityId));
  const missing = securities
    .filter((security) => security.family === "STOCK" && terms.vestingTermsId(security.terms) !== null && !recorded.has(security.id))
    .sort((a, b) => a.displayId.localeCompare(b.displayId, "en", { numeric: true }));
  return (
    <Check
      title="Restricted shares without an 83(b) record"
      count={missing.length}
      description="Shares subject to vesting, such as founder or early-exercise shares, for which no 83(b) election is recorded. An election may have been required: confirm with the holder or counsel."
      done="Every restricted share has an 83(b) record."
    >
      <div className="tbl-scroll">
        <table className="tbl dense" aria-label="Restricted shares without an 83(b) record">
          <thead>
            <tr><th scope="col">Security</th><th scope="col">Holder</th><th scope="col">Issue date</th><th scope="col" className="num">Quantity</th></tr>
          </thead>
          <tbody>
            {missing.map((security) => (
              <tr key={security.id}>
                <td><SecurityCell security={security} /></td>
                <td><HolderCell security={security} /></td>
                <td>{formatDate(security.issueDate)}</td>
                <td className="num">{format.shares(security.numbers?.issued ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Check>
  );
}
