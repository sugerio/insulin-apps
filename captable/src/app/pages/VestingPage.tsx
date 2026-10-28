import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { DataTable, byNumber, byText } from "../components/DataTable.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { Badge, InlineError, ResourceView } from "../components/Feedback.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead, SectionTitle } from "../components/Page.tsx";
import { formatFractionPercent } from "../lib/decimal.ts";
import { DASH, formatDate } from "../lib/format.ts";
import { FREQUENCY_LABELS } from "../lib/labels.ts";
import { useResource } from "../lib/useResource.ts";

// Vesting, view only: the schedule library with Pulley's columns, and a schedule's
// normalized definition with a preview for 10,000 shares from the tranche generator.

const PERIOD_MONTHS = { MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12 } as const;
const PERIOD_WORD = { MONTHLY: "month", QUARTERLY: "quarter", ANNUALLY: "year" } as const;
const PREVIEW_QUANTITY = "10000";

function percent(num: number, den: number): string {
  return formatFractionPercent({ num: BigInt(num), den: BigInt(den) }).replace(/\.00%$/, "%");
}

/** "2.08% per month after a 25% cliff", "Explicit tranches". */
export function vestingPercentage(definition: api.VestingDefinition): string {
  if (definition.type === "EXPLICIT") return "Explicit tranches (from the agreement)";
  const period = PERIOD_MONTHS[definition.frequency];
  const each = percent(period, definition.totalMonths);
  const cliff = definition.cliff
    ? typeof definition.cliff.quantityRule === "object" ? " after an explicit cliff" : ` after a ${percent(definition.cliff.months, definition.totalMonths)} cliff`
    : "";
  return `${each} per ${PERIOD_WORD[definition.frequency]}${cliff}`;
}

export function vestingOccurs(definition: api.VestingDefinition): string {
  return definition.type === "EXPLICIT" ? "Custom" : FREQUENCY_LABELS[definition.frequency] ?? definition.frequency;
}

/** "48 months, monthly, 12-month cliff". */
export function normalizedTemplate(definition: api.VestingDefinition): string {
  if (definition.type === "EXPLICIT") return `${definition.events.length} explicit tranche${definition.events.length === 1 ? "" : "s"}`;
  return `${definition.totalMonths} months, ${vestingOccurs(definition).toLowerCase()}${definition.cliff ? `, ${definition.cliff.months}-month cliff` : ", no cliff"}`;
}

function confirmedLabel(terms: api.VestingTerms, localDate: (ms: number) => string): string {
  return terms.confirmedBy ? `${terms.confirmedBy}${terms.confirmedAt ? ` · ${formatDate(localDate(terms.confirmedAt))}` : ""}` : terms.importedFromPulley ? "Not confirmed yet" : DASH;
}

export function VestingPage() {
  const { orgId, format, href } = useWorkspace();
  const schedules = useResource((signal) => apiRequest(api.routes.listVestingTerms, { params: { orgId }, query: { templates: "true" }, signal }), [orgId]);
  return (
    <Page title="Vesting" crumbs={[["Cap Table", href("captable")], ["Vesting"]]}>
      <Card>
        <PageHead title="Vesting" sub="View only. New grants use these templates or explicit tranches from the signed agreement." />
      </Card>
      <Card title="Vesting Schedules">
        <ResourceView resource={schedules}>
          {(data) => (
            <DataTable
              id="vesting-schedules"
              label="Vesting schedules"
              rows={data.items.filter((terms) => terms.isTemplate)}
              rowKey={(terms) => terms.id}
              paginate={false}
              search={(terms) => terms.name}
              empty="No vesting schedules yet."
              columns={[
                { key: "name", label: "Name", render: (terms) => <Link className="cell-link" to={href(`vesting/schedules/${terms.id}`)}>{terms.name}</Link>, compare: byText((terms) => terms.name) },
                { key: "pct", label: "Vesting Percentage", render: (terms) => vestingPercentage(terms.definition) },
                { key: "cliff", label: "Cliff (months)", numeric: true, render: (terms) => (terms.definition.type === "SCHEDULE" && terms.definition.cliff ? String(terms.definition.cliff.months) : DASH), compare: byNumber((terms) => (terms.definition.type === "SCHEDULE" ? terms.definition.cliff?.months : null)) },
                { key: "occurs", label: "Vesting Occurs", render: (terms) => vestingOccurs(terms.definition) },
                { key: "duration", label: "Duration", defaultHidden: true, render: (terms) => (terms.definition.type === "SCHEDULE" ? `${terms.definition.totalMonths} months` : DASH) },
                { key: "use", label: "Grants using it", numeric: true, defaultHidden: true, render: (terms) => String(terms.grantsUsing), compare: byNumber((terms) => terms.grantsUsing) },
                { key: "norm", label: "Normalized template", defaultHidden: true, render: (terms) => normalizedTemplate(terms.definition) },
                { key: "conf", label: "Confirmed by", defaultHidden: true, render: (terms) => confirmedLabel(terms, format.localDate) },
              ]}
            />
          )}
        </ResourceView>
      </Card>
      <Card>
        <p className="small muted">
          Acceleration terms stay on each grant as data (for example "Double trigger 100% — qualifying termination within 12 months after a change of control"). There is no milestone or pause vesting: termination stops vesting on the stop date, shown as <b>Stopped</b>.
        </p>
      </Card>
    </Page>
  );
}

