import { useState } from "react";
import { Link } from "react-router";
import { api } from "#shared";
import { apiRequest, saveFile } from "../api/request.ts";
import { ActionsMenu } from "../components/Actions.tsx";
import { DataTable, byDecimal, byRatio, byText, type Column, type Filter } from "../components/DataTable.tsx";
import { Badge, Banner, ResourceView } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { HolderLink, holderState } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { usePii } from "../components/Pii.tsx";
import { fileStem } from "../components/CapTableDownload.tsx";
import { isPositive } from "../lib/decimal.ts";
import { describeError } from "../lib/errors.ts";
import { DASH, formatDate, plural } from "../lib/format.ts";
import { RELATIONSHIP_LABELS, relationshipChip } from "../lib/labels.ts";
import { activeEmails, duplicateEmails, isActiveStaff, statusOf } from "../lib/stakeholders.ts";
import { useResource } from "../lib/useResource.ts";

// Stakeholders: banners when relevant, then the list with e-mails (masked for editors who may not
// see personal data), relationship and holdings; 10 rows. A stakeholder's e-mail is what connects a console account to
// their holdings in the holder view.

const REL_OPTIONS = (Object.keys(RELATIONSHIP_LABELS) as api.Relationship[]).map((key) => [key, RELATIONSHIP_LABELS[key]] as const);

export function StakeholdersPage() {
  const { orgId } = useWorkspace();
  const stakeholders = useResource((signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }), [orgId]);
  return (
    <Page title="Stakeholders" crumbs={[["Stakeholders"]]}>
      <ResourceView resource={stakeholders}>
        {(data) => <StakeholdersBody items={data.items} />}
      </ResourceView>
    </Page>
  );
}

