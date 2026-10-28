import { DocLink, type DocTopic } from "./parts.tsx";

// Docs › For stakeholders: the holder view as a holder meets it (pages/portal/: the portfolio, a holding's page, How
// to exercise, Documents and the footer's company contact). Exercising and its taxes are the company's process, so the
// topic opens with the general-information note.

export const forStakeholders: DocTopic = {
  slug: "for-stakeholders",
  title: "For stakeholders",
  summary: "What employees, advisors and investors see in Cap Table, and how to read it.",
  group: "app",
  generalInformation: true,
  sections: [
    {
      id: "what-you-see",
      title: "What you see, and why",
      body: (
        <>
          <p>
            Cap Table shows you the holdings the company has recorded for you, and nothing else: you don't see the full cap table,
            other holders or ownership percentages. You see a holding because your stakeholder record carries the e-mail address
            of your Insulin console account as your own address.
          </p>
          <ul>
            <li><b>Portfolio</b> is your home page: a summary of your shares, options, warrants and SAFEs, your vesting status and upcoming vesting dates, a table of your grants and shares with each one's status, and the company resources. A SAFE shows its terms, and once it has converted, the shares it became.</li>
            <li><b>More than one record?</b> If you hold equity under more than one record (for example personally and through a trust), Portfolio lets you switch between them.</li>
            <li><b>If you have left the company,</b> a banner says how many vested options you can still exercise and until when, and when exercises start being taxed as NSOs if an ISO deadline applies.</li>
            <li><b>Something missing or wrong?</b> Only the company can change your records. If you see no holdings at all, ask the company to add your console e-mail address to your stakeholder record.</li>
          </ul>
        </>
      ),
    },
    {
      id: "reading-your-vesting",
      title: "Reading your vesting",
      body: (
        <>
          <p>Open a grant from <b>My grants and shares</b> to see its details:</p>
          <ul>
            <li><b>Granted</b>: how many options you were given. <b>Vested</b> and <b>Unvested</b>: how many you have earned so far, and how many are still to come.</li>
            <li><b>Exercised</b>: how many you have already bought. <b>Exercisable now</b>: how many you could exercise today, at the <b>exercise price</b> shown.</li>
            <li><b>Option type</b> (ISO or NSO) and the <b>expiration date</b>, after which the options can't be exercised.</li>
            <li><b>Vesting timeline</b>: a chart of how your options vest over time, and the full schedule, with each date's amount, the running total and its status: <b>Vested</b> or <b>Upcoming</b>, or, for dates after vesting stopped (for example when you left), <b>Cancelled</b> or <b>Won't vest</b>.</li>
            <li><b>ISO/NSO split</b>, for ISOs: only $100,000 worth of shares, valued on each grant date, can first become exercisable as ISOs in a calendar year, counting your ISOs in the order they were granted; the rest are treated as NSOs.</li>
            <li><b>Post-termination exercise periods</b>: how long you would have to exercise vested options after leaving, for each reason for leaving.</li>
            <li><b>Exercise history</b> and the <b>documents</b> that belong to the grant, such as your option agreement.</li>
          </ul>
          <p>
            Restricted shares show how many have vested, and whether the company may buy back the unvested ones. To learn what
            these terms mean, see <DocLink to="equity-basics" section="vesting">Vesting</DocLink> and the <DocLink to="glossary">Glossary</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: "exercising",
      title: "How exercising works",
      body: (
        <>
          <p>
            Exercising means buying the shares your vested options entitle you to, at the exercise price. It happens outside the
            app, following the company's process: there is no exercise button. The <b>How to exercise</b> page walks you through it:
          </p>
          <ol>
            <li><b>Check how many options you can exercise</b> and the deadline, shown for each grant.</li>
            <li><b>Download and sign the notice of exercise</b>, the form the company provides.</li>
            <li><b>Send it to the company contact</b> shown on the page.</li>
            <li><b>Confirm the total due</b> with the company: the exercise price times the number of options, plus any tax withholding payroll confirms for employees and former employees.</li>
            <li><b>Pay</b> by bank transfer, or by check if the company accepts checks, quoting the reference shown on the page.</li>
            <li><b>The company records the exercise</b> once the notice and the full payment have arrived; the new shares then show in your portfolio.</li>
          </ol>
          <p>
            The page also shows the company's own instructions and its payment instructions. Payment details are shown only there,
            inside the app: if you receive bank details any other way, for example by e-mail, don't pay; check with the company
            first.
          </p>
          <ul>
            <li><b>Deadlines matter.</b> Options can't be exercised after their deadline. After you leave, ISOs exercised after the ISO deadline are taxed as NSOs.</li>
            <li><b>Awaiting signatures:</b> a grant can be exercised once both you and the company have signed it.</li>
            <li><b>Early exercise:</b> a grant's page may show that it allows exercising before vesting, but Cap Table records only exercises of vested options.</li>
          </ul>
        </>
      ),
    },
    {
      id: "your-documents",
      title: "Your documents",
      body: (
        <ul>
          <li><b>My documents</b> are the documents the company has shared with you, such as your grant agreements, stock purchase agreements, notices of exercise and certificates. A document that also concerns other holders is never shown here.</li>
          <li><b>Company resources</b> are for every holder, such as the equity plan, the notice of exercise form and the company's privacy notice.</li>
          <li>Choose a document's name to save a copy. If a document you expect isn't there, ask the company.</li>
        </ul>
      ),
    },
    {
      id: "who-to-contact",
      title: "Who to contact",
      body: (
        <>
          <p>
            The company contact is at the bottom of every page, after "Questions about your equity?". Contact them to exercise,
            to correct your details, or if something looks wrong. Cap Table doesn't send e-mail, so check back here after a change.
          </p>
          <p>
            For advice about your own taxes, talk to a tax advisor: Cap Table and its docs give general information only.
          </p>
        </>
      ),
    },
  ],
};
