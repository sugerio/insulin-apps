import type { ReactNode } from "react";
import { useParams } from "react-router";
import type { api } from "#shared";
import { ProgressBar, VestingChart } from "../../components/Charts.tsx";
import { DescriptionList, type DlRow } from "../../components/DescriptionList.tsx";
import { useDisplay } from "../../components/Display.tsx";
import { Badge, Banner, NotFoundState } from "../../components/Feedback.tsx";
import { Card, PageHead, SectionTitle } from "../../components/Page.tsx";
import { Deadline, DocumentCards, PortalLink, PortalPage, PortalResourceView, StatusBadge } from "../../components/PortalParts.tsx";
import { usePortal } from "../../components/PortalWorkspace.tsx";
import { isApiError } from "../../lib/errors.ts";
import { DASH, formatDate } from "../../lib/format.ts";
import { ELECTION_83B_LABELS, TERMINATION_WINDOW_LABELS, periodLabel } from "../../lib/labels.ts";
import { decOf, discountLabel, formatComputedMoney, formatRecordedMoney, isPositive, isoDeadlineState, securityPath, unitOf } from "../../lib/portal.ts";
import { useResource } from "../../lib/useResource.ts";

// A holding's detail page (option, share, warrant, SAFE): only what the allowlisted
// PortalSecurityDetail carries — the holder's own numbers, deadlines, vesting events, the family's own facts and the
// documents linked to the holding. The admin preview shows the same page from the preview route's identical payload.

const SELF_SERVICE_NOTE = "There is no Exercise button yet: self-service exercise requests aren't available in the app.";
const EARLY_EXERCISE = "Early exercise allowed by your grant — contact the company to exercise early.";
const NOT_FOUND = "This holding was not found in your portfolio.";

export function PortalSecurityPage() {
  const portal = usePortal();
  const { securityId = "" } = useParams();
  const detail = useResource((signal) => portal.source.security(securityId, signal), [portal.source.key, securityId]);
  if (detail.data !== undefined) return <SecurityView security={detail.data} />;
  // A 404 for a holding the overview doesn't list is "not yours". For one it lists (it is the holder's own), the 404
  // says the page can't be served, which PortalResourceView handles without claiming anything about access.
  const listed = portal.holdings.some((holding) => holding.securities.some((security) => security.id === securityId));
  if (!listed && isApiError(detail.error, "not_found")) {
    return <PortalPage title="Not found"><NotFoundState message={NOT_FOUND} back={{ to: portal.href(), label: "Back to portfolio" }} /></PortalPage>;
  }
  return <PortalPage title="Holding"><PortalResourceView resource={detail} what="This holding">{() => null}</PortalResourceView></PortalPage>;
}

function SecurityView({ security }: { security: api.PortalSecurityDetail }) {
  const detail = security.detail;
  switch (detail.family) {
    case "EQUITY_COMPENSATION":
      return <OptionView security={security} detail={detail} />;
    case "STOCK":
      return <ShareView security={security} detail={detail} />;
    case "WARRANT":
      return <WarrantView security={security} />;
    case "CONVERTIBLE":
      return <SafeView security={security} detail={detail} />;
  }
}

interface LayoutProps {
  security: api.PortalSecurity;
  title: string;
  badges?: ReactNode;
  actions?: ReactNode;
  banners?: ReactNode;
  children: ReactNode;
}

function Layout({ security, title, badges, actions, banners, children }: LayoutProps) {
  return (
    <PortalPage title={title} crumb={security.displayId}>
      <Card>
        <PageHead title={title} badges={badges ?? <StatusBadge status={security.status} />} actions={actions} />
        {banners}
        <div className="grid-detail">
          <div>{children}</div>
          <div>
            <SectionTitle>Documents</SectionTitle>
            <DocumentCards documents={security.documents} />
          </div>
        </div>
      </Card>
    </PortalPage>
  );
}

/** A link to one of the holder's own lots, found in the overview by its ID; plain text when it isn't there. */
function OwnLot({ displayId }: { displayId: string }) {
  const portal = usePortal();
  const lot = portal.holdings.flatMap((holding) => holding.securities).find((security) => security.displayId === displayId);
  return lot ? <PortalLink to={securityPath(lot)}>{displayId}</PortalLink> : <>{displayId}</>;
}

function joined(items: readonly ReactNode[]): ReactNode {
  return items.map((item, index) => <span key={index}>{index ? ", " : ""}{item}</span>);
}

