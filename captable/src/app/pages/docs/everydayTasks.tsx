import { DocLink, DocTable, type DocTopic } from "./parts.tsx";

// Docs › Everyday tasks: what owners and admins do once the company is set up. It follows docs/using-cap-table.md and
// the pages it describes (the grant, exercise and termination flows, Process due items, documents, reports, reversals
// and Preview as stakeholder).

export const everydayTasks: DocTopic = {
  slug: "everyday-tasks",
  title: "Everyday tasks",
  summary: "How owners and admins keep the cap table up to date. Editors can see all of this, but can't change anything.",
  group: "app",
  sections: [
    {
      id: "how-changes-work",
      title: "How changes work",
      body: (
        <ul>
          <li><b>Review, then confirm.</b> Before anything is saved, Cap Table shows exactly what will change, including any problem that stops it.</li>
          <li><b>Start from the record.</b> <b>+ New</b> records a signed option grant. Most other changes start on the page of the thing they concern: record an exercise from the option, terminate someone from their stakeholder page, and so on.</li>
          <li><b>Not your own holdings.</b> If you hold equity, another owner or admin records changes to it, so nobody approves their own transactions.</li>
          <li><b>Exact numbers.</b> Quantities and amounts are never rounded behind your back; percentages and money are rounded only for display. Dates are calendar dates in the company's time zone.</li>
          <li><b>Tell people yourself.</b> Cap Table sends no e-mail, collects no signatures and takes no payments: use your usual tools, and record the outcome here.</li>
          <li><b>Everything is logged.</b> <b>Recent Activity</b> lists every change with what changed, who made it and when.</li>
        </ul>
      ),
    },
    {
      id: "stakeholders",
      title: "Stakeholders and e-mail addresses",
      body: (
        <>
          <p>A stakeholder is anyone who holds, or held, equity: a person or an institution.</p>
          <ul>
            <li><b>Add stakeholder</b> (on <b>Stakeholders</b>): individual or institution, the legal name, the name to show, one or more relationships (founder, employee, officer, board member, advisor, consultant, investor, other), and optional details such as e-mail addresses, hire date, phone, address and country of tax residence.</li>
            <li><b>E-mail addresses.</b> On a stakeholder's page, <b>Add e-mail</b> adds the person's own address, an authorized contact for an institution, or a representative (for example for an estate). The person's own address is what connects them to their holder view: it must be the e-mail address of their Insulin console account. If the address is already on another stakeholder, Cap Table warns you and asks you to confirm.</li>
            <li><b>Edit stakeholder</b> changes the details; a new name shows everywhere at once. A change of owner isn't an edit but a transfer, which Cap Table doesn't record.</li>
            <li><b>Leave of absence</b> is recorded from <b>Edit stakeholder</b>. A long leave without a guaranteed return can move an ISO deadline.</li>
            <li><b>Duplicates:</b> if the same person or institution appears twice, combine the records with <b>Merge into another stakeholder…</b> on one of them. A merge never changes a number, and <b>Undo stakeholder merge</b> reverses it.</li>
          </ul>
        </>
      ),
    },
    {
      id: "grants",
      title: "Recording an option grant",
      body: (
        <>
          <p>
            Use this for a grant the board has already approved and both sides have signed: choose <b>+ New</b>, then{" "}
            <b>Options</b>. You'll need:
          </p>
          <ol>
            <li><b>The equity plan.</b> The form shows what's available; a grant can't exceed it.</li>
            <li><b>The stakeholder</b>, or add a new one on the spot, and <b>how many options</b>.</li>
            <li><b>Board approval:</b> the approval date and the signed board consent. The grant date is the approval date unless you give another one, with a reason.</li>
            <li><b>ISO or NSO.</b> An ISO needs the holder to be an employee on the grant date. For someone holding more than 10% of the voting power, an ISO needs an exercise price of at least 110% of fair market value and a term of at most five years.</li>
            <li><b>Vesting:</b> a schedule or explicit tranches, the vesting start date, whether early exercise is allowed, and any acceleration terms. Tick that the table shown matches the signed agreement.</li>
            <li><b>Exercise price:</b> filled in from the 409A valuation valid on the grant date. Without a valid valuation, attach counsel's memo to go ahead. An ISO can't be priced below fair market value; an NSO priced below it also needs counsel's memo.</li>
            <li><b>Expiration:</b> ten years unless the agreement says otherwise (five for a 10% holder's ISO), and the exercise windows after leaving, from the plan or as the agreement says.</li>
            <li><b>The agreement</b>, signed by both the holder and the company.</li>
          </ol>
          <p>
            Then choose <b>Record grant</b>. The grant is outstanding at once, and the plan's availability goes down.
          </p>
          <p>
            <b>Grants waiting for signatures.</b> A grant that isn't signed by both sides can't be exercised. Such grants are listed
            under <b>Securities Status</b>. Once both sides have signed, choose <b>Mark executed</b> and upload the signed agreement.
            Imported grants count as signed.
          </p>
        </>
      ),
    },
    {
      id: "exercises",
      title: "Recording an exercise",
      body: (
        <>
          <p>
            Holders don't exercise inside the app: they follow the steps on their <b>How to exercise</b> page, sign the notice of
            exercise and pay outside the app. Once both the notice and the full payment have arrived, open the option and choose{" "}
            <b>Record exercise</b>:
          </p>
          <ol>
            <li><b>Notice of exercise:</b> upload the signed notice and the date you received it.</li>
            <li><b>Payment:</b> the amount, the date it arrived, the method (ACH, wire, check or cash) and a reference.</li>
            <li><b>Exercise date:</b> the later of the notice date and the full-payment date. It can't be in the future or after the option's exercise deadline, unless the deadline is extended (from the same page).</li>
            <li><b>Quantity:</b> at most what is vested and not yet exercised on that date. ISO options exercised after the ISO deadline are recorded as NSO, and the page says so.</li>
            <li><b>Fair market value</b> on the exercise date, from the valuation valid that day, and the <b>tax details</b>: the treatment and the withholding collected. These are entered, not calculated.</li>
          </ol>
          <p>
            The option goes down, the new shares appear as book entries, and the company's capital contribution goes up. Cap
            Table doesn't e-mail the holder, so let them know.
          </p>
        </>
      ),
    },
    {
      id: "terminations",
      title: "Terminations and exercise windows",
      body: (
        <>
          <p>From the stakeholder's page, choose <b>Terminate stakeholder</b>:</p>
          <ol>
            <li><b>Termination details:</b> the termination date (today, a past date, or a future date to schedule it), the type (voluntary, involuntary, with cause, death, disability, retirement), the date vesting stops (never later than the termination date), and the new relationship.</li>
            <li><b>Vesting outcome:</b> for each security, what has vested by the stop date and what will be cancelled. Add an acceleration here if the person is entitled to one, with the document that grants it.</li>
            <li><b>Exercise and repurchase windows:</b> for each option, the <b>exercise deadline</b> (from the grant or the plan, for this type of termination, never past the option's expiration) and the <b>ISO deadline</b> (normally three months after the termination, twelve for a permanent and total disability, none after death, and never later than the exercise deadline). An extension agreed in a separation agreement is recorded here, with that agreement.</li>
            <li><b>Review</b>, then <b>Terminate</b> or <b>Schedule termination</b>.</li>
          </ol>
          <p>
            A <b>scheduled</b> termination shows the person as terminating until the date, and their vesting continues until then.
            It takes effect when <DocLink to="everyday-tasks" section="due-items">due items are processed</DocLink> on or after that
            date. Until then you can cancel it. To undo a termination that has taken effect, use <b>Reverse termination</b> on the
            stakeholder's page. For what exercise windows mean, see <DocLink to="equity-basics" section="exercise-windows">Equity
            basics</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: "cancellations",
      title: "Cancellations and expiry",
      body: (
        <ul>
          <li><b>Cancel options or warrants</b> from the security's page, from the cap table's <b>Actions</b> (several at once), or from <b>Securities Status</b>: the date, the quantity, the reason (holder waiver, not executed, mutual agreement, or forfeiture under the agreement) and a document. The review shows what goes back to the pool.</li>
          <li><b>A mistake isn't a cancellation.</b> If something was recorded wrongly, reverse it instead (see <DocLink to="everyday-tasks" section="reversals">Correcting a mistake</DocLink>).</li>
          <li><b>Expiry:</b> options past their last exercise day and warrants past their expiration date are handled when due items are processed.</li>
          <li>Issued shares are never cancelled in Cap Table.</li>
        </ul>
      ),
    },
    {
      id: "due-items",
      title: "Process due items",
      body: (
        <>
          <p>
            Cap Table has no background jobs: nothing runs on a timer. Two kinds of work fall due on a date: <b>scheduled
            terminations</b> whose date has arrived, and <b>expiries</b> (options past their last exercise day and warrants past
            their expiration date).
          </p>
          <ul>
            <li><b>Opening the dashboard</b> as an owner or admin processes what has fallen due. The dashboard is where Cap Table opens for owners and admins.</li>
            <li><b>Process due items</b>, on the dashboard's <b>Needs attention</b> card, handles everything due at any time and says what it did, or "Nothing was due." It's always safe to run: it never does the same thing twice.</li>
            <li><b>If nobody opens the app for a while,</b> due items simply wait. Open it on or soon after important dates, such as a scheduled termination.</li>
            <li><b>Expiries are proposed first.</b> A new company starts by recording what it would expire as an <b>expiry run</b> to confirm. Review what would be cancelled and confirm; when you confirm, you can switch expiry to automatic.</li>
          </ul>
        </>
      ),
    },
    {
      id: "valuations",
      title: "409A valuations",
      body: (
        <ul>
          <li><b>Record FMV</b> (on <b>Compliance &amp; Tax</b>) records a valuation: the provider, the effective date, the expiration date (twelve months later unless you change it), the fair market value per share class, and the report.</li>
          <li>Each valuation shows a status: <b>presumptively valid</b>, <b>expiring soon</b> (60 days or less left), <b>review required</b>, <b>superseded</b> (a later valuation took effect) or <b>expired</b>.</li>
          <li><b>Flag a material event</b>, such as a new financing, with its date and a description. The valuation then needs review, and new grants are blocked until you record a new valuation or record the provider's or counsel's written confirmation that the old one still holds.</li>
          <li>A recorded valuation is never edited. If one is wrong, record a corrected valuation, or void it.</li>
        </ul>
      ),
    },
    {
      id: "certificates",
      title: "Certificates and legends",
      body: (
        <p>
          <b>Certificates</b> lists the share certificates on record (number, holder, class, quantity, issue date and status); the
          import creates one for each share lot. <b>Legends</b> lists the legends used on shares, and <b>Terms</b> the certificate
          terms of each class. All three are view only: Cap Table doesn't generate, sign or send certificates, and the shares it
          creates, such as the shares from an exercise, are book entries.
        </p>
      ),
    },
    {
      id: "documents",
      title: "Documents",
      body: (
        <ul>
          <li><b>Upload</b> PDF, Word (.docx), Excel (.xlsx), PNG, JPEG, CSV or plain-text files, up to 10 MiB each, on <b>Documents</b> or from the record a document belongs to.</li>
          <li>On a document's page you can link it to a record (a grant, a stakeholder, a valuation, a plan), move it to a folder, edit its details, upload a new version (earlier versions stay) or archive it. Archived documents can be restored: nothing is ever deleted.</li>
          <li><b>Who can see it.</b> A document linked to one holder can be shown in that holder's view or hidden; their own grant agreements, stock purchase agreements, notices of exercise and certificates are shown by default. A document for every holder, such as the plan or the notice of exercise form, is a company resource, published from <b>Stakeholder Portal</b>. A document linked to two or more holders is never shown to holders, so one person's papers never reach another.</li>
        </ul>
      ),
    },
    {
      id: "reports",
      title: "Reports and exports",
      body: (
        <>
          <p>
            On <b>Cap Table</b>, pick any date under <b>As of</b> to see the cap table as it stood that day, and download it.{" "}
            <b>Reports</b> offers:
          </p>
          <DocTable
            label="Reports"
            columns={["Report", "Formats", "As of a date"]}
            rows={[
              ["Cap table", "Excel", "Yes"],
              ["Raw cap table (one row per security)", "CSV or Excel", "Yes"],
              ["Stakeholders", "CSV or Excel", "Yes"],
              ["Vesting details", "Excel", "Yes"],
              ["Exercise history", "Excel", "No: every exercise"],
              ["Audit log", "CSV", "No: every change"],
            ]}
          />
          <p>
            Every report except the audit log is also available as JSON. Exports include personal details such as e-mail addresses,
            phone numbers and addresses, and every download is recorded in the activity log.
          </p>
        </>
      ),
    },
    {
      id: "reversals",
      title: "Correcting a mistake: reversals",
      body: (
        <>
          <p>
            Cap Table never edits history. To correct something, an owner or admin <b>reverses</b> the change that recorded it,
            giving a reason, and then records it again correctly if needed.
          </p>
          <ul>
            <li>A reversal undoes the whole change: reversing an exercise removes the exercise and the shares it created together.</li>
            <li>You can reverse a grant, an exercise, a termination, a cancellation, a Mark executed or a merge: look for <b>Reverse last transaction</b> on a security's page, and <b>Reverse termination</b> or <b>Undo stakeholder merge</b> on a stakeholder's page.</li>
            <li>If something later depends on it (an exercise from a grant, say), reverse that first. The preview shows what depends on what.</li>
            <li>The original stays visible in the history, marked as reversed, with who reversed it, when and why.</li>
            <li>A 409A valuation isn't reversed: record a corrected one, or void it. Imported history can't be reversed in the app.</li>
          </ul>
        </>
      ),
    },
    {
      id: "preview-as-stakeholder",
      title: "Previewing as a stakeholder",
      body: (
        <p>
          Owners, admins and editors can see exactly what a holder sees: choose <b>Preview as stakeholder</b> (the eye icon) next to
          a stakeholder in the list or on their page. A banner says "You are previewing the portal as" their name, and every portal
          action is disabled. It's the quickest way to check a holder's view after an import or a change. To understand what they
          see, read <DocLink to="for-stakeholders">For stakeholders</DocLink>.
        </p>
      ),
    },
    {
      id: "settings",
      title: "Company settings and what holders see",
      body: (
        <ul>
          <li><b>Company › Profile &amp; Settings</b> has the company profile, the company contact for holders, the display decimals, the signatories (view only) and the payment instructions for exercises. Owners and admins edit them; editors view them, with the payment details masked.</li>
          <li>The time zone decides when "today" starts for vesting and deadlines. The share unit (the smallest fraction of a share) can't change once the first record is in.</li>
          <li><b>Stakeholder Portal</b> (under Hire and Retain) decides what holders see: the company contact, the company resources every holder can open, the notice of exercise form, the privacy notice, and the text of the How to exercise page.</li>
        </ul>
      ),
    },
  ],
};
