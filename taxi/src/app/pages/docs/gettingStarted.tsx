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
            First add the household's people under <b>Household</b>. Then open <b>Returns</b> and start the tax year, choosing who is in it (only you, to begin with). To change who is in it later, use <b>Change</b> under the year on <b>Returns</b>.
            You and your spouse or partner each have a return, and you work on one return at a time. The return you are on is named above
            the steps; select it to switch to the other return. Each return has six steps, and a step that is done shows a check mark.
          </p>
          <p>
            Your marital status and who is in the year are the same on both returns. Both returns are worked out together, so each one can
            use the other's numbers, such as the spouse amount.
          </p>
          <ol>
            <li>
              <b>Personal info.</b> The marital status on December 31, and this person's province. See{" "}
              <DocLink to="household">The household</DocLink>.
            </li>
            <li>
              <b>Upload documents.</b> Choose a folder or files (PDF, PNG or JPEG). AI reads each file into slips. A slip with the other
              person's name on it goes to their return. A file with the same name as one in this return replaces it and the slips read from it, and is read again. A file
              with the same content as one under another name isn't saved again. A file uploaded by mistake can be deleted,
              with the slips read from it. You can also type slips in step 4.
            </li>
            <li>
              <b>What applies.</b> The slips found in your documents, with their files; for the kinds of slips not found
              (employment, interest and dividends, mutual funds, sales of investments, tuition), whether you have one, and a yes without the slip
              is missing, to upload right there or type in at step 4; and yes or no to what the app doesn't handle yet, such as self-employment or
              rent.
            </li>
            <li>
              <b>Confirm.</b> The slips (T4, T5, T3, T5008, T2202), read by AI or entered box by box. Check each one against the paper slip (a
              box AI wasn't sure of is marked), then confirm them. Changing a slip makes it unconfirmed again. A slip that is the other
              person's can be moved to their return.
            </li>
            <li>
              <b>Deductions.</b> RRSP and FHSA contributions, medical expenses, donations, unused tuition, and the other amounts the return
              needs. Only the questions that can change a return appear.
            </li>
            <li>
              <b>Finish.</b> The return's refund or balance owing, its key lines with why each is what it is, and what to check before filing.
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
            Beside the steps after personal info, <b>Estimate</b> shows the return's key lines: total income, net income, taxable income, net
            federal tax, provincial tax (Ontario, British Columbia or Alberta), the total payable, the tax already deducted, and the refund or
            balance owing. When both returns are prepared together, each uses the other's numbers, such as the spouse amount; the line's
            "why" shows them.
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