function OptionView({ security, detail }: { security: api.PortalSecurityDetail; detail: api.PortalOptionDetail }) {
  const { format, today } = useDisplay();
  const { preview } = usePortal();
  const numbers = security.numbers;
  const iso = isoDeadlineState(security, today);
  const isoRow: ReactNode = iso.kind === "upcoming"
    ? <Deadline date={iso.date} note="— exercises after it are taxed as NSOs" />
    : iso.kind === "passed"
      ? <><b>{formatDate(iso.date)}</b> <span className="muted small">— passed: exercises from now on are taxed as NSOs</span></>
      : security.isoDeadline !== null
        ? <Deadline date={security.isoDeadline} />
        : security.optionType === "NSO" ? "— (NSO)" : DASH;
  const deadlineRows: DlRow[] = security.contractualDeadline
    ? [["Contractual deadline", <Deadline date={security.contractualDeadline} />], ["ISO deadline", isoRow]]
    : [];
  const action = preview
    ? <button type="button" className="btn btn-primary" disabled title="Disabled in the preview">How to exercise</button>
    : <PortalLink className="btn btn-primary" to={`how-to-exercise?grant=${security.id}`}>How to exercise</PortalLink>;
  const live = security.status === "OUTSTANDING" && isPositive(numbers.outstanding);
  return (
    <Layout
      security={security}
      title={`${security.displayId} Options`}
      badges={<><StatusBadge status={security.status} />{security.executionPending ? <> <Badge tone="amber">Execution pending</Badge></> : null}</>}
      actions={action}
      banners={
        <>
          {security.executionPending ? <Banner kind="info" title="Awaiting signatures">This grant can be exercised once the agreement is signed by both you and the company.</Banner> : null}
          {detail.earlyExerciseAllowed && live ? <Banner kind="info" title={EARLY_EXERCISE} /> : null}
        </>
      }
    >
      <SectionTitle>Overview</SectionTitle>
      <DescriptionList
        split
        label="Overview"
        rows={[
          ["Granted", numbers.granted === null ? DASH : `${format.shares(numbers.granted)} options`],
          ["Outstanding", format.shares(numbers.outstanding)],
          ["Vested", format.shares(numbers.vested)],
          ["Unvested", format.shares(numbers.unvested)],
          ["Exercised", format.shares(numbers.exercised)],
          ["Exercisable now", <b>{format.shares(numbers.exercisable)}</b>],
          ["Exercise price", format.price(security.exercisePrice)],
          ["Option type", security.optionType ?? DASH],
          ["Expiration date", formatDate(security.expirationDate)],
          ...deadlineRows,
          ["Early exercise allowed", detail.earlyExerciseAllowed ? "Yes — contact the company to exercise early" : "No"],
        ]}
      />
      <SectionTitle>Vesting timeline</SectionTitle>
      <VestingTimeline security={security} />
      {detail.isoSplit.length ? <IsoSplit rows={detail.isoSplit} /> : null}
      <SectionTitle>Post-termination exercise periods</SectionTitle>
      {detail.postTerminationPeriods.length ? (
        <DescriptionList
          split
          label="Post-termination exercise periods"
          rows={detail.postTerminationPeriods.map((window) => [TERMINATION_WINDOW_LABELS[window.reason] ?? window.reason, periodLabel(window)])}
        />
      ) : (
        <p className="muted small">No post-termination periods are recorded for this grant.</p>
      )}
      {detail.exercises.length ? (
        <>
          <SectionTitle>Exercise history</SectionTitle>
          <DescriptionList
            label="Exercise history"
            rows={detail.exercises.map((exercise) => [
              formatDate(exercise.date),
              <>
                {[isPositive(exercise.iso) ? `${format.shares(exercise.iso)} ISO` : null, isPositive(exercise.nso) ? `${format.shares(exercise.nso)} NSO` : null].filter(Boolean).join(" + ") || `${format.shares(exercise.quantity)} options`}
                {exercise.resultingShares.length ? <> → {joined(exercise.resultingShares.map((lot) => <OwnLot key={lot.displayId} displayId={lot.displayId} />))}</> : null}
              </>,
            ])}
          />
        </>
      ) : null}
      {live && !security.executionPending ? <p className="small muted mt-12">{SELF_SERVICE_NOTE}</p> : null}
    </Layout>
  );
}

