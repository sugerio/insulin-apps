import { DocLink, InApp, type DocTopic } from "./parts.tsx";

// Docs › Canadian tax basics: the background a person needs to prepare a household's returns. General information.

export const taxBasics: DocTopic = {
  slug: "tax-basics",
  title: "Canadian tax basics",
  summary: "The return, the deadline, slips and the notice of assessment, in plain words.",
  group: "tax",
  generalInformation: true,
  sections: [
    {
      id: "the-return",
      title: "The T1 return",
      body: (
        <>
          <p>
            Each person who lives in Canada files their own income tax and benefit return for a calendar year, called the T1. It reports their income
            and claims their deductions and credits. The return works out federal tax and the tax of the province they lived in on December 31.
          </p>
          <InApp>one return per adult, prepared from the facts in the household and, later, the documents you upload.</InApp>
        </>
      ),
    },
    {
      id: "deadline",
      title: "The filing deadline",
      body: (
        <p>
          For most people, the return and any balance owing are due on April 30 of the next year: April 30, 2026 for the 2025 tax year. People who are
          self-employed, and their spouses, have until June 15 to file, but any balance is still due on April 30.
        </p>
      ),
    },
    {
      id: "slips",
      title: "Slips and receipts",
      body: (
        <>
          <p>Employers, banks and others send slips that report income and amounts paid. Common ones:</p>
          <ul>
            <li>
              <b>T4:</b> employment income, and the tax, CPP and EI taken off your pay.
            </li>
            <li>
              <b>T5:</b> interest and dividends from a bank or broker.
            </li>
            <li>
              <b>RRSP contribution receipt:</b> money you put into a registered retirement savings plan.
            </li>
            <li>
              <b>T4FHSA:</b> contributions to and withdrawals from a first home savings account.
            </li>
          </ul>
          <p>You also keep receipts for amounts you claim, such as donations and medical expenses.</p>
        </>
      ),
    },
    {
      id: "notice-of-assessment",
      title: "The notice of assessment",
      body: (
        <>
          <p>
            After the CRA processes a return, it sends a notice of assessment. It confirms the result, and shows amounts for the next year, such as
            your RRSP deduction limit and any unused amounts you can carry forward.
          </p>
          <InApp>in a later version, you upload last year's notice with this year's documents, and the app reads those amounts from it.</InApp>
        </>
      ),
    },
    {
      id: "spouses",
      title: "Spouses and common-law partners",
      body: (
        <>
          <p>
            You are <b>married</b> if you are legally married. You generally live <b>common-law</b> if you live with your partner in a conjugal
            relationship and either have lived together for at least 12 months in a row, or have a child together. The CRA's definition has more
            detail.
          </p>
          <p>
            Each spouse files their own return. Some amounts can be claimed by either one, such as donations and medical expenses, so it can matter
            who claims them. See <DocLink to="household" section="start-a-year">Start a year: who is in it</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: "province",
      title: "Province of residence",
      body: (
        <p>
          Your provincial tax is the tax of the province you lived in on December 31, even if you lived somewhere else for part of the year. Quebec
          residents also file a separate Quebec return.
        </p>
      ),
    },
  ],
};
