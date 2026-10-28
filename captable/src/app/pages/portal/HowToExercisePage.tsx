import { useSearchParams } from "react-router";
import type { api } from "#shared";
import { DescriptionList, type DlRow } from "../../components/DescriptionList.tsx";
import { useDisplay } from "../../components/Display.tsx";
import { Banner } from "../../components/Feedback.tsx";
import { Card, PageHead, SectionTitle } from "../../components/Page.tsx";
import { DocumentLink, PortalPage, PortalResourceView } from "../../components/PortalParts.tsx";
import { usePortal } from "../../components/PortalWorkspace.tsx";
import { formatDate } from "../../lib/format.ts";
import { exerciseCost, formatComputedMoney, isPositive, isoDeadlineState, paymentReference } from "../../lib/portal.ts";

// How to exercise: the offline process — check what's exercisable, sign counsel's notice, send it to
// the company contact, pay by bank transfer or check quoting a reference — with the company's own instructions and its
// current payment instructions, which are shown only here. There are no self-service exercise requests.

export const NEVER_BANK = "We never send bank details by e-mail. If you receive bank details by e-mail, don't pay — contact us.";

export function HowToExercisePage() {
  const portal = usePortal();
  return (
    <PortalPage title="How to exercise" crumb="How to exercise">
      <Card>
        <PageHead title="How to exercise" />
        <Banner kind="danger" title={NEVER_BANK} />
        <PortalResourceView resource={portal.howTo} what="How to exercise">{(data) => <Process info={data} />}</PortalResourceView>
      </Card>
    </PortalPage>
  );
}

interface Grant {
  security: api.PortalSecurity;
  holderName: string;
}

function Process({ info }: { info: api.HowToExercise }) {
  const portal = usePortal();
  const { format, today } = useDisplay();
  const [params, setParams] = useSearchParams();
  const several = portal.holdings.length > 1;
  const grants: Grant[] = portal.holdings.flatMap((holding) => holding.securities
    .filter((security) => security.family === "EQUITY_COMPENSATION" && security.status === "OUTSTANDING" && isPositive(security.numbers.outstanding))
    .map((security) => ({ security, holderName: holding.stakeholderName })));
  const selected = grants.find((grant) => grant.security.id === params.get("grant"))
    ?? grants.find((grant) => isPositive(grant.security.numbers.exercisable))
    ?? grants[0];
  const grant = selected?.security;
  const exercisable = grant?.numbers.exercisable ?? null;
  // strike × quantity, exact; shown HALF_EVEN to the cent, the named rounding for computed money.
  const cost = grant && exercisable && isPositive(exercisable) && grant.exercisePrice ? formatComputedMoney(exerciseCost(exercisable, grant.exercisePrice)) : null;
  const iso = grant ? isoDeadlineState(grant, today) : null;
  const pay = info.paymentInstructions;
  const contact = info.companyContact;

  return (
    <>
      {grants.length ? (
        <div className="row mt-12">
          <label className="select-line">
            Grant
            <select
              className="inp"
              value={grant?.id}
              aria-label="Choose a grant"
              onChange={(event) => {
                const next = new URLSearchParams(params);
                next.set("grant", event.target.value);
                setParams(next, { replace: true });
              }}
            >
              {grants.map(({ security, holderName }) => (
                <option key={security.id} value={security.id}>
                  {security.displayId}{security.optionType ? ` · ${security.optionType}` : ""}{several ? ` · ${holderName}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p className="muted mt-12">You have no options to exercise.</p>
      )}
      <ol className="howto" aria-label="How to exercise, step by step">
        <li>
          <b>Check your exercisable amount and deadline.</b>
          {grant ? (
            <>
              {" "}{grant.displayId}: <b>{format.shares(exercisable)}</b> options exercisable now at {format.price(grant.exercisePrice)}
              {grant.contractualDeadline ? (
                <>
                  {" "}· contractual deadline <b>{formatDate(grant.contractualDeadline)}</b>
                  {iso?.kind === "upcoming" ? <> · ISO deadline {formatDate(iso.date)}</> : null}
                  {iso?.kind === "passed" ? <> · ISO deadline {formatDate(iso.date)} (passed: exercises from now on are taxed as NSOs)</> : null}
                </>
              ) : <> · expires {formatDate(grant.expirationDate)}</>}
              .{grant.executionPending ? " (Awaiting signatures — not exercisable yet.)" : null}
            </>
          ) : null}
        </li>
        <li>
          <b>Download and sign counsel's notice of exercise.</b>{" "}
          {info.noticeForm ? <DocumentLink document={info.noticeForm} /> : "Ask the company contact for the form."}
        </li>
        <li>
          <b>Send it to the company contact{contact ? ":" : "."}</b>
          {contact ? <> {contact.name}, <span className="email">{contact.email}</span>.</> : null}
        </li>
        <li>
          <b>The equity team confirms the total due.</b> Exercise cost = strike × quantity
          {cost && grant && exercisable ? (
            <>
              {" "}(all {format.shares(exercisable)} exercisable options: {format.shares(exercisable)} × {format.price(grant.exercisePrice)} = <b>{cost.text}</b>
              {cost.rounded ? ", rounded to the cent" : ""})
            </>
          ) : null}
          . For employees and former employees, payroll confirms any tax withholding.
        </li>
        <li>
          <b>Pay by ACH credit or wire</b> to the account below (international payments: use the SWIFT and intermediary details)
          {pay?.checkPayee ? <>, <b>or by check</b></> : null}, quoting your reference.
        </li>
        <li>
          <b>The company records the exercise</b> — the new shares then show in your Portfolio.
        </li>
      </ol>
      {info.text.trim() ? (
        <>
          <SectionTitle>Instructions from {portal.orgName}</SectionTitle>
          <div className="howto-text">{info.text}</div>
        </>
      ) : null}
      <SectionTitle>Payment instructions</SectionTitle>
      {pay ? (
        <>
          <DescriptionList split label="Payment instructions" rows={paymentRows(pay, grant?.displayId ?? null, selected?.holderName ?? "")} />
          <p className="small muted mt-8">These instructions are shown only here, in your holder view, as a company administrator set them. If anything differs from what you expect, contact the company before you pay.</p>
        </>
      ) : (
        <p className="muted">The company hasn't published payment instructions here yet. Contact {contact ? contact.email : "the equity team"} before you pay.</p>
      )}
      <p className="small mt-12">Exercises are requested offline, with the steps above.</p>
    </>
  );
}

/** The active payment instructions, one row per detail the company gave (empty ones are left out). */
function paymentRows(pay: api.PaymentInstructionDetails, grantDisplayId: string | null, holderName: string): DlRow[] {
  return [
    ["Your reference", <b className="mono">{paymentReference(pay.referenceFormat, grantDisplayId, holderName)}</b>],
    ["Bank", pay.bankName],
    ["Beneficiary", pay.beneficiaryName],
    ["Beneficiary address", pay.beneficiaryAddress],
    ["Account number", pay.accountNumber],
    pay.routingNumber ? ["Routing number (ACH and domestic wires)", pay.routingNumber] : null,
    pay.swift ? ["SWIFT", pay.swift] : null,
    pay.iban ? ["IBAN", pay.iban] : null,
    pay.intermediaryBank ? ["Intermediary bank (international wires)", pay.intermediaryBank] : null,
    pay.checkPayee ? ["Checks", `Payable to ${pay.checkPayee}${pay.checkMailingAddress ? `, mailed to ${pay.checkMailingAddress}` : ""}`] : null,
  ];
}
