import { DocLink, InApp, type DocTopic } from "./parts.tsx";

// Docs › US tax basics: the background a person needs to prepare a US federal return. General information.

export const usTaxBasics: DocTopic = {
  slug: "us-tax-basics",
  title: "US tax basics",
  summary: "Form 1040, the deadline, filing status, the forms you get and the standard deduction, in plain words.",
  group: "tax",
  generalInformation: true,
  sections: [
    {
      id: "form-1040",
      title: "Form 1040",
      body: (
        <>
          <p>
            A U.S. citizen or resident files Form 1040 with the IRS (the Internal Revenue Service) for each calendar year. It reports income, takes
            deductions and credits, and works out the federal tax. Each state has its own return.
          </p>
          <InApp>a US year prepares the federal Form 1040 only, and prints it on the IRS's own forms to sign and mail.</InApp>
        </>
      ),
    },
    {
      id: "deadline",
      title: "The filing deadline",
      body: (
        <p>
          For the 2025 tax year, the return and any tax you owe are due on April 15, 2026. Form 4868 gives you until October 15, 2026 to file, but
          not to pay.
        </p>
      ),
    },
    {
      id: "filing-status",
      title: "Filing status",
      body: (
        <>
          <p>
            Your filing status is single, married filing jointly, married filing separately, head of household, or qualifying surviving spouse.
            Whether you are married on December 31, and who lives with you, decide which ones you can use. Filing jointly, a married couple files
            one return with both incomes. It usually costs less: filing separately gives up several credits and deductions.
          </p>
          <InApp>
            a married couple chooses on Personal info. Finish shows a hint when the other choice would cost the two of you less, worked out from
            what you entered.
          </InApp>
        </>
      ),
    },
    {
      id: "forms",
      title: "Forms you get",
      body: (
        <>
          <p>Employers, banks, schools and lenders send forms that report what they paid you or what you paid them. Common ones:</p>
          <ul>
            <li>
              <b>Form W-2:</b> wages from an employer, and the tax taken off your pay. Due to you by January 31.
            </li>
            <li>
              <b>Form 1099-INT:</b> interest from a bank, sent when it paid you $10 or more.
            </li>
            <li>
              <b>Form 1099-NEC:</b> pay from a business for work as a contractor, sent when it paid you $600 or more.
            </li>
            <li>
              <b>Form 1098-T:</b> tuition a college was paid for a student. It starts the education expenses: the credit counts only some of them.
            </li>
            <li>
              <b>Form 1098-E:</b> interest a lender received on a student loan, sent when it was $600 or more.
            </li>
          </ul>
          <InApp>upload them on Upload documents: AI reads each one into the return of the person named on it.</InApp>
        </>
      ),
    },
    {
      id: "standard-deduction",
      title: "The standard deduction",
      body: (
        <p>
          Most people take the standard deduction instead of listing their deductions (itemizing). For 2025 it is $15,750 for a single person or for
          each spouse filing separately, $31,500 for a married couple filing jointly, and $23,625 for a head of household. It is larger at 65 or
          older and for a blind person.
        </p>
      ),
    },
    {
      id: "ssn",
      title: "The social security number",
      body: (
        <p>
          Each person on the return, and each dependant, needs a social security number or another taxpayer identification number. Some credits need
          a social security number valid for work. Taxi never asks for the number: you write it on the paper return. See also{" "}
          <DocLink to="glossary">the glossary</DocLink>.
        </p>
      ),
    },
  ],
};
