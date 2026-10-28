import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { ActionsMenu, WriteButton } from "../components/Actions.tsx";
import { DataTable, byDecimal, byDisplayId, byText } from "../components/DataTable.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { Attachments, useDownload } from "../components/Documents.tsx";
import { valuationLinkIntent } from "../components/flows/DocumentDialogs.tsx";
import { Badge, Banner, Pending, ResourceView } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { LinkTabs } from "../components/LinkTabs.tsx";
import { HolderLink, SecurityLink } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead, SectionTitle } from "../components/Page.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { ClearReviewDialog, FlagMaterialEventDialog, ReverseValuationEventDialog, VoidValuationDialog } from "../components/flows/ValuationDialogs.tsx";
import { compareDecimals } from "../lib/decimal.ts";
import { DASH, daysBetween, formatDate } from "../lib/format.ts";
import { VALUATION_STATUS_LABELS, VALUATION_STATUS_TONES } from "../lib/labels.ts";
import { allOf, useResource, type Resource } from "../lib/useResource.ts";
import { classPrice, counts409A, currentValuation, materialEvents, openMaterialEvents, type Resolution } from "../lib/valuations.ts";

// Compliance & Tax › 409A Valuations: the expiry banner, the valuations with their computed
// status (CX-9), the material events, and a valuation's FMV, status history, documents and the grants priced with
// it. The app records the provider's reports; it never performs a valuation. Record FMV opens its page; flagging a
// material event, the written confirmation, reversing a flag and voiding open their dialogs.

type ValuationDialog =
  | { kind: "flag" }
  | { kind: "clear"; valuation: api.Valuation }
  | { kind: "reverseEvent"; valuation: api.Valuation; event: api.ValuationEvent };

/**
 * "Presumptively valid — 15 days left" for one that expires soon. Only a final 409A has a
 * 409A status: another valuation, or a 409A whose report is a draft, says what it is instead.
 */
export function valuationLabel(valuation: api.Valuation, today: string): string {
  if (valuation.status === "voided") return VALUATION_STATUS_LABELS.voided;
  if (valuation.valuationType !== "409A") return "Not a 409A — never in effect for grants";
  if (valuation.reportVersion !== "FINAL") return "Draft report — not in effect";
  if (valuation.status === "expiring_soon" && valuation.presumptivelyValidUntil) {
    const days = daysBetween(today, valuation.presumptivelyValidUntil);
    return `Presumptively valid — ${days} day${days === 1 ? "" : "s"} left`;
  }
  return VALUATION_STATUS_LABELS[valuation.status];
}

/** The badge tone: a 409A's status, or grey for what never counts as the 409A in effect. */
export function valuationTone(valuation: api.Valuation): (typeof VALUATION_STATUS_TONES)[api.ValuationStatus] {
  return counts409A(valuation) || valuation.status === "voided" ? VALUATION_STATUS_TONES[valuation.status] : "grey";
}

function resolutionLabel(resolution: Resolution): string {
  switch (resolution.kind) {
    case "confirmation": return `Written confirmation (${formatDate(resolution.date)})`;
    case "valuation": return `New valuation (${formatDate(resolution.date)})`;
    case "voided": return `Valuation voided (${formatDate(resolution.date)})`;
  }
}

function ValuationBanner({ valuations }: { valuations: readonly api.Valuation[] }) {
  const { today } = useWorkspace();
  const current = currentValuation(valuations, today);
  if (!current) return <Banner kind="danger" title="No 409A recorded">Record the provider's report before granting options.</Banner>;
  if (current.status === "review_required") {
    const event = openMaterialEvents(current, valuations, today)[0] ?? null;
    return (
      <Banner kind="danger" title={`${current.name} needs review — material event on ${formatDate(event?.eventDate)}`}>
        {event ? `"${event.description}". ` : ""}New grants are blocked until a new valuation is recorded, or an admin records the provider's or counsel's written confirmation.
      </Banner>
    );
  }
  if (current.status === "expired") {
    return <Banner kind="danger" title={`The current 409A expired on ${formatDate(current.expirationDate)}`}>New grants are blocked until the new provider's report is recorded.</Banner>;
  }
  if (current.status === "expiring_soon" && current.presumptivelyValidUntil) {
    return (
      <Banner kind="warn" title={`The current 409A (${formatDate(current.effectiveDate)}) is presumptively valid until ${formatDate(current.presumptivelyValidUntil)} — ${daysBetween(today, current.presumptivelyValidUntil)} days left`}>
        New grants after that date need a new valuation.
      </Banner>
    );
  }
  return null;
}

function useClasses() {
  const { orgId } = useWorkspace();
  return useResource((signal) => apiRequest(api.routes.listStockClasses, { params: { orgId }, signal }), [orgId]);
}

