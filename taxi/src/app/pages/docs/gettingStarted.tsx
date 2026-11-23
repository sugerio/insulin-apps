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
            Taxi prepares your Canadian income tax return (the T1), and your spouse's or common-law partner's if you have one. 
            You describe yourself and your family, and the app works out each return.
          </p>
          <p>
            The app doesn't file anything with the CRA. When a return is done, you get the CRA's own forms, filled in, to sign and mail. You can also
            copy the numbers into certified tax software.
          </p>
          <p>
            <b>United States:</b> when you start a year, choose Canada or the United States. A US year prepares the federal Form 1040 of a U.S.
            citizen or resident alien for the whole year, in every filing status (single, married filing jointly or separately, head of
            household, qualifying surviving spouse), with wages (W-2) and interest (1099-INT), the standard deduction, the 2025 deduction for
            seniors, and dependants with the child tax credit and the credit for other dependents. It prepares no state return, can't print the
            IRS forms or read them by AI yet, and says on the return when something it doesn't handle yet applies, such as the earned income
            credit.
          </p>
          <p>
            <b>Who it is for:</b> residents of every province and territory, also in the year they moved to or from Canada (except in Quebec),
            with income from work, pensions, EI, investments, self-employment (a business, a profession, farming or fishing), rent or abroad. For
            a Quebec resident it also prepares the Quebec return (TP-1) from the RL slips, and prints it on Revenu Québec's forms, in English or
            French, after the federal ones: the two returns are mailed apart, the federal one to the CRA and the TP-1 to Revenu Québec, each
            signed. It doesn't yet prepare a Quebec return for the year of a move to or from Canada, with a T-slip that comes without its RL slip
            (such as a T4 for work outside Quebec, or a T2202 from a school outside Quebec), or with a few kinds of income the Quebec return
            treats on lines of its own (such as scholarships, RDSP income, taxable FHSA withdrawals or workers' compensation): it says so on the
            return.
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
            First add the people in the profile under <b>Profile</b>. Then open <b>Returns</b> and start the tax year, choosing who is in it (only you, to begin with). To change who is in it later, use <b>Change</b> under the year on <b>Returns</b>.
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
              <DocLink to="profile">Profile and personal info</DocLink>.
            </li>
            <li>
              <b>Upload documents.</b> Choose a folder or files (PDF, PNG or JPEG). AI reads each file: slips, RRSP, donation and medical receipts,
              and last year's notice of assessment. A document with the other person's name on it goes to their return. A slip with a child's name isn't
              added, since they have no return here, but a receipt for them (a medical or child care receipt) is. A slip whose name matches no one in the
              year stays in this return, marked to check whose it is. A file with the same name as one in this return replaces it and the slips read from it, and is read again. A file
              with the same content as one under another name isn't saved again, nor is a slip that adds nothing to one already here. A reading with anything more
              (a clearer scan, say) is added as a slip of its own: when it may be the same slip as one already here, the message says so, to check at Confirm. A file uploaded by mistake can be deleted,
              with the slips read from it. Choosing a file's name downloads it as it was uploaded. You can also type slips in at Confirm.
            </li>
            <li>
              <b>Income.</b> What is on your return: the slips found (employment, pensions and benefits, EI, interest and dividends, mutual
              funds, sales of investments), each opening into its boxes to check and change (a changed slip is confirmed again at Confirm).
              Under <b>Add to your return</b>, add the other kinds of income you had. One added without its slip is missing, to upload or enter
              right there. Self-employment, rental income, income earned abroad and a sale of real estate are groups: their card asks what
              they need, and shows a part only once it applies (a class's capital cost allowance once you pick the class, the years of a
              home that was your residence only some of the years). What you don't add counts as none. For a Quebec resident whose T4s show
              more employment income than their RL-1s, Income also asks for the benefits Quebec doesn't tax, such as a monthly public transit
              pass your employer provided for getting to work: it is in T4 box 14 but not in RL-1 box A. Enter the whole difference, to the
              cent, if all of it is such benefits; Finish points back to this question when the slips still don't match.
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
              one. A single parent with a child under 18 adds the child's net income, which lowers the amount for an eligible dependant.
              Only the amounts that can change the return appear.
            </li>
            <li>
              <b>Confirm.</b> The slips (T4, T5, T3, T5008, T2202), receipts and notices of assessment, read by AI or entered. Check each one against the paper slip (a
              box AI wasn't sure of is marked; <b>Download the original file</b> saves the file a slip was read from, to look at beside it), then
              confirm them. While a slip is being changed, save or cancel it first. When the slips change meanwhile (an upload finishing, say),
              Confirm waits until they are shown again; what you typed stays, unless someone else changed that slip (it then shows theirs) or
              removed it (it closes, saying so). A box AI couldn't read at all shows as <i>couldn't be read</i>: enter it with
              Edit (0 if it is blank on the paper slip) before the slip can be confirmed. A T5008 often has no cost (box 20): type it in from your records, or the gain
              can't be worked out. Changing a slip makes it unconfirmed again. A slip that may be the same as one above it (the same kind, from the same issuer,
              with no box holding a different amount) says so: if it is, remove one; if they're different slips, keep both. A slip that is the other
              person's can be moved to their return.
            </li>
            <li>
              <b>Finish.</b> The return's refund or balance owing, its key lines with why each is what it is, and what to check before filing.
              Under <b>Check and save</b>, hints show ways to pay less, such as claiming both spouses' donations on one return, with what each saves
              on the year's returns. <b>Apply</b> changes your answers; <b>Undo</b> puts them back. If you later change an answer a saving set, it is no longer applied, and shows as a hint again if it still saves something.{" "}
              <b>Before you file</b> lists, with a link to each, what keeps the return from its forms: something on Personal info (such as your
              province on December 31), a slip not confirmed, a kind of income added without its slip, a question not answered, and for a couple,
              what is left on the other person's Personal info or slips, as each return reads the other. When nothing is left before filing,{" "}
              <b>Download the forms</b> saves one PDF: the CRA's T1, the schedules and forms your return uses and the provincial forms, filled in
              with your name, date of birth, marital status, province and amounts, and a worksheet that shows how each amount was worked out. The
              first time, Taxi downloads each official form, so it says it is preparing them; if they can't be printed (canada.ca doesn't answer,
              say), it says why, and you can try again. Add
              your social insurance number, address and the other Step 1 answers by hand, sign the T1 and mail it, or copy the amounts into
              NETFILE-certified software. <b>Forms to fill in yourself</b> names any form your return needs that Taxi doesn't print, such as
              Revenu Québec's Schedule D for the solidarity tax credit, or Manitoba's Schedule MB428-A; the worksheet names them too.
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
            federal tax, provincial or territorial tax (for a Quebec resident, the Quebec refund or balance instead), the total payable, the tax already deducted, and the refund or
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
              ["Owner, Admin, Editor", "Add and change the people in the profile, start a tax year, enter and confirm slips, and answer the questions."],
              ["Viewer", "See the profile and every return, but change nothing."],
              ["Custom role", "What its permissions allow: Prepare returns (which includes viewing), or View returns."],
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
            December 31, and each adult's province and whether they lived in Canada all year. For each return: its slips, your answers and the
            hints you applied. A file that is saved is kept as you uploaded it, until you delete it or a new version of it is read. Every change records who made it and when.
          </p>
          <p>
            Each uploaded file is sent to Anthropic's Claude to be read, with your organization's own Anthropic credential (set on the app's
            Integrations page).
          </p>
          <p>
            <b>Never asked for:</b> a social insurance number (SIN), a home address or bank details. You write those on the paper return when you
            sign it. An uploaded slip is kept as it was uploaded, so the SIN and address printed on it are in the file until you delete it or a new version of it is read.
          </p>
        </>
      ),
    },
    {
      id: "usage-reports",
      title: "Usage reports every hour",
      body: (
        <p>
          Once an hour, the app sends Insulin Apps a count of its records for each organization: profiles, people, tax years, returns and
          uploaded files, the bytes each organization stores (its files and its copies of the official forms), and the size of its database. It never sends a name, a birth date, an amount or a document.
        </p>
      ),
    },
  ],
};