/** The $100K test's split of this grant by the year its options first become exercisable. */
function IsoSplit({ rows }: { rows: api.PortalOptionDetail["isoSplit"] }) {
  const { format } = useDisplay();
  return (
    <>
      <SectionTitle>ISO/NSO split</SectionTitle>
      <div className="tbl-scroll">
        <table className="tbl dense" aria-label="ISO/NSO split">
          <thead>
            <tr><th scope="col">Year</th><th scope="col" className="num">First exercisable</th><th scope="col" className="num">Value at grant</th><th scope="col" className="num">ISO</th><th scope="col" className="num">NSO</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.year}>
                <td>{row.year}</td>
                <td className="num">{format.shares(row.firstExercisable)}</td>
                <td className="num">{formatComputedMoney(decOf(row.valueAtGrant)).text}</td>
                <td className="num">{format.shares(row.iso)}</td>
                <td className="num">{format.shares(row.nso)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted mt-8">ISOs that first become exercisable in one year are limited to $100,000 (valued at grant); the excess is treated as NSO.</p>
    </>
  );
}

const SHARE_FORMS: Record<api.PortalShareDetail["form"], string> = {
  book_entry: "Book entry",
  migrated_unsigned_certificate: "Unsigned certificate (migrated)",
  uncertificated: "Uncertificated",
};

function election83bLabel(election: api.PortalShareDetail["election83b"]): string {
  if (election === null) return "Not required";
  if (election.status === "FILED" && election.filedOn) return `Filed on ${formatDate(election.filedOn)}`;
  return ELECTION_83B_LABELS[election.status] ?? election.status;
}

function OriginLabel({ origin }: { origin: NonNullable<api.PortalShareDetail["origin"]> }) {
  const kind = origin.kind === "exercise" ? "Exercise" : origin.kind === "conversion" ? "Conversion" : "Transfer";
  if (origin.from === null) return <>{kind}</>;
  return <>{kind} {origin.kind === "transfer" ? "from" : "of"} <OwnLot displayId={origin.from} /></>;
}

function ShareView({ security, detail }: { security: api.PortalSecurityDetail; detail: api.PortalShareDetail }) {
  const { format } = useDisplay();
  const numbers = security.numbers;
  const restricted = security.vesting.length > 0 && isPositive(numbers.unvested);
  return (
    <Layout security={security} title={`${security.displayId} Shares`}>
      <DescriptionList
        split
        label="Overview"
        rows={[
          ["Quantity", numbers.outstanding === null ? DASH : `${format.shares(numbers.outstanding)} shares`],
          ["Class", security.className ?? DASH],
          ["Issue date", formatDate(security.issueDate)],
          ["Price per share", format.price(detail.pricePerShare)],
          ["Form", SHARE_FORMS[detail.form]],
          ["Legends", detail.legends.length ? detail.legends.join(", ") : "None"],
          ["83(b)", election83bLabel(detail.election83b)],
          detail.origin ? ["Origin", <OriginLabel origin={detail.origin} />] : null,
        ]}
      />
      {restricted || detail.repurchase ? (
        <>
          <SectionTitle>Vesting and repurchase</SectionTitle>
          {security.vesting.length ? <p>{format.shares(numbers.vested)} of {format.shares(numbers.granted ?? numbers.outstanding)} shares have vested.</p> : null}
          {detail.repurchase ? <p>{repurchaseSentence(detail.repurchase, numbers.unvested, format)}</p> : null}
          {restricted ? <ProgressBar vested={numbers.vested ?? "0"} unvested={numbers.unvested ?? "0"} cancelled={numbers.cancelled ?? "0"} unit="shares" /> : null}
          {security.vesting.length ? <VestingTimeline security={security} /> : null}
        </>
      ) : null}
    </Layout>
  );
}

type Format = ReturnType<typeof useDisplay>["format"];

/** The company's right to buy back unvested shares, in the holder's terms. */
function repurchaseSentence(repurchase: NonNullable<api.PortalShareDetail["repurchase"]>, unvested: string | null, format: Format): string {
  const price = repurchase.price ? ` at ${format.price(repurchase.price)} per share` : "";
  switch (repurchase.status) {
    case "open":
    case "closing_soon":
      return repurchase.lastDate
        ? `The company may repurchase ${format.shares(unvested)} unvested shares${price} until ${formatDate(repurchase.lastDate)}.`
        : `The company may repurchase ${format.shares(unvested)} unvested shares${price}.`;
    case "lapsed":
      return repurchase.lastDate ? `The company's repurchase window ended on ${formatDate(repurchase.lastDate)}.` : "The company's repurchase window has ended.";
    case "not_recorded":
      return "The repurchase terms aren't recorded here. Contact the company about your unvested shares.";
    case null:
      return `If you leave before these shares vest, the company may buy back the unvested shares${price}${repurchase.window ? ` within ${periodLabel(repurchase.window)}` : ""}.`;
  }
}