export function VestingSchedulePage() {
  const { orgId, href } = useWorkspace();
  const { scheduleId = "" } = useParams();
  const terms = useResource((signal) => apiRequest(api.routes.getVestingTerms, { params: { orgId, id: scheduleId }, signal }), [orgId, scheduleId]);
  const title = terms.data?.name ?? "Vesting schedule";
  return (
    <Page title={title} crumbs={[["Vesting", href("vesting")], [title]]}>
      <ResourceView resource={terms} notFound="This vesting schedule does not exist.">{(data) => <ScheduleBody terms={data} />}</ResourceView>
    </Page>
  );
}

function ScheduleBody({ terms }: { terms: api.VestingTerms }) {
  const { orgId, format, today } = useWorkspace();
  const [start, setStart] = useState(today);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(start);
  const preview = useResource(
    (signal) => apiRequest(api.routes.previewVesting, { params: { orgId }, body: { definition: terms.definition, quantity: PREVIEW_QUANTITY, vestingStartDate: start }, signal }),
    [orgId, terms.id, start],
    valid && terms.definition.type === "SCHEDULE",
  );
  const definition = terms.definition;
  return (
    <Card>
      <PageHead title={terms.name} />
      <DescriptionList
        rows={[
          ["Normalized definition", normalizedTemplate(definition)],
          ["Vesting percentage", vestingPercentage(definition)],
          ["Cliff", definition.type === "SCHEDULE" && definition.cliff ? `${definition.cliff.months} months (${percent(definition.cliff.months, definition.totalMonths)})` : "None"],
          ["Grants using it", String(terms.grantsUsing)],
          ["Confirmed by", confirmedLabel(terms, format.localDate)],
        ]}
      />
      {definition.type === "SCHEDULE" ? (
        <>
          <SectionTitle>Preview for 10,000 shares</SectionTitle>
          <label className="asof">
            Start date
            <input type="date" className="inp" value={start} onChange={(event) => setStart(event.target.value)} />
          </label>
          {preview.data ? (
            <div className="tbl-scroll mt-8" style={{ maxHeight: 340, overflow: "auto" }}>
              <table className="tbl dense" aria-label="Vesting preview">
                <thead><tr><th scope="col">Date</th><th scope="col" className="num">Tranche</th><th scope="col" className="num">Cumulative</th></tr></thead>
                <tbody>
                  {preview.data.events.map((event, index) => (
                    <tr key={`${event.date}-${index}`}>
                      <td>{formatDate(event.date)}{event.kind === "CLIFF" ? <> <Badge tone="teal">Cliff</Badge></> : null}</td>
                      <td className="num">{format.shares(event.quantity)}</td>
                      <td className="num">{format.shares(event.cumulative)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !valid ? (
            <p className="muted small">Enter a start date to preview the tranches.</p>
          ) : preview.error !== undefined ? (
            <InlineError what="the preview" error={preview.error} onRetry={preview.reload} />
          ) : (
            <p className="muted small" role="status">Computing the preview…</p>
          )}
          <p className="small muted mt-8">Tranches fall on the start day of month (clamped to the month end); cumulative-floor rounding; the final tranche absorbs remainders.</p>
        </>
      ) : (
        <>
          <SectionTitle>Tranches</SectionTitle>
          <div className="tbl-scroll">
            <table className="tbl dense" aria-label="Tranches">
              <thead><tr><th scope="col">Date</th><th scope="col" className="num">Quantity</th></tr></thead>
              <tbody>{definition.events.map((event, index) => <tr key={index}><td>{formatDate(event.date)}</td><td className="num">{format.shares(event.quantity)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
