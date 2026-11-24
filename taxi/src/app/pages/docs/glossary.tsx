import type { ReactNode } from "react";
import { DocLink, anchorId, type DocSection, type DocTopic } from "./parts.tsx";

// Docs › Glossary: the terms the app uses, A–Z, each with an id of its own (anchorId) so other topics can link to it.
// The sections are built from the list: one per first letter.

const TERMS: readonly (readonly [term: string, definition: ReactNode])[] = [
  ["AGI", "Adjusted gross income, on a US return: total income less some deductions, such as half of the self-employment tax and student loan interest. Many credits get smaller as it rises."],
  ["Balance owing", "The tax you still have to pay for the year after what was taken off your pay. In Canada it is due on April 30 of the next year; on a US return it is the amount you owe, due on April 15."],
  ["Common-law partner", <>Someone you live with in a conjugal relationship, generally for at least 12 months in a row or with a child together. See <DocLink to="tax-basics" section="spouses">Spouses and common-law partners</DocLink>.</>],
  ["CRA", "The Canada Revenue Agency, which runs federal income tax and, outside Quebec, collects provincial income tax."],
  ["Credit", "An amount that lowers the tax you pay, such as the credits for donations or medical expenses."],
  ["Deduction", "An amount that lowers the income you are taxed on, such as an RRSP contribution."],
  ["Dependant", "Someone you support, such as a child or a parent who lives with you."],
  ["Earned income credit", "A refundable US credit for people who work and have a low or moderate income, larger with qualifying children."],
  ["FHSA", "A first home savings account: a registered account for saving for a first home. The T4FHSA slip reports it."],
  ["Filing status", <>On a US return: single, married filing jointly or separately, head of household, or qualifying surviving spouse. See <DocLink to="us-tax-basics" section="filing-status">Filing status</DocLink>.</>],
  ["Form 1040", "The US federal income tax return each U.S. citizen or resident files with the IRS for a calendar year."],
  ["Form 1098-T", "The form a college sends for a student: the tuition it was paid and the scholarships it handled. It starts the education expenses for the education credits."],
  ["Form 1099", "A US form a payer sends to report money it paid you other than wages: interest (1099-INT) or pay as a contractor (1099-NEC)."],
  ["Form W-2", "The US form an employer sends to report wages and the tax taken off your pay."],
  ["IRS", "The Internal Revenue Service, which runs US federal income tax."],
  ["Notice of assessment", <>The CRA's answer after it processes a return. See <DocLink to="tax-basics" section="notice-of-assessment">The notice of assessment</DocLink>.</>],
  ["Profile", "In Taxi: you, your spouse or partner, and the children and other dependants who live with you. The same people every year."],
  ["Refund", "Money the CRA or the IRS pays back when more tax was taken off your pay than you owe."],
  ["RRSP", "A registered retirement savings plan. Contributions can be deducted, up to your RRSP deduction limit."],
  ["SIN", "Your social insurance number. Taxi never asks for it and none of its fields holds it: you write it on the paper return. An uploaded slip keeps it as printed."],
  ["Slip", "A form an employer, bank or other payer sends to report income or amounts paid, such as a T4 or a T5. Taxi also calls the US forms (W-2, 1099, 1098) slips."],
  ["SSN", "A US social security number. Taxi never asks for it and none of its fields holds it: you write it on the paper return. An uploaded form keeps it as printed."],
  ["Standard deduction", <>The amount a US return deducts from income without listing deductions. See <DocLink to="us-tax-basics" section="standard-deduction">The standard deduction</DocLink>.</>],
  ["T1", "The income tax and benefit return each person files every year."],
  ["T4", "The slip that reports employment income and the tax, CPP and EI taken off your pay."],
  ["T5", "The slip that reports interest and dividends."],
  ["Tax year", "The calendar year a return covers, January 1 to December 31."],
];

function sections(): DocSection[] {
  const byLetter = new Map<string, (typeof TERMS)[number][]>();
  for (const entry of TERMS) {
    const letter = entry[0][0]!.toUpperCase();
    byLetter.set(letter, [...(byLetter.get(letter) ?? []), entry]);
  }
  return [...byLetter].map(([letter, entries]) => ({
    id: `letter-${letter.toLowerCase()}`,
    title: letter,
    body: (
      <dl className="flex flex-col gap-3">
        {entries.map(([term, definition]) => (
          <div key={term}>
            <dt id={anchorId(term)} tabIndex={-1} className="font-semibold text-foreground">
              {term}
            </dt>
            <dd className="mt-0.5">{definition}</dd>
          </div>
        ))}
      </dl>
    ),
  }));
}

export const glossary: DocTopic = {
  slug: "glossary",
  title: "Glossary",
  summary: "The tax terms the app uses, A to Z.",
  group: "tax",
  generalInformation: true,
  compactContents: true,
  sections: sections(),
};