/** The common FMV of a valuation, once the share classes are known (never guessed from the order of the prices). */
function CommonPrice({ valuation, classes }: { valuation: api.Valuation; classes: Resource<api.StockClassList> }) {
  const { format } = useWorkspace();
  return (
    <Pending resource={classes} what="the share classes" inline>
      {(data) => {
        const price = classPrice(valuation, data.items);
        return (
          <>
            {price ? format.price(price) : <span className="muted">Not valued</span>}
            {valuation.prices.length > 1 ? <div className="small muted">+{valuation.prices.length - 1} more class{valuation.prices.length > 2 ? "es" : ""}</div> : null}
          </>
        );
      }}
    </Pending>
  );
}

function ReportButton({ documentId, name }: { documentId: string; name: string }) {
  const { download, error } = useDownload();
  return (
    <>
      <button type="button" className="btn btn-ghost btn-xs btn-icon" aria-label={`Download the report of ${name}`} title="Download report" onClick={() => void download(documentId, `${name}.pdf`)}>
        <Icon name="file" />
      </button>
      {error ? <div className="err-inline" role="alert">{error}</div> : null}
    </>
  );
}

export function ValuationsPage() {
  const { orgId, format, href, today } = useWorkspace();
  const valuations = useResource((signal) => apiRequest(api.routes.listValuations, { params: { orgId }, signal }), [orgId]);
  const classes = useClasses();
  const current = valuations.data ? currentValuation(valuations.data.items, today) : null;
  const [dialog, setDialog] = useState<ValuationDialog | null>(null);
  const done = () => {
    setDialog(null);
    valuations.reload();
  };
  return (
    <Page title="Compliance & Tax" crumbs={[["Compliance & Tax"]]}>
      <Card>
        <PageHead
          title="Compliance & Tax"
          actions={
            <>
              <WriteButton label="Flag a material event" icon="alert" onClick={() => setDialog({ kind: "flag" })} />
              {current?.status === "review_required" ? <WriteButton label="Record written confirmation" onClick={() => setDialog({ kind: "clear", valuation: current })} /> : null}
              <WriteButton label="Record FMV" kind="primary" to={href("compliance/409a/new")} />
            </>
          }
        />
        <LinkTabs label="Compliance and tax" selected="409a" tabs={[{ id: "409a", label: "409A Valuations", to: href("compliance/409a") }]} />
        <ResourceView resource={valuations}>
          {(data) => {
            const events = data.items.flatMap((valuation) => materialEvents(valuation, data.items, today).map((state) => ({ ...state, valuation })));
            return (
              <>
                <ValuationBanner valuations={data.items} />
                <p className="muted">
                  Record the independent provider's report here. A valuation is presumptively valid from its effective date until its expiration date, unless a material event is flagged after it. In-app reminders show at 60, 30, 7 and 0 days.
                </p>
                <DataTable
                  id="valuations"
                  label="409A valuations"
                  rows={data.items}
                  rowKey={(valuation) => valuation.id}
                  toolbar={false}
                  paginate={false}
                  defaultSort={["effective", "desc"]}
                  empty="No 409A valuations recorded yet."
                  columns={[
                    {
                      key: "name", label: "Valuation", compare: byText((valuation) => valuation.name),
                      render: (valuation) => (
                        <>
                          <Link className="cell-link" to={href(`compliance/409a/${valuation.id}`)}>{valuation.name}</Link>
                          {valuation.valuationType !== "409A" ? <> <Badge>Other valuation</Badge></> : valuation.reportVersion !== "FINAL" ? <> <Badge>Draft</Badge></> : null}
                        </>
                      ),
                    },
                    { key: "provider", label: "Provider", render: (valuation) => valuation.provider ?? DASH, compare: byText((valuation) => valuation.provider) },
                    { key: "effective", label: "Effective date", render: (valuation) => formatDate(valuation.effectiveDate), compare: byText((valuation) => valuation.effectiveDate) },
                    { key: "expiration", label: "Expiration date", render: (valuation) => formatDate(valuation.expirationDate), compare: byText((valuation) => valuation.expirationDate) },
                    {
                      key: "fmv", label: "FMV common", numeric: true,
                      render: (valuation) => <CommonPrice valuation={valuation} classes={classes} />,
                      compare: byDecimal((valuation) => (classes.data ? classPrice(valuation, classes.data.items) : null)),
                    },
                    { key: "status", label: "Status", render: (valuation) => <Badge tone={valuationTone(valuation)}>{valuationLabel(valuation, today)}</Badge>, compare: byText((valuation) => valuationLabel(valuation, today)) },
                    { key: "report", label: "Report", render: (valuation) => (valuation.reportDocumentId ? <ReportButton documentId={valuation.reportDocumentId} name={valuation.name} /> : DASH) },
                  ]}
                />
                {events.length ? (
                  <>
                    <SectionTitle>Material events</SectionTitle>
                    <div className="tbl-scroll">
                      <table className="tbl" aria-label="Material events">
                        <thead><tr><th scope="col">Date</th><th scope="col">Event</th><th scope="col">Flagged by</th><th scope="col">Resolved</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                        <tbody>
                          {events.map(({ event, resolution, valuation }) => (
                            <tr key={event.id}>
                              <td>{formatDate(event.eventDate)}</td>
                              <td>{event.description}</td>
                              <td>{event.createdBy} · {format.dateTime(event.createdAt)}</td>
                              <td>{resolution ? resolutionLabel(resolution) : <Badge tone="red">Open — review required</Badge>}</td>
                              <td className="right">
                                <WriteButton label="Reverse" size="xs" ariaLabel={`Reverse the material event “${event.description}”`} onClick={() => setDialog({ kind: "reverseEvent", valuation, event })} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </>
            );
          }}
        </ResourceView>
      </Card>
      {dialog?.kind === "flag" ? <FlagMaterialEventDialog onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "clear" ? <ClearReviewDialog valuation={dialog.valuation} onClose={() => setDialog(null)} onDone={done} /> : null}
      {dialog?.kind === "reverseEvent" ? <ReverseValuationEventDialog valuation={dialog.valuation} event={dialog.event} onClose={() => setDialog(null)} onDone={done} /> : null}
    </Page>
  );
}

export function ValuationPage() {
  const { orgId, href } = useWorkspace();
  const { valuationId = "" } = useParams();
  const valuation = useResource((signal) => apiRequest(api.routes.getValuation, { params: { orgId, id: valuationId }, signal }), [orgId, valuationId]);
  const title = valuation.data?.name ?? "Valuation";
  return (
    <Page title={title} crumbs={[["Compliance & Tax", href("compliance/409a")], [title]]}>
      <ResourceView resource={valuation} notFound="This valuation does not exist.">{(data) => <ValuationBody valuation={data} onChanged={valuation.reload} />}</ResourceView>
    </Page>
  );
}

const EVENT_TEXT: Record<api.ValuationEvent["kind"], string> = {
  MATERIAL_EVENT: "Review required",
  REVIEW_CLEARED: "Review cleared",
  VOIDED: "Voided",
  EVENT_REVERSED: "Material event reversed",
};

/** Events on a valuation that never counts (another type, a draft): recorded, but they change no status. */
const NO_EFFECT_TEXT: Record<api.ValuationEvent["kind"], string> = {
  MATERIAL_EVENT: "Material event recorded (no effect: not a final 409A)",
  REVIEW_CLEARED: "Confirmation recorded (no effect: not a final 409A)",
  VOIDED: "Voided",
  EVENT_REVERSED: "Material event reversed",
};

function ValuationBody({ valuation, onChanged }: { valuation: api.ValuationDetail; onChanged: () => void }) {
  const { orgId, format, today, org } = useWorkspace();
  const [voiding, setVoiding] = useState(false);
  const classes = useClasses();
  const stakeholders = useResource((signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }), [orgId], valuation.grants.length > 0);
  // Only a final 409A is presumptively valid, takes a material event, prices grants, is superseded or expires; anything
  // else is shown as what it is, with its events recorded but without effect.
  const counting = counts409A(valuation);
  const eventText = (event: api.ValuationEvent) => (counting || event.kind === "VOIDED" ? EVENT_TEXT[event.kind] : NO_EFFECT_TEXT[event.kind]);
  const history = [
    { key: "effective", date: valuation.effectiveDate, text: counting ? "Presumptively valid" : valuation.valuationType !== "409A" ? "Effective (not a 409A)" : "Draft report (not in effect)" },
    ...valuation.events.map((event) => ({ key: event.id, date: event.eventDate, text: `${eventText(event)} — ${event.description}` })),
    counting && valuation.status === "superseded" ? { key: "superseded", date: null, text: "Superseded by a later valuation" } : null,
    counting && valuation.expirationDate ? { key: "expires", date: valuation.expirationDate, text: valuation.expirationDate <= today ? "Expired" : "Expires" } : null,
  ].filter((item) => item !== null);
  return (
    <Card>
      <PageHead
        title={valuation.name}
        after={<Badge tone={valuationTone(valuation)}>{valuationLabel(valuation, today)}</Badge>}
        actions={valuation.status === "voided" ? null : <ActionsMenu items={[{ label: "Void valuation", icon: "x", danger: true, onSelect: () => setVoiding(true) }]} />}
      />
      {voiding ? <VoidValuationDialog valuation={valuation} onClose={() => setVoiding(false)} onDone={() => { setVoiding(false); onChanged(); }} /> : null}
      {!counting && valuation.status !== "voided" ? (
        <Banner kind="info" title={valuation.valuationType !== "409A" ? "Not a 409A valuation" : "A draft 409A report"}>
          It never counts as the 409A in effect: it doesn't price grants or exercises, supersede a 409A or take a material event.
        </Banner>
      ) : null}
      <SectionTitle>FMV</SectionTitle>
      <Pending resource={classes} what="the share classes">
        {(data) => (
          <DescriptionList
            label="FMV per class"
            rows={data.items.map((item) => {
              const price = classPrice(valuation, data.items, item.id);
              return [item.name, price ? format.price(price) : <span className="muted">Not valued</span>] as const;
            })}
          />
        )}
      </Pending>
      <SectionTitle>Summary</SectionTitle>
      <DescriptionList
        rows={[
          ["Provider", valuation.provider ?? DASH],
          ["Effective date", formatDate(valuation.effectiveDate)],
          ["Expiration date", formatDate(valuation.expirationDate)],
          counting ? ["Presumptively valid until", formatDate(valuation.presumptivelyValidUntil)] : null,
          ["Board adoption", formatDate(valuation.boardApprovalDate)],
          ["Report version", valuation.reportVersion === "FINAL" ? "Final" : "Draft"],
          valuation.importedFromPulley ? ["Source", api.importSourceLabel(org.importSource)] : null,
        ]}
      />
      <SectionTitle>Status history</SectionTitle>
      <Timeline label="Status history" items={history.map((item) => ({ key: item.key, title: item.text, meta: item.date ? formatDate(item.date) : "" }))} />
      <SectionTitle>Documents</SectionTitle>
      <Attachments documents={valuation.documents} link={valuationLinkIntent(valuation)} onUploaded={onChanged} />
      <SectionTitle>{counting ? "Grants priced with this valuation" : "Grants that name this valuation"} ({valuation.grants.length})</SectionTitle>
      {!counting && valuation.grants.length ? <p className="small muted">It never priced them: only a final 409A prices a grant. They name it in the imported records.</p> : null}
      {valuation.grants.length === 0 ? (
        <p className="muted">{counting ? "No grants were priced with this valuation." : "No grants name this valuation."}</p>
      ) : (
        // The strike is compared with the FMV of the grant's own class (common unless the grant says otherwise), so
        // the comparison waits for the class lookup instead of guessing which price is common.
        <Pending resource={allOf(classes, stakeholders)} what="the share classes and holders">
          {([classList, holders]) => {
            const names = new Map(holders.items.map((item) => [item.id, item.displayName]));
            return (
              <DataTable
                id="valuation-grants"
                label={counting ? "Grants priced with this valuation" : "Grants that name this valuation"}
                rows={valuation.grants}
                rowKey={(grant) => grant.securityId}
                toolbar={false}
                defaultSort={["id", "asc"]}
                empty="No grants were priced with this valuation."
                columns={[
                  { key: "id", label: "ID", render: (grant) => <SecurityLink id={grant.securityId} family="EQUITY_COMPENSATION" displayId={grant.displayId} />, compare: byDisplayId((grant) => grant.displayId) },
                  { key: "holder", label: "Holder", render: (grant) => <HolderLink id={grant.stakeholderId} name={names.get(grant.stakeholderId) ?? DASH} /> },
                  { key: "date", label: "Grant date", render: (grant) => formatDate(grant.grantDate), compare: byText((grant) => grant.grantDate) },
                  { key: "strike", label: "Strike", numeric: true, render: (grant) => format.price(grant.exercisePrice), compare: byDecimal((grant) => grant.exercisePrice) },
                  // A strike is checked against a final 409A's FMV only: another valuation's price is no FMV for grants.
                  ...(counting ? [
                    { key: "fmv", label: "FMV", numeric: true, render: (grant: api.ValuationDetail["grants"][number]) => { const fmv = classPrice(valuation, classList.items, grant.stockClassId); return fmv ? format.price(fmv) : <span className="muted">Not valued</span>; } },
                    {
                      key: "ok", label: "Strike ≥ FMV",
                      render: (grant: api.ValuationDetail["grants"][number]) => {
                        const fmv = classPrice(valuation, classList.items, grant.stockClassId);
                        return fmv === null ? DASH : compareDecimals(grant.exercisePrice, fmv) >= 0 ? <Badge tone="green">Yes</Badge> : <Badge tone="red">No</Badge>;
                      },
                    },
                  ] : []),
                ]}
              />
            );
          }}
        </Pending>
      )}
    </Card>
  );
}
