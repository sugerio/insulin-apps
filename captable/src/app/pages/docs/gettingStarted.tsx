import { DocLink, DocTable, type DocTopic } from "./parts.tsx";

// Docs › Getting started: what the app does (and the usage counts it sends Insulin Apps), the roles and custom roles, AI
// agents, preview mode and the first-run setup. It follows README.md ("What it does", "Good to know", "Who can do what") and docs/importing.md ("Where to find
// the import"). The permissions' names and texts are package.json's `insulin.permissions`.

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
          <h3 id="usage-counts" tabIndex={-1}>Usage counts for Insulin Apps</h3>
          <p>
            On insulinapps.com, Cap Table sends Insulin Apps a few counts every hour, so that Insulin Apps can watch how the app
            is used and plan its capacity. For each organization: whether its company is set up, and how many stakeholders,
            share classes, equity plans, securities, ledger transactions, documents, valuations and exercise requests it has,
            with how much space its documents take. Cap Table also sends the size of its database and how many organizations
            have a company in it.
          </p>
          <p>
            These are counts and sizes only. Cap Table never sends names, e-mail addresses, share numbers, prices or other
            amounts, or documents.
          </p>
        </>
      ),
    },
    {
      id: "who-can-do-what",
      title: "Who can do what",
      body: (
        <>
          <p>
            Cap Table uses the role each person has in your Insulin organization, or on Cap Table alone. There are no separate
            accounts or passwords: everyone signs in to Insulin and opens Cap Table from there.
          </p>
          <DocTable
            label="Roles and what they allow"
            columns={["Role", "In Cap Table"]}
            rows={[
              ["Owner, Admin, Editor", "Manage the cap table: set up the company, import, add and edit stakeholders, record grants, exercises, terminations and cancellations, record valuations, upload documents, change the settings and download reports."],
              ["Viewer (and User, in the Insulin console)", "See only their own holdings: the stakeholder records that carry the e-mail address of their account."],
            ]}
          />
          <ul>
            <li><b>Holders are matched by e-mail.</b> A Viewer sees a stakeholder record when it lists the e-mail address of their account as the person's own address (not as a contact for an institution). Capital letters don't matter. If someone sees no holdings, someone who manages the cap table adds their e-mail address to their stakeholder record.</li>
            <li><b>One person, several records.</b> Someone who holds equity personally and through, say, a trust sees every record that lists their address as its own.</li>
            <li><b>Making changes needs an e-mail address</b> on your profile, so that every change in the history names who made it.</li>
            <li><b>Nobody records changes to their own holdings.</b> Cap Table refuses a change to a stakeholder, or to their holdings, when the record carries the e-mail address of the person making it. Someone else who manages the cap table has to record it.</li>
            <li><b>Choose editors with care.</b> An editor changes the cap table just as an admin does. Give the role only to people you would trust with the whole cap table.</li>
          </ul>
          <h3 id="custom-roles" tabIndex={-1}>Access to Cap Table only, and custom roles</h3>
          <p>
            On insulinapps.com, your organization's owners and admins can give someone access to Cap Table alone, as an Admin,
            Editor or Viewer of the app, instead of a role across the whole organization: <b>Settings › People</b> in Cap Table's
            navigation opens that page. The organization's owner can also make custom roles for Cap Table from three permissions:
          </p>
          <DocTable
            label="The permissions a custom role is made from"
            columns={["Permission", "What it allows"]}
            rows={[
              ["Record changes", "Record and reverse equity changes, run imports and manage documents. Includes viewing the whole cap table."],
              ["View the cap table", "See the whole cap table, stakeholders, reports and documents, read only. Personal details are shown; bank account numbers and the EIN are partly hidden."],
              ["See own holdings", "See their own holdings in the holder view, matched by their e-mail address."],
            ]}
          />
          <p>
            A custom role with <b>View the cap table</b> but not <b>Record changes</b> opens the company workspace and changes
            nothing. Cap Table shows "Custom role" under the person's name for anyone whose role was narrowed this way.
          </p>
          <h3 id="ai-agents" tabIndex={-1}>AI agents and API clients</h3>
          <p>
            On insulinapps.com, people can connect an AI agent, such as Claude or Codex, to Cap Table (<b>Settings › Connect AI</b>),
            and your organization's owners and admins can set up API clients for other systems (<b>Settings › API access</b>). An
            AI agent acts with the role and permissions of the person who connected it, and an API client with the role it was
            given: neither can do anything that role can't. Their changes appear in the history under the person's or the
            client's name, like any other change.
          </p>
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
            Cap Table keeps one company's cap table for each Insulin organization. Switching organizations (with the switcher at
            the top of the navigation on insulinapps.com, or in the Insulin console) switches the company Cap Table opens; each
            organization sets up or imports its own company independently.
          </p>
          <p>The first owner, admin or editor of each organization to open the published app chooses how to start:</p>
          <ul>
            <li><b>Start with an empty company.</b> Enter the company's name, legal name, state and date of incorporation, time zone and fiscal year end. The time zone decides when "today" starts for vesting and deadlines. You can import into the company later, as long as nothing has been added to it yet.</li>
            <li><b>Import from Pulley.</b> Upload Pulley's standard reports.</li>
            <li><b>Import from a spreadsheet.</b> Download the Cap Table spreadsheet template, fill it in and upload it.</li>
          </ul>
          <p>Until a company is set up, everyone else sees a page saying that Cap Table isn't set up yet.</p>
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
          <li><b>Give holders access.</b> Make sure each holder's stakeholder record has, as their own address, the e-mail address of their account. Then give them the Viewer role (User or Viewer in the Insulin console), or a custom role with <b>See own holdings</b>.</li>
        </ol>
      ),
    },
    {
      id: "finding-your-way",
      title: "Finding your way around",
      body: (
        <>
          <p>
            The navigation has two columns. The first lists the parts of Cap Table you can use. When the part you open has pages of
            its own, the second column lists them, with the part's name at the top, and the header above each page shows where you
            are, such as <b>Cap Table › Share Classes</b>.
          </p>
          <p>Owners, admins and editors, and anyone whose custom role lets them view the cap table, see the company workspace, under <b>Essentials</b>:</p>
          <ul>
            <li><b>Dashboard:</b> company totals, how much of each equity plan is granted, ownership by group, the largest stakeholders, recent activity, and <b>Needs attention</b>.</li>
            <li><b>Cap Table:</b> ownership by stakeholder and a tab for each kind of security, as of any date. Beside it: <b>Share Classes</b>, <b>Equity Plans</b>, <b>Securities Status</b> (lists that need attention) and <b>Vesting</b>.</li>
            <li><b>Compliance &amp; Tax:</b> your 409A valuations.</li>
            <li><b>Hire and Retain:</b> <b>Exercise Requests</b>, <b>Equity Plans</b> and <b>Stakeholder Portal</b> (what holders see).</li>
            <li><b>Stakeholders</b>, <b>Company</b> (<b>Profile &amp; Settings</b>, <b>Documents</b>, <b>Reports</b> and <b>Recent Activity</b>) and <b>Certificates</b> (with <b>Legends</b> and <b>Terms</b>).</li>
          </ul>
          <p>
            Holders see their own equity, under <b>My equity</b>: <b>Portfolio</b>, <b>How to exercise</b> and <b>Documents</b>.
            Also in the navigation:
          </p>
          <ul>
            <li><b>+ New</b>, at the top for everyone who records changes, to record a signed option grant.</li>
            <li><b>Docs:</b> these pages, for everyone. On insulinapps.com their topic list ends with <b>Public docs</b>, Cap Table's documentation on the web.</li>
            <li><b>Settings:</b> Cap Table's pages on Insulin Apps: <b>People</b> (who can use Cap Table, with their roles), <b>Integrations</b>, <b>API access</b> (API clients for other systems) and <b>Connect AI</b> (connecting an AI agent). They open on insulinapps.com, where your role there decides what you can change. In the console's preview they are listed without links.</li>
            <li><b>The organization switcher</b> at the top, with your organization's name. On insulinapps.com it lists your other organizations, opens Cap Table in the one you choose, and links to <b>All apps</b> (your home page there) and to creating an organization.</li>
            <li><b>You</b>, at the bottom: your name and role ("Custom role" when your organization narrowed it). Its menu has your e-mail address, <b>Switch theme</b> and, on insulinapps.com, <b>Account</b> and <b>Sign out</b>.</li>
          </ul>
          <p>
            Each column folds down to its icons with the button at its edge (point at an icon to see its name), and Cap Table remembers
            your choice in this browser. On a phone or a narrow window, the menu button at the top opens both columns.
          </p>
        </>
      ),
    },
  ],
};