function WarrantView({ security }: { security: api.PortalSecurityDetail }) {
  const { format } = useDisplay();
  const contact = usePortal().howTo.data?.companyContact ?? null;
  return (
    <Layout security={security} title={`${security.displayId} Warrant`}>
      <DescriptionList
        split
        label="Overview"
        rows={[
          ["Quantity", format.shares(security.numbers.outstanding)],
          ["Class", security.className ?? DASH],
          ["Exercise price", format.price(security.exercisePrice)],
          ["Expiration", formatDate(security.expirationDate)],
        ]}
      />
      <p className="small muted mt-12">
        Contact the company to exercise{contact ? <>: <span className="email">{contact.email}</span></> : null}.
      </p>
    </Layout>
  );
}

function SafeView({ security, detail }: { security: api.PortalSecurityDetail; detail: api.PortalSafeDetail }) {
  const { format } = useDisplay();
  const lots = security.convertedInto ?? [];
  const converted = security.status === "CONVERTED" && lots.length > 0;
  const links = joined(lots.map((lot) => <OwnLot key={lot.displayId} displayId={lot.displayId} />));
  return (
    <Layout
      security={security}
      title={security.displayId}
      badges={converted ? <Badge tone="blue">Converted to {lots.map((lot) => lot.displayId).join(", ")}</Badge> : <StatusBadge status={security.status} />}
      banners={
        converted ? (
          <Banner kind="info">
            {detail.conversion
              ? <>Converted on {formatDate(detail.conversion.date)} into {links} ({format.shares(detail.conversion.quantity)} {detail.conversion.className}).</>
              : <>Converted into {links}.</>}
          </Banner>
        ) : null
      }
    >
      <DescriptionList
        split
        label="Overview"
        rows={[
          ["Principal", formatRecordedMoney(detail.principal)],
          ["SAFE form (as recorded)", detail.terms.form ?? DASH],
          ["Valuation cap", detail.terms.valuationCap ? formatRecordedMoney(detail.terms.valuationCap) : "Uncapped"],
          ["Discount", detail.terms.discountRate ? discountLabel(detail.terms.discountRate) : "None"],
          ["Issue date", formatDate(security.issueDate)],
        ]}
      />
    </Layout>
  );
}

const STATUS_BADGES: Record<api.PortalVestingEvent["status"], [string, "green" | "grey" | "red"]> = {
  VESTED: ["Vested", "green"],
  UPCOMING: ["Upcoming", "grey"],
  STOPPED: ["Cancelled", "red"],
};

/** The vesting chart and the full schedule ("Vesting timeline: chart and full schedule"). */
function VestingTimeline({ security }: { security: api.PortalSecurity }) {
  const { format, today } = useDisplay();
  const events = [...security.vesting].sort((a, b) => a.date.localeCompare(b.date));
  if (events.length === 0) return <p className="muted small">No vesting schedule on record: {unitOf(security) === "options" ? "these options are" : "these shares are"} fully vested.</p>;
  const total = security.numbers.granted ?? events.at(-1)!.cumulative;
  const start = [security.issueDate, events[0]!.date].sort()[0]!;
  const unit = unitOf(security);
  return (
    <>
      <VestingChart
        events={events.map((event) => ({ date: event.date, cumulative: event.cumulative, active: event.status !== "STOPPED" }))}
        total={total}
        start={start}
        stopDate={null}
        label={`Cumulative vested ${unit} over time for ${security.displayId}`}
      />
      <details className="adv mt-12">
        <summary>Full schedule ({events.length} events)</summary>
        <div className="adv-b tbl-scroll">
          <table className="tbl dense" aria-label="Vesting schedule">
            <thead><tr><th scope="col">Date</th><th scope="col" className="num">Tranche</th><th scope="col" className="num">Cumulative</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {events.map((event, index) => {
                const [label, tone] = event.status === "STOPPED" && event.date > today ? ["Won't vest", "red" as const] : STATUS_BADGES[event.status];
                return (
                  <tr key={`${event.date}-${index}`}>
                    <td>{formatDate(event.date)}</td>
                    <td className="num">{format.shares(event.quantity)}</td>
                    <td className="num">{format.shares(event.cumulative)}</td>
                    <td><Badge tone={tone}>{label}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
