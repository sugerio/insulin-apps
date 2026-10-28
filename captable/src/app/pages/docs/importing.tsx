import { DocLink, DocTable, type DocTopic } from "./parts.tsx";

// Docs › Importing your cap table: the import wizard, Pulley's reports, the spreadsheet template, the preview and its
// limits. It follows docs/importing.md, the wizard (components/ImportWizard.tsx, ImportPreview.tsx) and the limits in
// the import contract (5 MiB a file, 10 MiB an upload, 25 files).

export const importing: DocTopic = {
  slug: "importing",
  title: "Importing your cap table",
  summary: "Set up a new company from Pulley's reports or the Cap Table spreadsheet template, step by step in your browser.",
  group: "app",
  sections: [
    {
      id: "before-you-start",
      title: "Before you start",
      body: (
        <>
          <ul>
            <li><b>You need to be an owner or admin</b> of the app in the Insulin console, with an e-mail address on your console profile.</li>
            <li>
              <b>The import sets up an empty company.</b> It is available only while the company has no stakeholders and no
              recorded transactions, and nothing else saved yet: no documents or folders, payment instructions, signatories,
              legends or valuations. A company you started empty can still be imported into while it stays empty: it keeps its
              names, time zone, fiscal year end and other settings, and the currency stated in your files takes precedence.
            </li>
            <li><b>Pick a quiet moment.</b> If you're coming from Pulley, ask everyone to stop making changes there until you're done, so that all the reports describe the same day.</li>
            <li><b>Practise in the preview first.</b> The console's preview has its own practice database. Run the whole import there, look around, and only then repeat it in the published app. An import in the published app is permanent.</li>
          </ul>
          <p>
            <b>Where to find it.</b> The first time an owner or admin opens Cap Table, the setup page offers <b>Import from
            Pulley</b> and <b>Import from a spreadsheet</b>. Later, while nothing is recorded, the dashboard shows <b>Import the
            cap table</b>. Once the company has stakeholders or recorded transactions, the import page says "Import isn't
            available for this company" and why: from then on, changes are recorded in the cap table itself.
          </p>
        </>
      ),
    },
    {
      id: "steps",
      title: "The five steps",
      body: (
        <>
          <p>The import shows its five steps as you go:</p>
          <ol>
            <li><b>Choose the source:</b> Pulley's reports, or the Cap Table spreadsheet. If you chose a source on the setup page, the import starts at the next step.</li>
            <li><b>Upload the files</b> and check the as-of date (the date your files describe). Then choose <b>Check the files</b>.</li>
            <li><b>Review the preview:</b> what Cap Table is about to create, any problems to fix, and how the totals compare with your source.</li>
            <li><b>Import:</b> choose <b>Import</b> when no problem is left, and keep the page open until it finishes.</li>
            <li><b>Done:</b> "The cap table is imported" lists what came in, with <b>Open the cap table</b> and <b>Go to the dashboard</b>.</li>
          </ol>
          <p>Nothing is added to the cap table until you import. Until then, your files stay in your browser tab.</p>
        </>
      ),
    },
    {
      id: "pulley-reports",
      title: "From Pulley: the reports to export",
      body: (
        <>
          <p>
            In Pulley, export each report below from the <b>Reports</b> page as an Excel file (.xlsx), all on the same day, without
            renaming their columns. There's no need to rename the files: Cap Table recognizes each report by its sheets and column
            headings.
          </p>
          <DocTable
            label="Pulley reports to export"
            columns={["Report", "What Cap Table uses it for", "What to choose"]}
            rows={[
              ["Raw Cap Table", "The backbone: the company, share classes, equity plans, every security and every stakeholder's totals. Cap Table checks its own numbers against it.", "As of today."],
              ["Detailed Cap Table", "How holdings came about: exercises, cancellations, conversions.", "Nothing special."],
              ["Stakeholders", "Names, e-mail addresses, individual or institution, and relationship to the company.", "Everyone."],
              ["Vesting Details", "Every vesting date and amount, past and future.", "All stakeholders, including terminated ones, with dates from before your first grant to after your last scheduled vesting date."],
              ["Exercised Options", "Every option exercise.", "Nothing special."],
              ["ISO/NSO Details", "How each option grant splits between ISO and NSO.", "Nothing special."],
            ]}
          />
          <p>
            All six are required. <b>Stakeholder Transactions</b> reports are optional: Cap Table reads them for information only,
            and they don't change any number. Excel files are best; the single-sheet reports can also be uploaded as
            comma-separated CSV files.
          </p>
        </>
      ),
    },
    {
      id: "spreadsheet-template",
      title: "From the spreadsheet template",
      body: (
        <>
          <p>
            For companies that don't use Pulley, choose <b>Download the template</b> on the setup page or in the import. It's an
            Excel workbook with an <b>Instructions</b> sheet, which explains every column with an example, and eight data sheets:
          </p>
          <DocTable
            label="The spreadsheet template's sheets"
            columns={["Sheet", "What goes in it"]}
            rows={[
              ["Company", "Exactly one row: the company name, the as-of date every balance represents, and the currency (blank means USD)."],
              ["Stakeholders", "One row per person or organization, with your own ID for each, their type, relationship and e-mail, and a termination date and type for anyone who has left."],
              ["Share classes", "Each class: common or preferred, the authorized shares, and optionally the original issue price and, for preferred, a conversion ratio."],
              ["Equity plans", "Each plan: the share class it delivers, the pool size, the effective date and the exercise window after termination."],
              ["Shares", "One row per certificate or share lot: holder, class, shares, issue date and price per share."],
              ["Options", "One row per grant: holder, plan, ISO or NSO, options granted, exercise price, dates, the vesting schedule, and what has been exercised or cancelled."],
              ["Warrants", "Each warrant: holder, class, shares, exercise price, issue and expiration dates."],
              ["SAFEs", "Each SAFE: holder, principal, issue date, valuation cap, discount, and post-money or pre-money."],
            ]}
          />
          <p>Rules for every sheet:</p>
          <ul>
            <li>Give every row its own ID, and use those IDs to link rows: a stakeholder, share class or plan ID must match a row on its sheet.</li>
            <li>Write dates as YYYY-MM-DD. Type numbers exactly, without formulas, with at most 12 decimal places.</li>
            <li>Include at least one share, option, warrant or SAFE, and at most 2,000 of them in all.</li>
            <li>Leave the sheet names and column headings as they are, and save the workbook as .xlsx.</li>
          </ul>
          <p>
            Where the template is silent, Cap Table uses a stated default and lists it in the preview: for example a conversion
            ratio of 1, a 90-day exercise window, and unused plan shares returning to the pool. Option grants from the template vest
            monthly, quarterly or annually from their vesting start date.
          </p>
        </>
      ),
    },
    {
      id: "files-and-limits",
      title: "Files and limits",
      body: (
        <>
          <DocTable
            label="Upload limits"
            columns={["Source", "What to upload", "Limits"]}
            rows={[
              ["Pulley", "All the reports at once, as Excel or CSV files.", "Up to 5 MiB each and 25 files. Together they must fit in one upload of 10 MiB (the wizard allows 9.9 MiB of files, leaving room for the upload itself)."],
              ["Spreadsheet", "The one workbook, as an Excel file (.xlsx).", "Up to 5 MiB."],
            ]}
          />
          <p>
            Cap Table refuses a file that breaks these limits and says why. A file with the same name as one you already chose
            replaces it, which is handy for a corrected export.
          </p>
          <p>
            <b>The as-of date</b> is the date your files describe. You can leave it empty: Cap Table then uses the date the Pulley
            exports state, or the as-of date on the spreadsheet's Company sheet. When the import also creates the company, you
            give its time zone, jurisdiction (such as US-DE) and fiscal year end too; the company's name comes from the files.
          </p>
        </>
      ),
    },
    {
      id: "reading-the-preview",
      title: "Reading the preview",
      body: (
        <>
          <p><b>Review the preview</b> shows what Cap Table is about to create, in this order:</p>
          <ul>
            <li><b>The files checked</b>, each with what it was recognized as, and the as-of date and currency the company will use.</li>
            <li><b>Problems to fix.</b> Each one blocks the import, says what is wrong and shows where: file › sheet › row › column. <b>Import</b> stays off while any problem remains.</li>
            <li><b>Warnings.</b> They don't stop the import, but make sure each one is what you expect.</li>
            <li><b>Opening balances:</b> holdings recorded as a starting balance on a date, each with its reason (see <DocLink to="importing" section="opening-balances">below</DocLink>).</li>
            <li><b>Assumptions:</b> the choices Cap Table made where your files leave something open, such as a default it applied.</li>
            <li><b>Totals:</b> what will be imported (stakeholders, share classes, plans, securities and transactions), the company's fully diluted and issued and outstanding shares after the import, and, for Pulley, each total the reports state next to the same total computed from the import, marked <b>Matches</b> or <b>Differs</b>. For Pulley they must match exactly. The spreadsheet states no totals, so check the figures against your own records.</li>
          </ul>
        </>
      ),
    },
    {
      id: "fixing-problems",
      title: "Fixing problems",
      body: (
        <>
          <p>
            Correct a problem at its source: in Pulley (then export the affected report again) or in your workbook. Then choose{" "}
            <b>Upload corrected files</b>, which takes you back to the upload, and <b>Check the files</b> again. Some problems you
            may see:
          </p>
          <ul>
            <li><b>A required report is missing,</b> or two files are the same report: add the missing export, or remove the extra file.</li>
            <li><b>A record names a stakeholder who isn't in the files:</b> add the stakeholder, or correct the ID.</li>
            <li><b>A date out of order:</b> something dated after the as-of date, an exercise before its grant, or an as-of date after today.</li>
            <li><b>Totals that differ from Pulley's:</b> usually reports exported on different days, or a Vesting Details report without terminated stakeholders or future dates.</li>
            <li><b>A value with more than 12 decimal places:</b> round it in the source. Cap Table never rounds behind your back.</li>
            <li><b>An instrument Cap Table doesn't handle</b> (RSUs, SARs, phantom stock, convertible notes): deal with it outside the app first.</li>
            <li><b>Shares that Pulley shows as transferred:</b> Pulley's reports don't say which holding each transfer created, so the import stops there. The spreadsheet template lets you enter each holder's current shares directly.</li>
          </ul>
        </>
      ),
    },
    {
      id: "opening-balances",
      title: "Opening balances",
      body: (
        <>
          <p>
            Your files describe what everyone holds today very well, but they don't always contain every step of how it got there.
            For example, the template records how many options were exercised, but not when.
          </p>
          <p>
            When Cap Table can't rebuild a holding's history step by step, it records the holding as an <b>opening balance</b>: the
            right quantity, vesting and status, without inventing the steps in between. Your current cap table, ownership and
            vesting are exactly right; only the history is shorter. If you look at the cap table as of an earlier date, it says that
            the history before that date came in with the import as opening balances. The preview lists every opening balance with
            its reason before you import.
          </p>
        </>
      ),
    },
    {
      id: "after-the-import",
      title: "Importing, and what comes after",
      body: (
        <>
          <ul>
            <li><b>When it's done,</b> "The cap table is imported" lists what was imported.</li>
            <li><b>If it fails,</b> nothing becomes visible. The page says "Nothing was imported" with the reason, and you can import again.</li>
            <li><b>If the connection drops</b> before the answer arrives, the page says "The import's outcome isn't known yet". Choose <b>Check the import</b> to find out what happened, or <b>Try again</b>: repeating the same import is safe.</li>
            <li><b>The import happens once.</b> It can't be taken back, because the cap table keeps a permanent history. To start again from scratch, create a new app from Cap Table in the Insulin console, which comes with a new, empty database.</li>
          </ul>
          <h3>What isn't imported</h3>
          <ul>
            <li><b>Documents and files</b>: upload agreements, board consents, certificates, plan documents and valuation reports afterwards. Each imported share lot does get a certificate record with its number.</li>
            <li><b>Valuations</b>: record your 409A valuations yourself.</li>
            <li><b>Signatures</b>: Cap Table can't tell which agreements were still waiting for signatures, so imported grants count as signed.</li>
            <li><b>Workflow records</b> kept in Pulley, such as exercise requests, 83(b) elections and notes, and Pulley's own accounts and settings.</li>
          </ul>
          <h3>Where your data goes</h3>
          <p>
            Only to this app. Cap Table reads the files you upload and stores what it imports in the app's own database; nothing is
            sent to Pulley or any other service, and Cap Table never signs in to Pulley. Your files aren't kept: the app keeps only
            a record of what you reviewed (a fingerprint of each file, the as-of date and the counts), so that the import matches
            it exactly. Then follow <DocLink to="getting-started" section="after-setup">the checklist for after setup</DocLink>.
          </p>
        </>
      ),
    },
  ],
};
