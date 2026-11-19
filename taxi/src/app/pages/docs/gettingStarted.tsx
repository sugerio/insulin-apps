import { DocLink, DocTable, type DocTopic } from "./parts.tsx";

// Docs › Getting started: what the app does, the seven steps of a tax year, who can do what, and what it stores.

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
            <b>Who it is for:</b> residents of Ontario, British Columbia and Alberta who lived in Canada all year, with income from work,
            pensions, EI, investments, self-employment (a business, a profession, farming or fishing), rent or abroad. It doesn't handle
            Quebec returns or pension income splitting yet.
          </p>
        </>
      ),
    },
    {
      id: "steps",
      title: "A tax year in seven steps",
      body: (
        <>
          <p>
            First add the household's people under <b>Household</b>. Then open <b>Returns</b> and start the tax year, choosing who is in it (only you, to begin with). To change who is in it later, use <b>Change</b> under the year on <b>Returns</b>.
            You and your spouse or partner each have a return, and you work on one return at a time. The return you are on is named above
            the steps; select it to switch to the other return. Each return has seven steps, in a row above the page, and a step that is
            done shows a check mark.
          </p>
          <p>
            Your marital status and who is in the year are the same on both returns. Both returns are worked out together, so each one can
            use the other's numbers, such as the spouse amount.
          </p>
          <ol>
            <li>
              <b>Personal info.</b> The marital status on December 31, this person's province, and a spouse's net income when their return isn't prepared here. See{" "}
              <DocLink to="household">The household</DocLink>.
            </li>
            <li>
              <b>Upload documents.</b> Choose a folder or files (PDF, PNG or JPEG). AI reads each file: slips, RRSP, donation and medical receipts,
              and last year's notice of assessment. A document with the other person's name on it goes to their return. A file with the same name as one in this return replaces it and the slips read from it, and is read again. A file
              with the same content as one under another name isn't saved again. A file uploaded by mistake can be deleted,
              with the slips read from it. You can also type slips in at Confirm.
            </li>
            <li>
              <b>Income.</b> What is on your return: the slips found (employment, pensions and benefits, EI, interest and dividends, mutual
              funds, sales of investments), each opening into its boxes to check and change (a changed slip is confirmed again at Confirm).
              Under <b>Add to your return</b>, add the other kinds of income you had. One added without its slip is missing, to upload or enter
              right there. Self-employment, rental income, income earned abroad and a sale of real estate are groups: their card asks what
              they need, and shows a part only once it applies (a class's capital cost allowance once you pick the class, the years of a
              home that was your residence only some of the years). What you don't add counts as none.
            </li>
            <li>
              <b>Deductions.</b> RRSP and FHSA contributions (RRSP receipts and your notice of assessment give a starting amount, up to
              your deduction limit), working from home (with a T2200 from your employer), child care (entered once for a couple: the
              spouse with the lower income claims it, and the other a part when the lower-income spouse was a student, infirm, in prison
              or living apart, Form T778 Part C) and moving expenses. <b>From your slips</b> shows what your slips already deduct, such as union dues.
            </li>
            <li>
              <b>Credits.</b> Tuition (T2202, and unused tuition from last year), medical expenses and donations, and what your slips
              already claim, such as CPP and EI contributions. Uploaded donation and medical receipts are added; enter only what isn't on
              one. Only the amounts that can change the return appear.
            </li>
            <li>
              <b>Confirm.</b> The slips (T4, T5, T3, T5008, T2202), receipts and notices of assessment, read by AI or entered. Check each one against the paper slip (a
              box AI wasn't sure of is marked), then confirm them. Changing a slip makes it unconfirmed again. A slip that is the other
              person's can be moved to their return.
            </li>
            <li>
              <b>Finish.</b> The return's refund or balance owing, its key lines with why each is what it is, and what to check before filing.
              Under <b>Check and save</b>, hints show ways to pay less, such as claiming both spouses' donations on one return, with what each saves
              for the household. <b>Apply</b> changes your answers; <b>Undo</b> puts them back. When nothing is left before filing,{" "}
              <b>Download the forms</b> gives one PDF: the CRA's T1, the schedules and forms your return uses and the provincial forms, filled in
              with your name, date of birth, marital status, province and amounts, and a worksheet that shows how each amount was worked out. Add
              your social insurance number, address and the other Step 1 answers by hand, sign the T1 and mail it, or copy the amounts into
              NETFILE-certified software.
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
            Above each step but Finish, <b>Estimate</b> shows the refund or balance owing; <b>Details</b> opens the return's key lines: total income, net income, taxable income, net
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
