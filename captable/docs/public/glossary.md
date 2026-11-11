---
title: Cap Table glossary
description: The terms used in Cap Table and in these docs, from 409A valuation to warrant, in plain words. General information, not advice.
order: 8
---

This glossary defines the terms Cap Table and these docs use, A to Z. It is for anyone meeting equity jargon for the
first time, and for AI agents that need precise meanings. Definitions of legal and tax terms are general information,
not advice. For the ideas behind them, see [Equity basics](/docs/captable/equity-basics); for terms about accounts,
organizations and sign-in, see the [platform glossary](/docs/platform/glossary).

## 0–9

- **409A valuation:** an independent estimate of the fair market value of a private company's common stock, used in the
  US to set option exercise prices. It is generally presumed reasonable for up to twelve months, unless something
  material changes. See [409A valuations](/docs/captable/equity-basics#409a-valuations).
- **83(b) election:** a US tax filing that lets the holder of restricted stock be taxed when the shares are transferred
  to them (on their value then, minus what they paid) instead of as they vest. It must be filed with the IRS no later
  than 30 days after the transfer, which isn't always the grant date.

## A

- **Acceleration:** vesting that speeds up when certain events happen. Single trigger: one event is enough, such as a
  sale of the company. Double trigger: two are needed, typically a sale of the company and the holder's job ending
  within a set period. In Cap Table, an acceleration is recorded during a termination.
- **AI agent:** an AI assistant, such as Claude Code or Codex, that someone connects to Cap Table over MCP. It acts with
  that person's role and permissions, and no more.
- **API client:** another system that reads or changes Cap Table's records with an OAuth client (once called a service
  account), with a role of its own. Its changes appear in the history under its name.
- **As-of date:** the date a figure describes. Cap Table can show the cap table as of any date; an import's as-of date
  is the date its files describe.
- **Assumption:** in an import preview, a choice Cap Table made where the files leave something open, such as a default
  it applied.
- **Audit log:** the record of every change in the company: what changed, who made it and when. Shown under **Recent
  Activity**, and downloadable from **Reports**.
- **Authorized shares:** the most shares of a class the company may issue, as set in its charter.

## B

- **Board consent:** a written approval by the board of directors, for example of an option grant. Cap Table asks for it
  when a grant is recorded.
- **Book entry:** a share recorded only in the company's records, with no paper certificate. The shares Cap Table
  creates, such as those from an exercise, are book entries.

## C

- **Cancellation:** ending options or warrants before they are exercised, for example when a holder waives them or a
  grant was never signed. Depending on the plan's rules, cancelled options may go back to the pool.
- **Cap table:** the record of who owns a company: its shares, and the options, warrants and SAFEs that can become
  shares.
- **Certificate:** a document showing ownership of shares. Cap Table keeps a record of each certificate: its number,
  holder, class, quantity, issue date and status.
- **Change of control:** a sale or merger of the company in which control passes to new owners. It is the usual
  trigger for acceleration.
- **Cliff:** the first part of a vesting schedule, during which nothing vests. When it ends, everything that would have
  vested until then vests at once.
- **Command:** one change to holdings, such as recording a grant or a termination, saved as a group of ledger entries
  that stand or fall together. Reversing a change reverses its whole command.
- **Common stock:** the basic class of shares, usually held by founders and employees. Employee options are usually
  options to buy common stock.
- **Company contact:** the person or team holders contact about their equity, shown at the bottom of every page of the
  holder view.
- **Company resources:** documents every holder can open, such as the equity plan, the notice of exercise form and the
  privacy notice.
