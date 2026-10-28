import { DocLink, DocTable, type DocTopic } from "./parts.tsx";

// Docs › Getting started: what the app does, the roles, preview mode and the first-run setup. It follows README.md
// ("What it does", "Good to know", "Who can do what") and docs/importing.md ("Where to find the import").

export const gettingStarted: DocTopic = {
  slug: "getting-started",
  title: "Getting started",
  summary: "What Cap Table does, who can do what, and how a company is set up.",
  group: "app",
  sections: [
    {
      id: "what-cap-table-does",
      title: "What Cap Table does",
      body: (
        <>
          <p>
            Cap Table is your company's equity record. It keeps track of who owns what (shares, stock options, warrants and
            SAFEs), how each holding came about, and how it vests.
          </p>
          <ul>
            <li><b>The cap table, as of any date.</b> Issued and outstanding shares, fully diluted ownership, every share class and equity plan, and every holder's position, worked out from the full history for whichever date you pick.</li>
            <li><b>Stakeholders.</b> Founders, employees, advisors, investors and institutions, with their details and e-mail addresses.</li>
            <li><b>Option grants and vesting.</b> Record a signed grant from an equity plan. Cap Table works out the vesting, what can be exercised, and every deadline.</li>
            <li><b>Exercises, terminations and cancellations.</b> Before anything is saved, a review shows exactly what will change.</li>
            <li><b>409A valuations, documents and reports.</b> Keep valuations and agreements with the records they belong to, and download the cap table and its records.</li>
            <li><b>A view for every holder.</b> Employees, advisors and investors see their own holdings, and nobody else's.</li>
            <li><b>A permanent history.</b> Every change is recorded with who made it and when. A mistake is corrected by reversing the change, never by rewriting history.</li>
          </ul>
          <h3>Good to know</h3>
          <ul>
            <li><b>Holdings come in when the company is set up.</b> Share classes, equity plans, issued shares, option grants, warrants and SAFEs are imported. After that, Cap Table records new option grants, exercises, terminations and cancellations; it has no forms to add share classes or plans, or to issue shares.</li>
            <li><b>No e-mail.</b> Cap Table doesn't send messages. Tell people yourself when something changes for them.</li>
            <li><b>No signatures or payments.</b> Agreements are signed elsewhere and uploaded. Payments happen outside the app and are recorded in it.</li>
            <li><b>Not a valuation, tax or legal service.</b> Cap Table records 409A valuations but doesn't perform them, and it doesn't file tax forms or give advice.</li>
            <li><b>Instruments it doesn't handle:</b> RSUs, SARs, phantom stock, convertible notes and profits interests.</li>
          </ul>
        </>
      ),
    },
    {
      id: "who-can-do-what",
      title: "Who can do what",
      body: (
        <>
          <p>
            Cap Table uses the role each person has on the app in the Insulin console. There are no separate accounts or
            passwords: everyone opens Cap Table from the console.
          </p>
          <DocTable
            label="Console roles and what they allow"
            columns={["Console role", "In Cap Table"]}
            rows={[
              ["Owner, Admin", "Manage the cap table: set up the company, import, add and edit stakeholders, record grants, exercises, terminations and cancellations, record valuations, upload documents, change the settings and download reports."],
              ["Editor", "See everything, including personal details such as e-mail addresses and phone numbers, and download reports. Change nothing."],
              ["User, Viewer", "See only their own holdings: the stakeholder records that carry the e-mail address of their console account."],
            ]}
          />
          <ul>
            <li><b>Holders are matched by e-mail.</b> A User or Viewer sees a stakeholder record when it lists the e-mail address of their console account as the person's own address (not as a contact for an institution). Capital letters don't matter. If someone sees no holdings, an owner or admin adds their console e-mail address to their stakeholder record.</li>
            <li><b>One person, several records.</b> Someone who holds equity personally and through, say, a trust sees every record that lists their address as its own.</li>
            <li><b>Owners and admins need an e-mail address on their console profile</b> to make changes.</li>
            <li><b>Nobody records changes to their own holdings.</b> Cap Table refuses a change to a stakeholder, or to their holdings, when the record carries the e-mail address of the owner or admin making it. Another owner or admin has to record it.</li>
            <li><b>Choose editors with care.</b> In the console, an editor can also publish the app, which is much more than viewing. Give the role only to people you would trust with the whole cap table.</li>
          </ul>
          <h3 id="preview-mode" tabIndex={-1}>Preview mode</h3>
          <p>
            When you try Cap Table in the console's preview, or run it on your own computer, there is no console account behind
            you. Cap Table then treats you as a stand-in owner, the "Preview admin", and a <b>Preview mode</b> strip at the top of
            every page says so. The preview keeps its own practice database: nothing you do there reaches the published app.
            Once the app is published, everyone opens it from the console with their own role.
          </p>
        </>
      ),
    },
    {
      id: "setting-up",
      title: "Setting up your company",
      body: (
        <>
          <p>
            Cap Table keeps one company's cap table: there is one company per app. To keep another company's cap table, create
            another app from Cap Table in the Insulin console.
          </p>
          <p>The first owner or admin to open the published app chooses how to start:</p>
          <ul>
            <li><b>Start with an empty company.</b> Enter the company's name, legal name, state and date of incorporation, time zone and fiscal year end. The time zone decides when "today" starts for vesting and deadlines. You can import into the company later, as long as nothing has been added to it yet.</li>
            <li><b>Import from Pulley.</b> Upload Pulley's standard reports.</li>
            <li><b>Import from a spreadsheet.</b> Download the Cap Table spreadsheet template, fill it in and upload it.</li>
          </ul>
          <p>Until a company is set up, editors and holders see a page saying that Cap Table isn't set up yet.</p>
          <p>
            <b>Practise first.</b> Run the whole import in the console's preview, look around, and only then repeat it in the
            published app: an import in the published app is permanent. <DocLink to="importing">Importing your cap table</DocLink> walks
            through it step by step.
          </p>
        </>
      ),
    },
    {
      id: "after-setup",
      title: "After setup: a checklist",
      body: (
        <ol>
          <li><b>Spot-check.</b> Compare the cap table, as of the import's date, with your source. Open a few stakeholders and <DocLink to="everyday-tasks" section="preview-as-stakeholder">preview what they see</DocLink>.</li>
          <li><b>Upload your documents.</b> Agreements, board consents, certificates, plan documents and valuation reports, each linked to the record it belongs to. Choose which ones holders may see.</li>
          <li><b>Record your current 409A valuation.</b> The import doesn't bring valuations in, and new option grants need a valid one.</li>
          <li><b>Fill in what holders see:</b> the company contact, the How to exercise text and the payment instructions.</li>
          <li><b>Give holders access.</b> Make sure each holder's stakeholder record has, as their own address, the e-mail address of their console account. Then give them the User or Viewer role on the app in the console.</li>
        </ol>
      ),
    },
    {
      id: "finding-your-way",
      title: "Finding your way around",
      body: (
        <>
          <p>Owners, admins and editors see the company workspace. Its sidebar has:</p>
          <ul>
            <li><b>Dashboard:</b> company totals, how much of each equity plan is granted, ownership by group, the largest stakeholders, recent activity, and <b>Needs attention</b>.</li>
            <li><b>Cap Table:</b> ownership by stakeholder and a tab for each kind of security, as of any date. Under it: <b>Share Classes</b>, <b>Equity Plans</b>, <b>Securities Status</b> (lists that need attention) and <b>Vesting</b>.</li>
            <li><b>Compliance &amp; Tax:</b> your 409A valuations.</li>
            <li><b>Hire and Retain:</b> <b>Exercise Requests</b>, <b>Equity Plans</b> and <b>Stakeholder Portal</b> (what holders see).</li>
            <li><b>Stakeholders</b>, <b>Company</b> (with <b>Documents</b>, <b>Reports</b> and <b>Recent Activity</b>) and <b>Certificates</b> (with <b>Legends</b> and <b>Terms</b>).</li>
          </ul>
          <p>
            Owners and admins also have <b>+ New</b> at the top of the sidebar, to record a signed option grant. Holders see{" "}
            <b>Portfolio</b>, <b>How to exercise</b> and <b>Documents</b>. Everyone finds <b>Docs</b> at the bottom of the
            sidebar, and their name, role and the theme switch in the menu at the top right.
          </p>
        </>
      ),
    },
  ],
};
