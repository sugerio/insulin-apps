import { DocLink, DocTable, Example, InApp, type DocTopic } from "./parts.tsx";

// Docs › Equity basics: the ideas behind a cap table, in plain words, for anyone. General information only (the topic
// opens with the note that says so), kept to what is widely true, with US tax points at a high level. Each section ends
// with what Cap Table itself does about it, as the engine and the pages do it (fully diluted as engine/metrics.ts
// defines it, ISO deadlines as engine/deadlines.ts computes them).

export const equityBasics: DocTopic = {
  slug: "equity-basics",
  title: "Equity basics",
  summary: "The ideas behind a cap table and employee equity, in plain words.",
  group: "equity",
  generalInformation: true,
  sections: [
    {
      id: "what-is-a-cap-table",
      title: "What a cap table is",
      body: (
        <>
          <p>
            A cap table (short for capitalization table) is the record of who owns a company. It lists every share, and every
            right to get shares, such as stock options, warrants and SAFEs, with who holds them, how many there are and on what
            terms.
          </p>
          <p>
            Founders use it to see how ownership is split. Investors study it before they invest, employees' equity lives in it,
            and lawyers and accountants rely on it in a financing, a sale of the company or an audit. A cap table also changes
            over time: shares are issued, options are granted, vest, are exercised or expire, and SAFEs convert into shares. That
            is why it pays to keep it accurate and up to date.
          </p>
          <InApp>Cap Table keeps the full history of these changes, so the Cap Table page can show the cap table as of any date you pick.</InApp>
        </>
      ),
    },
    {
      id: "share-counts",
      title: "Authorized, issued, outstanding and fully diluted",
      body: (
        <>
          <ul>
            <li><b>Authorized shares</b> are the most shares of each class the company may issue. The number is set in the company's charter (for a US corporation, its certificate of incorporation), and raising it usually needs the approval of the board and the stockholders.</li>
            <li><b>Issued shares</b> are the shares the company has actually issued to someone.</li>
            <li><b>Outstanding shares</b> are issued shares that stockholders still hold. Shares the company has bought back aren't outstanding.</li>
            <li><b>Fully diluted shares</b> also count shares that could be issued later. It is a convention, and agreements define it in different ways; usually it counts options and warrants as if they were exercised, preferred stock as if converted into common, and the shares still available to grant in the equity plan. A holder's fully diluted ownership is their share of that larger number, so check how a document defines it.</li>
          </ul>
          <Example>
            <DocTable
              label="Example share counts"
              columns={["Acme Robotics", "Shares"]}
              rows={[
                ["Authorized in the charter", "10,000,000"],
                ["Issued so far", "6,000,000"],
                ["Bought back by the company", "100,000"],
                ["Issued and outstanding", "5,900,000"],
                ["Options outstanding", "1,000,000"],
                ["Still available in the equity plan", "500,000"],
                ["Fully diluted (5,900,000 + 1,000,000 + 500,000)", "7,400,000"],
              ]}
            />
          </Example>
          <InApp>
            Issued and outstanding is one figure: the issued shares that stockholders still hold. Fully diluted counts those shares
            as converted into common (a share class can be marked to be left out), outstanding options and warrants as if exercised,
            and the shares still available in the equity plans. SAFEs count only once they convert, because the number of shares they
            will become isn't known until then.
          </InApp>
        </>
      ),
    },
    {
      id: "common-and-preferred",
      title: "Common and preferred stock",
      body: (
        <>
          <p>
            <b>Common stock</b> is the basic kind of share. Founders and employees usually hold common stock, and employee stock
            options are usually options to buy common stock.
          </p>
          <p>
            <b>Preferred stock</b> is usually what investors buy in a financing round, named for example Series Seed or Series A. It
            carries extra rights, set out in the company's charter and the investment agreements, which commonly include:
          </p>
          <ul>
            <li>a liquidation preference (see below);</li>
            <li>the right to convert into common stock at a conversion ratio, often one share of common for each share of preferred;</li>
            <li>voting rights, such as a say over certain company decisions;</li>
            <li>protection if the company later sells shares at a lower price (anti-dilution protection);</li>
            <li>dividend rights.</li>
          </ul>
          <h3 id="liquidation-preferences" tabIndex={-1}>A careful note on liquidation preferences</h3>
          <p>
            A liquidation preference decides who is paid first when the company is sold or wound down. Preferred holders usually
            get back a set amount, often what they invested (a "1x" preference), before common holders receive anything. With a
            non-participating preference, the holder takes either that amount or what they would get by converting to common,
            whichever is more. With a participating preference, they get the amount and then also share in what is left. When
            there are several classes of preferred, their seniority decides the order.
          </p>
          <p>
            The terms vary from company to company and can change a great deal what common holders receive, especially when a
            company is sold for less than the money invested in it. Read the charter, or ask counsel, rather than assuming.
          </p>
          <InApp>
            Share Classes lists each class with its type, par value, issue price, conversion ratio, liquidation preference, seniority
            and voting. Fully diluted figures count preferred stock as converted into common. Cap Table doesn't calculate what each
            holder would receive in a sale.
          </InApp>
        </>
      ),
    },
    {
      id: "equity-plans",
      title: "Equity plans and option pools",
      body: (
        <>
          <p>
            An <b>equity plan</b> (also called a stock option plan or equity incentive plan) is the document under which a company
            grants options and other equity awards to employees, directors, advisors and consultants. The board adopts it, and the
            stockholders usually approve it.
          </p>
          <p>
            The plan reserves a number of shares for awards: the <b>option pool</b>. Each grant uses up part of the pool. When an
            award is cancelled or expires, the plan's rules decide whether its shares go back to the pool or are retired. If the
            pool runs low, the board and the stockholders can increase it, and it is often increased as part of a financing round.
          </p>
          <InApp>
            Equity Plans shows each plan's size, what is available to grant, outstanding and retired, the default exercise windows
            after someone leaves, and the return-to-pool rules. A new grant can't exceed what is available. Plans come in with the
            import and are view only.
          </InApp>
        </>
      ),
    },
    {
      id: "stock-options",
      title: "Stock options",
      body: (
        <>
          <p>A <b>stock option</b> is the right, but not the obligation, to buy a number of shares at a fixed price until the option expires.</p>
          <ul>
            <li><b>Exercise price</b> (or strike price): the price per share, fixed when the option is granted. It is usually set at the fair market value (FMV) of a share on the grant date; for a private US company, that value usually comes from a <DocLink to="equity-basics" section="409a-valuations">409A valuation</DocLink>.</li>
            <li><b>Exercising</b> means paying the exercise price for vested options to receive the shares. The cost is the exercise price times the number of options. Exercising can also have tax consequences, which depend on the type of option and where you live.</li>
            <li><b>Why options can be valuable:</b> if a share becomes worth more than the exercise price, exercising buys it for less than it is worth. If it is worth less, there is usually no reason to exercise.</li>
            <li><b>Expiration:</b> options don't last forever. A common term is ten years from the grant date, and options usually end sooner after the holder leaves the company (see <DocLink to="equity-basics" section="exercise-windows">Leaving the company</DocLink>). Options that aren't exercised in time expire.</li>
          </ul>
          <Example>
            <p>
              An employee has 10,000 vested options with an exercise price of $0.50. Exercising all of them costs 10,000 × $0.50 =
              $5,000. If a share's fair market value is now $2.00, the difference, $1.50 a share or $15,000 in all, is called the
              spread.
            </p>
          </Example>
          <InApp>An option's page shows the exercise price, what has vested, and what can be exercised now and until when. Exercises happen outside the app, and an owner or admin records them.</InApp>
        </>
      ),
    },
    {
      id: "isos-and-nsos",
      title: "ISOs and NSOs",
      body: (
        <>
          <p>
            In the US, stock options are either <b>incentive stock options (ISOs)</b> or <b>non-qualified stock options
            (NSOs)</b>. The difference is mainly how they are taxed. At a high level:
          </p>
          <ul>
            <li><b>NSOs</b> can be granted to employees, directors, advisors and consultants. When an NSO is exercised for vested shares, the spread is generally taxed as ordinary income, and for employees the company usually withholds tax through payroll. Shares that are still unvested when received (after an early exercise), and the rare option with a readily determinable value of its own, follow different timing rules.</li>
            <li><b>ISOs</b> can be granted only to employees. Exercising an ISO generally doesn't trigger regular income tax, but the spread can count toward the alternative minimum tax (AMT). If the shares are sold more than two years after the grant and more than one year after the exercise, the gain is generally a long-term capital gain. A sale that does not meet both holding periods is a <b>disqualifying disposition</b>: the gain, up to the spread at exercise, is generally taxed as ordinary income, and the rest of the gain or loss is a capital gain or loss.</li>
          </ul>
          <p>ISOs come with limits, including:</p>
          <ul>
            <li><b>$100,000 a year.</b> Only $100,000 worth of shares, valued on each grant date, can first become exercisable as ISOs in one calendar year. The limit counts all of the employee's ISOs from the company and its parent or subsidiary companies, in the order they were granted; anything above it is treated as NSOs.</li>
            <li><b>After leaving.</b> To keep ISO treatment, an ISO generally has to be exercised within three months after employment ends, or within one year if it ended because of a permanent and total disability. After the holder's death, special rules let the estate or heirs exercise it as an ISO for as long as the option itself allows. An ISO exercised outside these limits is treated as an NSO, even if the grant still allows exercising.</li>
            <li><b>Large holders.</b> For someone who owns more than 10% of the voting power of all classes of stock of the company, or of its parent or a subsidiary (counting shares attributed to them, such as shares held by close family or by entities they own), an ISO needs an exercise price of at least 110% of fair market value and a term of no more than five years.</li>
          </ul>
          <p>IRS Publication 525 explains these rules in more detail.</p>
          <InApp>
            Each option grant is an ISO or an NSO. The ISO/NSO split applies the $100,000 limit to a holder's ISO grants in the order
            they were granted, year by year. It counts only this company's grants, because grants from a parent or subsidiary aren't
            entered in Cap Table: check those separately. Recording an ISO asks whether the holder owns more than 10%, and applies the
            110% and five-year rules if so. After a termination, an option shows its ISO deadline next to its exercise deadline, and ISO
            options exercised after the ISO deadline are recorded as NSO.
          </InApp>
        </>
      ),
    },
    {
      id: "restricted-stock",
      title: "Restricted stock and the 83(b) election",
      body: (
        <>
          <p>
            <b>Restricted stock</b> is stock you own from the start but that vests over time. If you leave before it vests, the
            unvested shares are usually forfeited or subject to a company repurchase right, as the grant or purchase agreement says
            (see <DocLink to="equity-basics" section="repurchase-rights">Repurchase rights</DocLink>). Founders often hold their
            shares this way, and exercising options before they vest (early exercise, when a grant allows it) also gives you
            restricted stock.
          </p>
          <p>
            In the US, restricted stock is normally taxed as it vests: on what the shares are worth at each vesting date, minus
            what you paid for them. An <b>83(b) election</b> lets you choose to be taxed when the shares are transferred to you
            instead, on what they are worth then minus what you paid. When you pay their full fair market value, that difference is
            zero, and growth in value after that isn't taxed as the shares vest.
          </p>
          <p>
            <b>The election must be filed with the IRS no later than 30 days after the shares are transferred to you.</b> That
            isn't always the grant date: for an early exercise, it is usually the exercise date. The deadline is strict, and a
            missed election usually can't be made later, so talk to a tax advisor straight away. The election has risks too: if you pay tax up front and then leave before the
            shares vest, or the shares lose value, that tax generally isn't refunded.
          </p>
          <InApp>A share's page shows its vesting and any repurchase right. Cap Table doesn't file 83(b) elections; a copy of a filed election can be kept with the shares as a document.</InApp>
        </>
      ),
    },
    {
      id: "vesting",
      title: "Vesting",
      body: (
        <>
          <p>
            <b>Vesting</b> is how equity is earned over time. Until options or restricted shares vest, they can be lost, typically
            when the holder leaves the company.
          </p>
          <ul>
            <li><b>Schedule.</b> A common schedule for employees is four years with a one-year cliff.</li>
            <li><b>Cliff.</b> A first period during which nothing vests. When it ends, everything that would have vested until then vests at once: with a four-year schedule and a one-year cliff, a quarter vests on the first anniversary of the vesting start date.</li>
            <li><b>After the cliff,</b> the rest vests in equal steps, often monthly (1/48 of the total each month over four years) or quarterly.</li>
            <li><b>Acceleration.</b> Some agreements speed up vesting when certain events happen. With <b>single-trigger</b> acceleration, one event is enough, typically a sale of the company (a change of control). With <b>double-trigger</b> acceleration, two are needed, typically a change of control and the holder's job ending (being let go without cause, or resigning for good reason) within a set period around it.</li>
          </ul>
          <Example>
            <p>
              48,000 options vest monthly over four years with a one-year cliff, from a vesting start date of March 1, 2025.
              Nothing vests until March 1, 2026, when 12,000 options vest at once. Then 1,000 vest on the first of each month, and
              the grant is fully vested on March 1, 2029.
            </p>
          </Example>
          <InApp>
            Vesting is worked out from each grant's schedule. Tranches fall on the same day of the month as the vesting start (or on
            the month's last day), and the running total is rounded down to whole shares (or the company's share unit), so the last
            tranche takes any remainder. Grants imported from Pulley keep Pulley's exact vesting dates and amounts. Acceleration terms are kept with each grant as written, but Cap Table doesn't apply them by itself: an
            acceleration is recorded during a termination, with the document that grants it.
          </InApp>
        </>
      ),
    },
    {
      id: "exercise-windows",
      title: "Leaving the company: exercise windows",
      body: (
        <>
          <p>
            When someone leaves, vesting usually stops and unvested options are cancelled. Vested options stay exercisable only
            for a limited time, the <b>post-termination exercise window</b>, set by the plan or the grant. A common window is
            three months, and some companies allow longer, especially after a death or disability. Options not exercised by the
            end of the window expire.
          </p>
          <p>
            The window can depend on why someone left: for example, a plan may allow no time at all after a termination for
            cause. A company can also agree to extend a window, for example in a separation agreement. Remember that an ISO
            exercised more than three months after employment ends (one year after a permanent and total disability) is generally
            taxed as an NSO, even when the window is longer.
          </p>
          <InApp>
            When someone is terminated, each option gets its exercise deadline and, for an ISO, its ISO deadline; Securities Status
            lists them, and former holders see their deadlines in their portfolio. Options not exercised by their deadline are
            expired when due items are processed.
          </InApp>
        </>
      ),
    },
    {
      id: "409a-valuations",
      title: "409A valuations",
      body: (
        <>
          <p>
            Under Section 409A of the US tax code, stock options granted with an exercise price below the fair market value of
            the shares on the grant date can cause serious tax problems for the holder. So companies set the exercise price at no
            less than fair market value.
          </p>
          <p>
            A private company's shares have no market price, so companies usually hire an independent appraiser for a{" "}
            <b>409A valuation</b>, an estimate of the fair market value of the common stock. A valuation done this way is
            generally presumed reasonable for up to twelve months, unless something material happens in the meantime, such as a
            new financing round, that makes it out of date. Companies usually get a new one at least once a year and after such
            events.
          </p>
          <InApp>
            Compliance &amp; Tax keeps each valuation with its report and status. A new grant takes its exercise price from the
            valuation valid on the grant date, and Cap Table won't price a grant without a valid valuation unless counsel's memo is
            attached. Flagging a material event puts the current valuation under review.
          </InApp>
        </>
      ),
    },
    {
      id: "safes",
      title: "SAFEs",
      body: (
        <>
          <p>
            A <b>SAFE</b> (simple agreement for future equity) is a common way for early-stage companies to raise money. The
            investor pays now and receives shares later, usually when the company raises a priced round of preferred stock. A
            SAFE isn't a loan: it carries no interest and has no repayment date. How many shares it becomes depends on its terms:
          </p>
          <ul>
            <li><b>Valuation cap:</b> the highest company valuation used to work out the SAFE's price. If the round values the company above the cap, the SAFE converts at the lower, capped price, so the investor gets more shares for their money.</li>
            <li><b>Discount:</b> a percentage off the price new investors pay in the round. With a 20% discount, the SAFE converts at 80% of the round's price. When a SAFE has both a cap and a discount, the investor generally gets whichever gives the lower price.</li>
            <li><b>Post-money or pre-money:</b> a post-money SAFE's cap is the company's valuation including the SAFE money (and other SAFEs converting at the same time). That makes the investor's share easy to predict: just before the new round's money comes in, it is roughly the amount invested divided by the cap. A pre-money SAFE's cap is the valuation before that money, so what each SAFE ends up owning depends more on how much other SAFE money converts alongside it.</li>
            <li><b>Most favored nation (MFN):</b> some SAFEs let the holder take up better terms that the company gives a later SAFE investor. The agreement decides how that works.</li>
          </ul>
          <Example>
            <p>
              An investor puts $500,000 into a post-money SAFE with a $10,000,000 valuation cap. When it converts in a round that
              values the company above the cap, the investor owns about $500,000 ÷ $10,000,000 = 5% of the company, measured before
              the round's new money and before any option pool created or enlarged for the round. Both then dilute that 5%.
            </p>
          </Example>
          <InApp>
            SAFEs come in with the import, with their principal, valuation cap, discount and post-money or pre-money type. MFN
            terms aren't imported, so upload the SAFE agreement and link it to the SAFE. The cap table lists SAFEs on their own
            tab, and holders see their SAFEs with each one's status and, once converted, the shares it became. Cap Table doesn't
            convert SAFEs itself: it has no forms to issue shares, so conversions come in with the import.
          </InApp>
        </>
      ),
    },
    {
      id: "warrants",
      title: "Warrants",
      body: (
        <>
          <p>
            A <b>warrant</b> is the right to buy a number of shares at a fixed price, the exercise price, before an expiration date.
            Warrants are much like options, but they aren't granted under an equity plan: companies usually issue them to lenders,
            investors or business partners, often as part of a financing or a commercial deal.
          </p>
          <InApp>
            Warrants come in with the import, and fully diluted figures count outstanding warrants as if exercised. A warrant can be
            cancelled or have its exercise deadline extended, and warrants past their expiration date are expired when due items
            are processed. Cap Table doesn't record warrant exercises.
          </InApp>
        </>
      ),
    },
    {
      id: "dilution",
      title: "Dilution",
      body: (
        <>
          <p>
            <b>Dilution</b> is the fall in each holder's percentage of the company when new shares are issued. The number of shares
            you hold stays the same, but it becomes a smaller slice of a bigger total.
          </p>
          <Example>
            <p>
              Acme Robotics has 8,000,000 shares outstanding, and a founder owns 2,000,000 of them: 25%. Acme then sells 2,000,000
              new shares to an investor. There are now 10,000,000 shares, and the founder's 2,000,000 are 20%.
            </p>
          </Example>
          <p>
            Dilution isn't necessarily bad: if the new money helps the company grow in value, a smaller slice can be worth more
            than the bigger one was. New shares can come from a financing round, options or warrants being exercised, or SAFEs
            converting, and a bigger option pool adds to the fully diluted count. That's why fully diluted figures, which count
            options, warrants and the pool as if they were shares, give a fuller picture than issued shares alone.
          </p>
          <InApp>The Cap Table page shows each holder's issued and outstanding and fully diluted ownership, as of any date, so you can see how it changed. Holders don't see percentages.</InApp>
        </>
      ),
    },
    {
      id: "certificates-and-legends",
      title: "Certificates and legends",
      body: (
        <>
          <p>
            A <b>stock certificate</b> is a document showing that someone owns a number of shares of a class. Many private companies
            issue shares without paper certificates instead: uncertificated or book-entry shares, recorded only in the company's
            records.
          </p>
          <p>
            A <b>legend</b> is a statement on a certificate, or in the notice that goes with uncertificated shares, describing
            restrictions on the shares: for example that they haven't been registered under securities laws and can't be freely
            resold, or that the company has a right of first refusal or a repurchase right.
          </p>
          <InApp>
            Certificates lists the certificates on record, Legends the legends used on shares, and Terms the certificate wording for
            each class. A holder's share page shows the share's form and legends. Cap Table doesn't generate or sign certificates:
            shares it creates, such as those from an exercise, are book entries.
          </InApp>
        </>
      ),
    },
    {
      id: "repurchase-rights",
      title: "Repurchase rights",
      body: (
        <>
          <p>
            A <b>repurchase right</b> lets the company buy back shares in certain situations. The most common is the right to buy
            back unvested restricted shares when the holder leaves, usually at the price the holder paid (or, under some agreements,
            the lower of that price and fair market value), within a set period after they leave. Some agreements also give the
            company a right to buy vested shares, or a <b>right of first refusal</b>: the right to match an offer before a holder
            sells shares to someone else.
          </p>
          <p>
            A repurchase right usually has to be used within its window; if the company doesn't act in time, the right lapses. The
            agreement for the shares says what applies.
          </p>
          <InApp>
            When someone leaves holding unvested shares, Securities Status and the dashboard show the repurchase window and its last
            date, and the holder's share page says until when the company may buy them back. Cap Table doesn't record the
            repurchase itself: that is done outside the app, with counsel.
          </InApp>
        </>
      ),
    },
  ],
};
