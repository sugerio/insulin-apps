import type { ReactNode } from "react";
import { DocLink, anchorId, type DocSection, type DocTopic } from "./parts.tsx";

// Docs › Glossary: the terms the app uses, A–Z, each with an id of its own (anchorId) so other topics can link to it.
// The sections are built from the list: one per first letter, numbers first.

const TERMS: readonly (readonly [term: string, definition: ReactNode])[] = [
  ["409A valuation", <>An independent estimate of the fair market value of a private company's common stock, used in the US to set option exercise prices. It is generally presumed reasonable for up to twelve months, unless something material changes. See <DocLink to="equity-basics" section="409a-valuations">409A valuations</DocLink>.</>],
  ["83(b) election", <>A US tax filing that lets the holder of restricted stock be taxed when the shares are received, instead of as they vest. It must be filed with the IRS within 30 days after receiving the shares. See <DocLink to="equity-basics" section="restricted-stock">Restricted stock</DocLink>.</>],
  ["Acceleration", <>Vesting that speeds up when certain events happen. Single trigger: one event is enough, such as a sale of the company. Double trigger: two are needed, typically a sale of the company and the holder's job ending within a set period. In Cap Table, an acceleration is recorded during a termination.</>],
  ["As-of date", "The date a figure describes. Cap Table can show the cap table as of any date; an import's as-of date is the date its files describe."],
  ["Assumption", "In an import preview, a choice Cap Table made where the files leave something open, such as a default it applied."],
  ["Audit log", "The record of every change in the company: what changed, who made it and when. Shown under Recent Activity, and downloadable from Reports."],
  ["Authorized shares", "The most shares of a class the company may issue, as set in its charter."],
  ["Board consent", "A written approval by the board of directors, for example of an option grant. Cap Table asks for it when a grant is recorded."],
  ["Book entry", "A share recorded only in the company's records, with no paper certificate. The shares Cap Table creates, such as those from an exercise, are book entries."],
  ["Cancellation", "Ending options or warrants before they are exercised, for example when a holder waives them or a grant was never signed. Depending on the plan's rules, cancelled options may go back to the pool."],
  ["Cap table", "The record of who owns a company: its shares, and the options, warrants and SAFEs that can become shares."],
  ["Certificate", "A document showing ownership of shares. Cap Table keeps a record of each certificate: its number, holder, class, quantity, issue date and status."],
  ["Change of control", "A sale or merger of the company in which control passes to new owners. It is the usual trigger for acceleration."],
  ["Cliff", "The first part of a vesting schedule, during which nothing vests. When it ends, everything that would have vested until then vests at once."],
  ["Common stock", "The basic class of shares, usually held by founders and employees. Employee options are usually options to buy common stock."],
  ["Company contact", "The person or team holders contact about their equity, shown at the bottom of every page of the holder view."],
  ["Company resources", "Documents every holder can open, such as the equity plan, the notice of exercise form and the privacy notice."],
  ["Console role", "The role a person has on the app in the Insulin console: Owner, Admin, Editor, User or Viewer. It decides what they can do in Cap Table."],
  ["Conversion ratio", "How many shares of common stock one share of preferred stock converts into."],
  ["Dilution", <>The fall in each holder's percentage of the company when new shares are issued. See <DocLink to="equity-basics" section="dilution">Dilution</DocLink>.</>],
  ["Discount", "In a SAFE, a percentage off the price new investors pay, used to work out the SAFE's price when it converts."],
  ["Early exercise", "Exercising options before they vest, when the grant allows it. The shares received are restricted stock, which the company can buy back if the holder leaves before they vest."],
  ["Equity plan", "The document under which a company grants options and other equity awards, and reserves shares for them: the option pool."],
  ["Execution pending", "A grant that hasn't been signed by both the holder and the company. It can't be exercised until an owner or admin marks it executed."],
  ["Exercise", "Buying the shares an option or a warrant entitles its holder to, by paying the exercise price. Only vested options can be exercised, unless the grant allows early exercise."],
  ["Exercise deadline", "The last day an option can be exercised: the end of its exercise window after the holder leaves, and never later than its expiration date. Holders see it as the contractual deadline."],
  ["Exercise price", "The price per share paid to exercise an option or a warrant. Also called the strike price."],
  ["Exercise window", <>How long someone has to exercise vested options after leaving the company, also called the post-termination exercise period. See <DocLink to="equity-basics" section="exercise-windows">Leaving the company</DocLink>.</>],
  ["Expiration date", "The date after which an option or a warrant can no longer be exercised."],
  ["Expiry run", "The options and warrants whose deadline has passed, listed by Process due items for an owner or admin to review and confirm, until expiry is switched to automatic."],
  ["Fair market value (FMV)", "What a share is worth on a given date. For a private US company, it usually comes from a 409A valuation."],
  ["Fully diluted", "A count of shares that includes everything that could become shares. In Cap Table: issued and outstanding shares (preferred as converted), outstanding options and warrants as if exercised, and the shares still available in the equity plans."],
  ["Grant", "An award of options to a holder under an equity plan, with its quantity, exercise price, vesting and other terms."],
  ["Grant date", "The date a grant is made, usually the date the board approves it."],
  ["Holder", "Someone who holds equity in the company. Holders with the User or Viewer role see their own holdings in Cap Table's holder view."],
  ["How to exercise", "The holder view's page about the company's exercise process: what can be exercised, the notice of exercise, who to send it to and how to pay."],
  ["Import", <>Setting up a company in Cap Table from Pulley's reports or the Cap Table spreadsheet template. See <DocLink to="importing">Importing your cap table</DocLink>.</>],
  ["ISO (incentive stock option)", <>A US stock option that can be granted only to employees and can get favorable tax treatment if its rules are met. See <DocLink to="equity-basics" section="isos-and-nsos">ISOs and NSOs</DocLink>.</>],
  ["ISO deadline", "The last day an ISO can be exercised as an ISO after employment ends: normally three months after the termination. Exercised later, it is taxed as an NSO."],
  ["ISO/NSO split", "How an ISO grant divides between ISO and NSO under the $100,000-a-year limit, by the year its options first become exercisable."],
  ["Issued and outstanding", "Shares the company has issued that stockholders still hold."],
  ["Leave of absence", "A period away from work, recorded on a stakeholder. A long leave without a guaranteed return can move an ISO deadline."],
  ["Legend", "A statement on a share certificate, or recorded with uncertificated shares, describing restrictions on the shares, such as limits on reselling them."],
  ["Liquidation preference", <>The right of preferred holders to be paid a set amount, often what they invested, before common holders when the company is sold or wound down. See <DocLink to="equity-basics" section="liquidation-preferences">the note on liquidation preferences</DocLink>.</>],
  ["Material event", "Something that can change what the company's shares are worth, such as a new financing round. Once one is flagged, the current 409A valuation needs review before new grants can be priced."],
  ["Merge", "Combining two records of the same stakeholder into one. A merge never changes a number, and it can be undone."],
  ["Notice of exercise", "The signed form a holder sends to the company to exercise options."],
  ["NSO (non-qualified stock option)", "A stock option that isn't an ISO. NSOs can be granted to employees, directors, advisors and consultants; in the US, the spread at exercise is generally taxed as ordinary income."],
  ["Opening balance", <>A holding imported as a starting balance on a date, when the source files don't show every step of how it came about. Quantities, vesting and status are exact; only the history is shorter. See <DocLink to="importing" section="opening-balances">Opening balances</DocLink>.</>],
  ["Option pool", "The shares an equity plan reserves for awards. Each grant uses part of it."],
  ["Outstanding", "For shares: issued and still held by stockholders. For options and warrants: granted or issued, and not yet exercised, cancelled or expired."],
  ["Par value", "A nominal value per share stated in the charter, often a tiny fraction of a cent. It says little about what a share is worth."],
  ["Payment instructions", "The bank details and reference holders use to pay for an exercise. An owner or admin sets them, and holders see them only on the How to exercise page."],
  ["Post-money and pre-money", "For a SAFE, whether its valuation cap includes the SAFE money (post-money) or is measured before it (pre-money). For a financing round, the company's valuation after or before the new investment."],
  ["Preferred stock", <>Shares, usually sold to investors, with rights common stock doesn't have, such as a liquidation preference. See <DocLink to="equity-basics" section="common-and-preferred">Common and preferred stock</DocLink>.</>],
  ["Preview as stakeholder", "Seeing exactly what a holder sees, with every action disabled. Owners, admins and editors can use it from a stakeholder's page or the Stakeholders list."],
  ["Preview mode", "Using Cap Table in the console's preview or on your own computer, as a stand-in owner, with a practice database that never reaches the published app."],
  ["Process due items", <>The dashboard action that records what has fallen due: scheduled terminations whose date has come, and expiries. See <DocLink to="everyday-tasks" section="due-items">Process due items</DocLink>.</>],
  ["Repurchase right", <>The company's right to buy back shares in certain situations, most often unvested restricted shares when the holder leaves. See <DocLink to="equity-basics" section="repurchase-rights">Repurchase rights</DocLink>.</>],
  ["Restricted stock", "Shares owned from the start but subject to vesting: the company can buy back the unvested ones if the holder leaves."],
  ["Return to pool", "A plan's rules for whether cancelled, expired or repurchased awards go back to the option pool or are retired."],
  ["Reversal", <>How a mistake is corrected in Cap Table: the whole change is undone, with a reason, and the original stays in the history, marked as reversed. See <DocLink to="everyday-tasks" section="reversals">Correcting a mistake</DocLink>.</>],
  ["SAFE", <>A simple agreement for future equity: money invested now that converts into shares later, usually in a priced financing round. See <DocLink to="equity-basics" section="safes">SAFEs</DocLink>.</>],
  ["Scheduled termination", "A termination recorded with a future date. Vesting continues until then, and it takes effect when due items are processed on or after that date."],
  ["Securities Status", "The lists that need an owner's or admin's attention: grants waiting for signatures, scheduled terminations, repurchase windows, options of former holders, and upcoming expirations."],
  ["Security", "A single holding: a share lot, an option grant, a warrant or a SAFE."],
  ["Share class", "A kind of share with its own terms, such as common stock or Series A preferred."],
  ["Share unit", "The smallest fraction of a share the company records: whole shares unless set otherwise. It can't change once the first record is in."],
  ["Spread", "The difference between a share's fair market value and an option's exercise price."],
  ["Stakeholder", "Anyone who holds, or held, equity in the company: a person or an institution."],
  ["Stakeholder Portal", "The settings for what holders see: the company contact, the company resources, the notice of exercise form, the privacy notice and the How to exercise text."],
  ["Strike price", "Another name for the exercise price."],
  ["Termination", "Recording that someone has left: vesting stops, unvested awards are cancelled, and exercise windows begin."],
  ["Tranche", "One step of a vesting schedule: the amount that vests on one date."],
  ["Valuation cap", "In a SAFE, the highest company valuation used to work out the price at which it converts."],
  ["Vesting", <>Earning equity over time. Unvested options or shares can be lost if the holder leaves. See <DocLink to="equity-basics" section="vesting">Vesting</DocLink>.</>],
  ["Vesting schedule", "How and when a grant vests: its length, cliff and how often it vests."],
  ["Vesting start date", "The date a vesting schedule counts from, often the holder's first day."],
  ["Vesting stop date", "The date vesting stops when someone leaves: the termination date, unless an earlier one is chosen."],
  ["Warrant", <>The right to buy shares at a fixed price before an expiration date, usually issued to lenders, investors or partners rather than under an equity plan. See <DocLink to="equity-basics" section="warrants">Warrants</DocLink>.</>],
];

/** "0–9" for terms that start with a number, else the term's first letter. */
function letterOf(term: string): string {
  const first = term.charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : "0–9";
}

function sections(): DocSection[] {
  const ordered = [...TERMS].sort(([a], [b]) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }));
  const letters = new Map<string, (typeof ordered)[number][]>();
  for (const entry of ordered) letters.set(letterOf(entry[0]), [...(letters.get(letterOf(entry[0])) ?? []), entry]);
  return [...letters].map(([letter, entries]) => ({
    id: `glossary-${anchorId(letter.replace("–", "-"))}`,
    title: letter,
    body: (
      <dl className="docs-glossary">
        {entries.map(([term, definition]) => (
          <div key={term}>
            <dt id={anchorId(term)} tabIndex={-1}>{term}</dt>
            <dd>{definition}</dd>
          </div>
        ))}
      </dl>
    ),
  }));
}

export const glossary: DocTopic = {
  slug: "glossary",
  title: "Glossary",
  summary: "The terms used in Cap Table and in these docs, A to Z.",
  group: "equity",
  generalInformation: true,
  compactContents: true,
  sections: sections(),
};