- **Conversion ratio:** how many shares of common stock one share of preferred stock converts into.
- **Custom role:** a role an organization's owner makes for Cap Table on Insulin Apps from its permissions: Record
  changes, View the cap table and See own holdings. See [Roles and access](/docs/captable/roles-and-access#custom-roles).

## D

- **Dilution:** the fall in each holder's percentage of the company when new shares are issued. See
  [Dilution](/docs/captable/equity-basics#dilution).
- **Discount:** in a SAFE, a percentage off the price new investors pay, used to work out the SAFE's price when it
  converts.
- **Dry run:** a preview of a change that saves nothing: it shows the entries, the effect, any rule it breaks and any
  warning to accept. Every change in Cap Table is reviewed this way before it is saved.

## E

- **Early exercise:** exercising options before they vest, when the grant allows it. The shares received are usually
  restricted stock. Cap Table records only exercises of vested options.
- **Equity plan:** the document under which a company grants options and other equity awards, and reserves shares for
  them: the option pool.
- **Execution pending:** a grant that hasn't been signed by both the holder and the company. It can't be exercised until
  someone who records changes marks it executed.
- **Exercise:** buying the shares an option or a warrant entitles its holder to, by paying the exercise price. Cap Table
  records exercises of vested options.
- **Exercise deadline:** the last day an option can be exercised: the end of its exercise window after the holder
  leaves, and never later than its expiration date.
- **Exercise price:** the price per share paid to exercise an option or a warrant. Also called the strike price.
- **Exercise window:** how long someone has to exercise vested options after leaving the company, also called the
  post-termination exercise period. See
  [Leaving the company](/docs/captable/equity-basics#leaving-the-company-exercise-windows).
- **Expiration date:** the date after which an option or a warrant can no longer be exercised.
- **Expiry run:** the options and warrants whose deadline has passed, listed by **Process due items** for someone who
  records changes to review and confirm, until expiry is switched to automatic.

## F

- **Fair market value (FMV):** what a share is worth on a given date. For a private US company, it usually comes from a
  409A valuation.
- **Fully diluted:** a way of counting shares that also counts shares that could be issued later; agreements define it
  in different ways. In Cap Table: outstanding shares as converted into common (except a share class marked to be left
  out), outstanding options and warrants as if exercised, and the shares still available in the equity plans. SAFEs
  count only once they convert.

## G

- **Grant:** an award of options to a holder under an equity plan, with its quantity, exercise price, vesting and other
  terms.
- **Grant date:** the date a grant is made, usually the date the board approves it.

## H

- **Holder:** someone who holds equity in the company. Holders with the Viewer role see their own holdings in Cap
  Table's holder view.
- **Holder view:** what a Viewer sees in Cap Table: their own shares, options, warrants and SAFEs, vesting, deadlines,
  How to exercise and documents, and nothing about anyone else.
- **How to exercise:** the holder view's page about the company's exercise process: what can be exercised, the notice
  of exercise, who to send it to and how to pay.

## I

- **Idempotency key:** a random value sent with a change through the API, so that repeating the request after a lost
  connection never records the change twice.
- **Import:** setting up a company in Cap Table from Pulley's reports or the Cap Table spreadsheet template. See
  [Setting up](/docs/captable/setting-up).
- **ISO (incentive stock option):** a US stock option that can be granted only to employees and can get favorable tax
  treatment if its rules are met. See [ISOs and NSOs](/docs/captable/equity-basics#isos-and-nsos).
- **ISO deadline:** the last day an ISO can be exercised as an ISO after employment ends: normally three months after
  the termination, or one year after a permanent and total disability. Exercised later, it is taxed as an NSO.
- **ISO/NSO split:** how ISO grants divide between ISO and NSO under the $100,000-a-year limit. Cap Table's split counts
  only this company's grants.
- **Issued and outstanding:** shares the company has issued that stockholders still hold.

## L

- **Leave of absence:** a period away from work, recorded on a stakeholder. A long leave without a guaranteed return can
  move an ISO deadline.
- **Ledger:** Cap Table's permanent record of every fact that changes a number, each entry with its effective date, who
  recorded it, and a fingerprint chained to the entry before it. See [How it works](/docs/captable/how-it-works).
- **Legend:** a statement on a share certificate, or recorded with uncertificated shares, describing restrictions on the
  shares, such as limits on reselling them.
- **Liquidation preference:** the right of preferred holders to be paid a set amount, often what they invested, before
  common holders when the company is sold or wound down. See
  [the note on liquidation preferences](/docs/captable/equity-basics#a-careful-note-on-liquidation-preferences).

## M

- **Material event:** something that can change what the company's shares are worth, such as a new financing round. Once
  one is flagged, the current 409A valuation needs review before new grants can be priced.
- **Merge:** combining two records of the same stakeholder into one. A merge never changes a number, and it can be
  undone.

## N

- **Notice of exercise:** the signed form a holder sends to the company to exercise options.
- **NSO (non-qualified stock option):** a stock option that isn't an ISO. NSOs can be granted to employees, directors,
  advisors and consultants.

## O

- **Opening balance:** a holding imported as a starting balance on a date, when the source files don't show every step
  of how it came about. See [Setting up](/docs/captable/setting-up#opening-balances).
- **Option pool:** the shares an equity plan reserves for awards. Each grant uses part of it.
- **Outstanding:** for shares, issued and still held by stockholders. For options and warrants, granted or issued, and
  not yet exercised, cancelled or expired.

## P

- **Par value:** a nominal value per share stated in the charter, often a tiny fraction of a cent. It says little about
  what a share is worth.
- **Payment instructions:** the bank details and reference holders use to pay for an exercise. Holders see them only on
  the How to exercise page.
- **Permission:** one thing a custom role allows in Cap Table: Record changes (`captable.manage`, which includes viewing
  everything), View the cap table (`captable.view`, read only) or See own holdings (`portfolio.view`, the holder view).
- **Post-money and pre-money:** for a SAFE, whether its valuation cap includes the SAFE money (post-money) or is measured
  before it (pre-money).
- **Preferred stock:** shares, usually sold to investors, with rights common stock doesn't have, such as a liquidation
  preference.
- **Preview as stakeholder:** seeing a holder's holdings, exercise instructions and documents as the holder sees them,
  with every action disabled.
- **Process due items:** the dashboard action that records what has fallen due: scheduled terminations whose date has
  come, and expiries. See [Process due items](/docs/captable/everyday-tasks#process-due-items).

## R

- **Replay:** working out the cap table by applying the ledger's entries in order of effective date, up to a chosen
  date, checking every rule on the way.
- **Repurchase right:** the company's right to buy back shares in certain situations, most often unvested restricted
  shares when the holder leaves.
- **Restricted stock:** shares owned from the start but subject to vesting.
- **Return to pool:** a plan's rules for whether cancelled, expired or repurchased awards go back to the option pool or
  are retired.
- **Reversal:** how a mistake is corrected in Cap Table: the whole change is undone, with a reason, and the original stays
  in the history, marked as reversed. See [Correct a mistake](/docs/captable/everyday-tasks#correct-a-mistake).

## S

- **SAFE:** a simple agreement for future equity: money invested now that converts into shares later, usually in a priced
  financing round. See [SAFEs](/docs/captable/equity-basics#safes).
- **Scheduled termination:** a termination recorded with a future date. Vesting continues until then, and it takes effect
  when due items are processed on or after that date.
- **Securities Status:** the lists that need attention: grants waiting for signatures, scheduled terminations,
  repurchase windows, options of former holders, and upcoming expirations.
- **Security:** a single holding: a share lot, an option grant, a warrant or a SAFE.
- **Service account:** the earlier name of an OAuth client: a non-human identity an owner or admin of the organization
  creates on Cap Table's API access tab on Insulin Apps, so another system can call Cap Table's API with a role.
- **Share class:** a kind of share with its own terms, such as common stock or Series A preferred.
- **Share unit:** the smallest fraction of a share the company records: whole shares unless set otherwise. It can't
  change once the first record is in.
- **Spread:** the difference between a share's fair market value and an option's exercise price.
- **Stakeholder:** anyone who holds, or held, equity in the company: a person or an institution.
- **Stakeholder Portal:** the settings for what holders see: the company contact, the company resources, the notice of
  exercise form, the privacy notice and the How to exercise text.
- **Strike price:** another name for the exercise price.

## T

- **Termination:** recording that someone has left: vesting stops, unvested awards are cancelled, and exercise windows
  begin.
- **Tranche:** one step of a vesting schedule: the amount that vests on one date.

## V

- **Valuation cap:** in a SAFE, the highest company valuation used to work out the price at which it converts.
- **Vesting:** earning equity over time. Unvested options or shares can be lost if the holder leaves. See
  [Vesting](/docs/captable/equity-basics#vesting).
- **Vesting schedule:** how and when a grant vests: its length, cliff and how often it vests.
- **Vesting start date:** the date a vesting schedule counts from, often the holder's first day.
- **Vesting stop date:** the date vesting stops when someone leaves: the termination date, unless an earlier one is
  chosen.

## W

- **Warrant:** the right to buy shares at a fixed price before an expiration date, usually issued to lenders, investors
  or partners rather than under an equity plan. See [Warrants](/docs/captable/equity-basics#warrants).
