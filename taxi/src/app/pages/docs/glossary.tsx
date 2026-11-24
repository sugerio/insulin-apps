import type { ReactNode } from "react";
import { DocLink, anchorId, type DocSection, type DocTopic } from "./parts.tsx";

// Docs › Glossary: the terms the app uses, A–Z, each with an id of its own (anchorId) so other topics can link to it.
// The sections are built from the list: one per first letter.

const TERMS: readonly (readonly [term: string, definition: ReactNode])[] = [
  ["AGI", "Adjusted gross income, on a US return: total income less some deductions, such as half of the self-employment tax and student loan interest. Many credits get smaller as it rises."],
  ["AMT", <>The US alternative minimum tax: a second way of working out the tax, with fewer deductions. See <DocLink to="us-tax-basics" section="capital-gains">Capital gains and the alternative minimum tax</DocLink>.</>],
  ["Balance owing", "The tax you still have to pay for the year after what was taken off your pay. In Canada it is due on April 30 of the next year; on a US return it is the amount you owe, due on April 15."],
  ["CalEITC", "The California earned income tax credit: a refundable credit for workers with earned income under $32,901 (form FTB 3514). It comes with the Young Child Tax Credit for a child under 6."],
  ["Capital gain", "The profit when you sell something, such as shares, for more than it cost. On a US return, a long-term gain is taxed at a lower rate."],
  ["Common-law partner", <>Someone you live with in a conjugal relationship, generally for at least 12 months in a row or with a child together. See <DocLink to="tax-basics" section="spouses">Spouses and common-law partners</DocLink>.</>],
  ["CRA", "The Canada Revenue Agency, which runs federal income tax and, outside Quebec, collects provincial income tax."],
  ["Credit", "An amount that lowers the tax you pay, such as the credits for donations or medical expenses."],
  ["Deduction", "An amount that lowers the income you are taxed on, such as an RRSP contribution."],
  ["Dependant", "Someone you support, such as a child or a parent who lives with you."],
  ["Earned income credit", "A refundable US credit for people who work and have a low or moderate income, larger with qualifying children."],
  ["Empire State child credit", "A refundable New York credit for each child under 17 ($1,000 under 4, $330 from 4 to 16), smaller at a high income (Form IT-213)."],
  ["Exemption credit", "On California's Form 540: an amount taken off the tax for each person ($153), blind or senior person ($153 more) and dependent ($475), smaller at a high income."],
  ["FHSA", "A first home savings account: a registered account for saving for a first home. The T4FHSA slip reports it."],
  ["Filing status", <>On a US return: single, married filing jointly or separately, head of household, or qualifying surviving spouse. See <DocLink to="us-tax-basics" section="filing-status">Filing status</DocLink>.</>],
  ["Form 1040", "The US federal income tax return each U.S. citizen or resident files with the IRS for a calendar year."],
  ["Form 540", "California's resident income tax return, filed with the Franchise Tax Board (FTB). It starts from the federal AGI."],
  ["Form 1098-T", "The form a college sends for a student: the tuition it was paid and the scholarships it handled. It starts the education expenses for the education credits."],
  ["Form 1099", "A US form a payer sends to report money it paid you other than wages: interest (1099-INT) or pay as a contractor (1099-NEC)."],
  ["Form IT-201", "New York State's resident income tax return, filed with the Department of Taxation and Finance. It starts from the federal AGI, and has the New York City and Yonkers taxes on it."],
  ["Form IT-2", "The form that lists each W-2 on a New York return, instead of sending the W-2s."],
  ["Form W-2", "The US form an employer sends to report wages and the tax taken off your pay."],
  ["HSA", "A US health savings account, for people with a high-deductible health plan. Contributions are deducted (Form 8889)."],
  ["IRA", "A US individual retirement arrangement. Contributions to a traditional IRA can be deducted; money taken out is taxed (Form 1099-R)."],
  ["IRS", "The Internal Revenue Service, which runs US federal income tax."],
  ["Itemized deductions", "On a US return, the expenses listed on Schedule A (mortgage interest, state and local taxes, gifts, medical expenses), taken instead of the standard deduction when larger."],
  ["MCTMT", "The metropolitan commuter transportation mobility tax: a New York tax on self-employment earnings over $50,000 in New York City or the seven counties near it."],
  ["Notice of assessment", <>The CRA's answer after it processes a return. See <DocLink to="tax-basics" section="notice-of-assessment">The notice of assessment</DocLink>.</>],
  ["Profile", "In Taxi: you, your spouse or partner, and the children and other dependants who live with you. The same people every year."],
  ["Refund", "Money the CRA or the IRS pays back when more tax was taken off your pay than you owe."],
  ["RRSP", "A registered retirement savings plan. Contributions can be deducted, up to your RRSP deduction limit."],
  ["SIN", "Your social insurance number. Taxi never asks for it and none of its fields holds it: you write it on the paper return. An uploaded slip keeps it as printed."],
  ["Schedule CA", "The schedule of Form 540 that changes the federal income and itemized deductions to what California taxes and allows."],
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
