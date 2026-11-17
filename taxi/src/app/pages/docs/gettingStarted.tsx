import { DocLink, DocTable, type DocTopic } from "./parts.tsx";

// Docs › Getting started: what the app does, the six steps of a tax year, who can do what, and what it stores.

export const gettingStarted: DocTopic = {
  slug: "getting-started",
  title: "Getting started",
  summary: "What Taxi does, the steps of a tax year, and who can do what.",
  group: "app",
  sections: [
    {
      id: "what-it-does",
      title: "What Taxi does",
      body: (
        <>
          <p>
            Taxi prepares Canadian income tax returns (the T1) for one household: you, and your spouse or common-law partner if you have one.
            You describe the household, and the app works out each return.
          </p>
          <p>
            The app doesn't file anything with the CRA. When a return is done, you get the CRA's own forms, filled in, to sign and mail. You can also
            copy the numbers into certified tax software.
          </p>
          <p>
            <b>Who it is for:</b> residents of Ontario, British Columbia and Alberta who lived in Canada all year. It doesn't handle self-employment,
            rental income, income from outside Canada, or Quebec returns yet.
          </p>
        </>
      ),
    },
    {
      id: "steps",
      title: "A tax year in six steps",
      body: (
        <>
          <p>
            First add the household's people under <b>Household</b>. Then open <b>Returns</b> and start the tax year, choosing who is in it.
            Each year has six steps. The list of steps is beside every page of the year, and a step that
            is done shows a check mark.
          </p>
          <ol>
            <li>
              <b>Household.</b> Who is in the year, your marital status on December 31, and each adult's province. See{" "}
              <DocLink to="household">The household</DocLink>.
            </li>
            <li>
              <b>Upload documents.</b> One folder of slips and receipts, read by AI. This step comes in a later version; until then, enter slips in
              step 4.
            </li>
            <li>
              <b>What applies.</b> For each adult, yes or no to kinds of income and expenses such as self-employment, rent or child care. A yes to
              something the app doesn't handle makes the return say so.
            </li>
            <li>
              <b>Confirm.</b> Each adult's slips (T4, T5, T3, T5008, T2202), entered box by box as printed. Check each one against the paper slip,
              then confirm them. Changing a slip makes it unconfirmed again.
            </li>
            <li>
              <b>Deductions.</b> RRSP and FHSA contributions, medical expenses, donations, unused tuition, and the other amounts each return
              needs. Only the questions that can change a return appear.
            </li>
            <li>
              <b>Finish.</b> Each return's refund or balance owing, its key lines with why each is what it is, and what to check before filing.
              The filled-in CRA forms to download come in a later version.
            </li>
          </ol>
        </>
      ),
    },
    {
      id: "estimate",
      title: "The estimate and why each number is what it is",
      body: (
        <>
          <p>
            Beside the steps after the household, <b>Estimate</b> shows each return's key lines: total income, net income, taxable income, net
            federal tax, provincial tax (Ontario, British Columbia or Alberta), the total payable, the tax already deducted, and the refund or
            balance owing. When both returns are prepared together, each uses the other's numbers, such as the spouse amount.
          </p>
          <p>
            Select a line to see why it is what it is: its formula, the values that went into it, and each number's source, down to the box of
            each slip. A number marked <b>est.</b> uses a usual answer for a question you haven't answered yet, such as no RRSP deduction; the
            estimate lists what it assumed.
          </p>
        </>
      ),
    },
    {
      id: "who-can-do-what",
      title: "Who can do what",
      body: (
        <>
          <p>People and roles are managed on Insulin Apps, under Settings › People. Your role decides what you can do here.</p>
          <DocTable
            label="Roles"
            columns={["Role", "In Taxi"]}
            rows={[
              ["Owner, Admin, Editor", "Add and change the household's people, start a tax year, enter and confirm slips, and answer the questions."],
              ["Viewer", "See the household and every return, but change nothing."],
              ["Custom role", "What its permissions allow: Prepare returns, or View returns."],
            ]}
          />
          <p>
            AI agents and API clients that you connect on Insulin Apps act with the role they were given, and no more. They see the same API as the
            browser: <code>GET /api/catalog</code> lists what they can call.
          </p>
        </>
      ),
    },
    {
      id: "what-is-stored",
      title: "What the app stores",
      body: (
        <>
          <p>
            For each person: their name, their relationship to you and their birth date. For each tax year: who is in it, your marital status on
            December 31, and each adult's province and whether they lived in Canada all year. Every change records who
            made it and when.
          </p>
          <p>
            <b>Never stored:</b> a social insurance number (SIN), a home address or bank details. You write those on the paper return when you sign it.
          </p>
        </>
      ),
    },
    {
      id: "usage-reports",
      title: "Usage reports every hour",
      body: (
        <p>
          Once an hour, the app sends Insulin Apps a count of its records for each organization: households, people, tax years and returns, and the
          size of its database. It never sends a name, a birth date, an amount or a document.
        </p>
      ),
    },
  ],
};
