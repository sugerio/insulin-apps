import type { ReactNode } from "react";
import { DocLink, anchorId, type DocSection, type DocTopic } from "./parts.tsx";

// Docs › Glossary: the terms the app uses, A–Z, each with an id of its own (anchorId) so other topics can link to it.
// The sections are built from the list: one per first letter.

const TERMS: readonly (readonly [term: string, definition: ReactNode])[] = [
  ["Balance owing", "The tax you still have to pay for the year after what was taken off your pay. It is due on April 30 of the next year."],
  ["Common-law partner", <>Someone you live with in a conjugal relationship, generally for at least 12 months in a row or with a child together. See <DocLink to="tax-basics" section="spouses">Spouses and common-law partners</DocLink>.</>],
  ["CRA", "The Canada Revenue Agency, which runs federal income tax and, outside Quebec, collects provincial income tax."],
  ["Credit", "An amount that lowers the tax you pay, such as the credits for donations or medical expenses."],
  ["Deduction", "An amount that lowers the income you are taxed on, such as an RRSP contribution."],
  ["Dependant", "Someone you support, such as a child or a parent who lives with you."],
  ["FHSA", "A first home savings account: a registered account for saving for a first home. The T4FHSA slip reports it."],
  ["Profile", "In Taxi: you, your spouse or partner, and the children and other dependants who live with you. The same people every year."],
  ["Notice of assessment", <>The CRA's answer after it processes a return. See <DocLink to="tax-basics" section="notice-of-assessment">The notice of assessment</DocLink>.</>],
  ["Refund", "Money the CRA pays back when more tax was taken off your pay than you owe."],
  ["RRSP", "A registered retirement savings plan. Contributions can be deducted, up to your RRSP deduction limit."],
  ["SIN", "Your social insurance number. Taxi never asks for it or stores it: you write it on the paper return."],
  ["Slip", "A form an employer, bank or other payer sends to report income or amounts paid, such as a T4 or a T5."],
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
