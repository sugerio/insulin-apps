import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { api } from "#shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card as UiCard, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { apiRequest } from "../api/request.ts";
import { DownloadError, useCanDownload, useDownload } from "../components/Documents.tsx";
import { LinkTabs } from "../components/LinkTabs.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { electionDueDate, electionsInForce } from "../lib/elections.ts";
import { describeError } from "../lib/errors.ts";
import { DASH, formatDate, plural } from "../lib/format.ts";
import { ELECTION_83B_LABELS, SECURITY_STATUS_LABELS } from "../lib/labels.ts";
import * as terms from "../lib/terms.ts";
import { allOf, useResource, type Resource } from "../lib/useResource.ts";
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
        <div className="flex flex-col gap-4">{children}</div>
      </Card>
    </Page>
  );
}

/** A resource's data, or its loading state, or its error with Try again: never a figure from a missing answer. */
function Loaded<T>({ resource, what, children }: { resource: Resource<T>; what: string; children: (data: T) => ReactNode }) {
  if (resource.data !== undefined) return <>{children(resource.data)}</>;
  if (resource.error !== undefined) {
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Couldn't load {what}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {describeError(resource.error)}
          <Button variant="outline" size="sm" onClick={resource.reload}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <p role="status" className="text-sm text-muted-foreground">Loading {what}…</p>;
}

function SecurityCell({ security }: { security: Pick<api.Security, "id" | "family" | "displayId"> }) {
  const { href } = useWorkspace();
  return <Link className="font-medium text-primary hover:underline" to={href(terms.securityHref(security))}>{security.displayId}</Link>;
}

function HolderCell({ security }: { security: Pick<api.Security, "stakeholderId" | "stakeholderName"> }) {
  const { href } = useWorkspace();
  return <Link className="text-primary hover:underline" to={href(`stakeholders/${security.stakeholderId}`)}>{security.stakeholderName}</Link>;
}

// ---------------------------------------------------------------------------
// 83(b) elections

const ELECTION_VARIANTS: Record<api.Election83b["status"], "secondary" | "outline" | "destructive"> = {
  FILED: "secondary",
  NOT_REQUIRED: "outline",
  PENDING: "outline",
  UNCONFIRMED_DEADLINE_PASSED: "destructive",
  PROOF_MISSING: "destructive",
};

export function ElectionsPage() {
  const { orgId } = useWorkspace();
  const elections = useResource((signal) => apiRequest(api.routes.listElections83b, { params: { orgId }, signal }), [orgId]);
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, signal }), [orgId]);
  return (
    <ComplianceShell selected="83b">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Each share's 83(b) election as recorded: the record in force, after any correction. The deadline is 30 days after the transfer, moved to the next business day when it
        falls on a weekend or legal holiday. Read-only.
      </p>
      <Loaded resource={allOf(elections, securities)} what="the 83(b) elections">
        {([list, securityList]) => <ElectionsTable records={list.items} securities={securityList.items} />}
      </Loaded>
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
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyTitle>No 83(b) elections recorded</EmptyTitle>
          <EmptyDescription>Restricted shares without a record are listed under Checks.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table aria-label="83(b) elections">
          <TableHeader>
            <TableRow>
              <TableHead>Certificate</TableHead>
              <TableHead>Holder</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead>Transfer date</TableHead>
              <TableHead>Due date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Proof</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ record, security }) => (
              <TableRow key={record.id}>
                <TableCell>{security ? <SecurityCell security={security} /> : DASH}</TableCell>
                <TableCell>{security ? <HolderCell security={security} /> : DASH}</TableCell>
                <TableCell className="text-right tabular-nums">{format.shares(security?.numbers?.issued ?? null)}</TableCell>
                <TableCell>{formatDate(record.transferDate)}</TableCell>
                <TableCell>{formatDate(electionDueDate(record))}</TableCell>
                <TableCell>
                  <Badge variant={ELECTION_VARIANTS[record.status]}>
                    {record.status === "FILED" && record.filedDate ? `Filed ${formatDate(record.filedDate)}` : ELECTION_83B_LABELS[record.status] ?? record.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {record.proofDocumentId === null ? (
                    <span className="text-muted-foreground">None</span>
                  ) : canDownload ? (
                    <Button variant="link" size="sm" className="h-auto px-0" disabled={busy === record.proofDocumentId}
                      onClick={() => void download(record.proofDocumentId!, `83(b) proof ${security?.displayId ?? record.id}.pdf`)}>
                      Download proof<span className="sr-only"> of {security?.displayId ?? "this election"}</span>
                    </Button>
                  ) : (
                    "On file"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <DownloadError error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checks

/** One check: its title with the count of what needs completing, what it means, and the items (or that there are none). */
function Check({ title, count, description, done, children }: { title: string; count: number; description: ReactNode; done: string; children?: ReactNode }) {
  const id = useId();
  return (
    <UiCard role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <h2 id={id}>{title}</h2>
          <Badge variant={count ? "destructive" : "secondary"}>{count ? plural(count, "to complete", "to complete") : "Complete"}</Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {count ? children : <p className="flex items-center gap-2 text-sm text-muted-foreground"><CircleCheckIcon className="size-4" />{done}</p>}
      </CardContent>
    </UiCard>
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
      <p className="max-w-3xl text-sm text-muted-foreground">
        Records the company still has to complete, from what the cap table holds today. Nothing here sends a reminder.
      </p>
      <CompanyCheck />
      <Loaded resource={allOf(securities, elections, valuations)} what="the checks">
        {([securityList, electionList, valuationList]) => (
          <>
            <BoardApprovalCheck securities={securityList.items} />
            <ValuationAdoptionCheck valuations={valuationList.items} />
            <ElectionCheck securities={securityList.items} elections={electionList.items} />
          </>
        )}
      </Loaded>
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
      description={<>An import doesn't bring them over. Anyone who records changes enters them in the <Link className="text-primary hover:underline" to={href("company")}>Company profile</Link>.</>}
      done="The EIN and the company's street address are recorded."
    >
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" aria-label="Missing company details">
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
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.family} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{group.label} ({group.items.length})</h3>
            <div className="overflow-hidden rounded-lg border">
              <Table aria-label={`${group.label} without a recorded board approval`}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Security</TableHead>
                    <TableHead>Holder</TableHead>
                    <TableHead>Issue date</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...group.items].sort((a, b) => a.displayId.localeCompare(b.displayId, "en", { numeric: true })).map((security) => (
                    <TableRow key={security.id}>
                      <TableCell><SecurityCell security={security} /></TableCell>
                      <TableCell><HolderCell security={security} /></TableCell>
                      <TableCell>{formatDate(security.issueDate)}</TableCell>
                      <TableCell>{SECURITY_STATUS_LABELS[security.status]}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ))}
      </div>
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
      <p className="text-sm">
        {current === null ? (
          <>No 409A valuation is in effect: see <Link className="text-primary hover:underline" to={href("compliance/409a")}>409A Valuations</Link>.</>
        ) : (
          <><Link className="text-primary hover:underline" to={href(`compliance/409a/${current.id}`)}>{current.name}</Link>, effective {formatDate(current.effectiveDate)}, has no board adoption date.</>
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
      <div className="overflow-hidden rounded-lg border">
        <Table aria-label="Restricted shares without an 83(b) record">
          <TableHeader>
            <TableRow>
              <TableHead>Security</TableHead>
              <TableHead>Holder</TableHead>
              <TableHead>Issue date</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {missing.map((security) => (
              <TableRow key={security.id}>
                <TableCell><SecurityCell security={security} /></TableCell>
                <TableCell><HolderCell security={security} /></TableCell>
                <TableCell>{formatDate(security.issueDate)}</TableCell>
                <TableCell className="text-right tabular-nums">{format.shares(security.numbers?.issued ?? null)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Check>
  );
}