function StakeholdersBody({ items }: { items: readonly api.Stakeholder[] }) {
  const workspace = useWorkspace();
  const { format, href, orgId, name } = workspace;
  const pii = usePii();
  const [notice, setNotice] = useState<string | null>(null);
  const duplicates = pii.canSeePii ? duplicateEmails(items) : new Set<string>();
  const withoutEmail = items.filter(isActiveStaff).filter((item) => activeEmails(item).length === 0);
  // Only rows whose totals came back: a row without totals is unknown, not empty.
  const noHoldings = items.filter((item) => item.totals !== undefined && !isPositive(item.totals.fullyDiluted));
  const primary = (item: api.Stakeholder) => activeEmails(item)[0]?.email ?? null;
  const isDuplicate = (item: api.Stakeholder) => activeEmails(item).some((email) => duplicates.has(email.email.toLowerCase()));
  const portalOpen = (item: api.Stakeholder) => item.portalState === "open";

  const download = async () => {
    setNotice(null);
    try {
      await saveFile(
        api.routes.runReport,
        { params: { orgId, reportKey: "stakeholders" }, query: { format: "csv", ...(pii.canSeePii ? { includePii: "true" } : {}) } },
        `${fileStem(name)}_Stakeholders_${workspace.today}.csv`,
      );
    } catch (cause) {
      setNotice(describeError(cause, { not_found: "This export isn't available." }));
    }
  };

  const columns: Column<api.Stakeholder>[] = [
    { key: "name", label: "Name", locked: true, sticky: true, minWidth: 230, render: (item) => <HolderLink id={item.id} name={item.displayName} state={holderState(item)} />, compare: byText((item) => item.displayName) },
    {
      key: "email", label: "E-mail",
      render: (item) => {
        const emails = activeEmails(item);
        if (!emails.length) return DASH;
        return (
          <>
            {pii.email(emails[0]!.email)}
            {emails.length > 1 ? <span className="faint small"> +{emails.length - 1}</span> : null}
            {isDuplicate(item) ? <div><Badge tone="amber">Duplicate</Badge></div> : null}
          </>
        );
      },
      compare: pii.canSeePii ? byText(primary) : undefined,
    },
    { key: "rel", label: "Relationship", render: (item) => <span className="chip">{relationshipChip(item.relationship)}</span>, compare: byText((item) => relationshipChip(item.relationship)) },
    { key: "type", label: "Type", render: (item) => (item.kind === "institution" ? "Institution" : "Individual"), compare: byText((item) => item.kind) },
    { key: "fd", label: "Fully diluted shares", numeric: true, headerClassName: "wrap-th", render: (item) => format.shares(item.totals?.fullyDiluted ?? null), compare: byDecimal((item) => item.totals?.fullyDiluted) },
    { key: "own", label: "Ownership", numeric: true, render: (item) => (isPositive(item.totals?.fullyDiluted) ? format.percent(item.totals?.fullyDilutedPct) : DASH), compare: byRatio((item) => item.totals?.fullyDilutedPct) },
    {
      key: "preview", label: "", stickyRight: true,
      render: (item) => (
        <Link className="icon-link" to={href(`stakeholders/${item.id}/preview`)} title="Preview as stakeholder" aria-label={`Preview ${item.displayName} as stakeholder`}>
          <Icon name="eye" />
        </Link>
      ),
    },
    { key: "ext", label: "External ID", defaultHidden: true, render: (item) => item.issuerAssignedId ?? DASH, compare: byText((item) => item.issuerAssignedId) },
    { key: "hire", label: "Hire date", defaultHidden: true, render: (item) => formatDate(item.hireDate), compare: byText((item) => item.hireDate) },
    { key: "termd", label: "Termination date", defaultHidden: true, render: (item) => formatDate(item.termination?.date ?? item.scheduledTermination?.terminationDate), compare: byText((item) => item.termination?.date ?? item.scheduledTermination?.terminationDate) },
    { key: "country", label: "Country", defaultHidden: true, render: (item) => pii.text(item.countryOfResidence) },
    { key: "contacts", label: "Contacts", numeric: true, defaultHidden: true, render: (item) => (item.kind === "institution" ? String(activeEmails(item).filter((email) => email.kind === "contact").length) : DASH) },
  ];

  const filters: Filter<api.Stakeholder>[] = [
    { key: "rel", label: "Relationship", type: "multi", options: REL_OPTIONS, test: (item, values) => values.includes(item.relationship) },
    { key: "type", label: "Type", options: [["individual", "Individual"], ["institution", "Institution"]], test: (item, value) => item.kind === value },
    { key: "status", label: "Status", options: [["active", "Active"], ["terminating", "Terminating"], ["terminated", "Terminated"]], test: (item, value) => statusOf(item) === value },
    ...(pii.canSeePii ? [{ key: "dup", label: "Duplicate e-mail", options: [["yes", "Only duplicates"]] as const, test: (item: api.Stakeholder) => isDuplicate(item) }] : []),
    // A row without totals is unknown: it matches neither "Yes" nor "No".
    { key: "hold", label: "Has holdings", options: [["yes", "Yes"], ["no", "No"]], test: (item, value) => item.totals !== undefined && (value === "yes") === isPositive(item.totals.fullyDiluted) },
    { key: "open", label: "Portal access open", options: [["yes", "Yes"], ["no", "No"]], test: (item, value) => (value === "yes") === portalOpen(item) },
  ];

  return (
    <Card>
      {withoutEmail.length ? (
        <Banner kind="warn" title={`${plural(withoutEmail.length, "current employee")} ${withoutEmail.length === 1 ? "has" : "have"} no e-mail address — they can't see their holdings`}>
          The holder view matches a console account to a stakeholder by e-mail. {withoutEmail.map((item, index) => <span key={item.id}>{index ? ", " : ""}<Link to={href(`stakeholders/${item.id}`)}>{item.displayName}</Link></span>)}
        </Banner>
      ) : null}
      {noHoldings.length ? (
        <Banner kind="warn" title={`${plural(noHoldings.length, "stakeholder")} ${noHoldings.length === 1 ? "has" : "have"} no holdings`}>
          <details>
            <summary>Show them</summary>
            <ul>{noHoldings.map((item) => <li key={item.id}><Link to={href(`stakeholders/${item.id}`)}>{item.displayName}</Link></li>)}</ul>
          </details>
        </Banner>
      ) : null}
      <PageHead
        title="Stakeholders"
        actions={<ActionsMenu items={[{ label: "Add stakeholder", icon: "plus", to: href("stakeholders/new") }, { label: "Download", icon: "download", write: false, onSelect: () => void download() }]} />}
      />
      {notice ? <p className="err-inline" role="alert">{notice}</p> : null}
      <DataTable
        id="stakeholders"
        label="Stakeholders"
        rows={items}
        rowKey={(item) => item.id}
        columns={columns}
        defaultSort={["name", "asc"]}
        filters={filters}
        search={(item) => `${item.displayName} ${item.legalName ?? ""} ${item.issuerAssignedId ?? ""} ${pii.canSeePii ? activeEmails(item).map((email) => email.email).join(" ") : ""}`}
        searchPlaceholder="Search stakeholders…"
        empty="No stakeholders yet."
      />
    </Card>
  );
}
