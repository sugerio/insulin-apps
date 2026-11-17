import { DocLink, type DocTopic } from "./parts.tsx";

// Docs › The household: step 1 of a tax year, field by field.

export const household: DocTopic = {
  slug: "household",
  title: "The household",
  summary: "Step 1 of a tax year: who is in the household, and the facts no document shows.",
  group: "app",
  sections: [
    {
      id: "people",
      title: "Add the people",
      body: (
        <>
          <p>Start with yourself: the person preparing the returns. Then add the others who live with you:</p>
          <ul>
            <li>
              <b>Spouse or partner:</b> your spouse or common-law partner. There can be one.
            </li>
            <li>
              <b>Child</b> or <b>other dependant:</b> someone you support, such as a child or a parent who lives with you.
            </li>
          </ul>
          <p>
            For each person, enter their name and birth date. Use the names as they appear on their tax slips: in a later step, AI uses the names to
            decide whose document each file is. People stay in the household from one year to the next. You can't remove yourself.
          </p>
        </>
      ),
    },
    {
      id: "marital-status",
      title: "Marital status on December 31",
      body: (
        <>
          <p>
            Choose your status on the last day of the year, as the T1 asks it: married, living common-law, widowed, divorced, separated or single. If
            your status changed during the year, the status on December 31 is the one that counts.
          </p>
          <p>
            If you are married or living common-law, add your spouse or partner, or choose to prepare only your own return. See{" "}
            <DocLink to="tax-basics" section="spouses">Spouses and common-law partners</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: "together",
      title: "Preparing both returns together",
      body: (
        <>
          <p>
            When you are married or living common-law and your spouse or partner is in the household, the app asks whether to prepare both returns
            together. Each of you still files your own return. Together, the app can later decide who claims shared credits, such as donations and
            medical expenses, so the household pays less.
          </p>
          <p>Choose "Only" your name to prepare your return alone. The app then asks nothing more about your spouse for that year.</p>
        </>
      ),
    },
    {
      id: "province-and-residency",
      title: "Province and residency",
      body: (
        <>
          <p>
            For each person whose return is prepared, choose the province they lived in on December 31, and say whether they lived in Canada all year.
          </p>
          <p>
            The app prepares returns for <b>Ontario</b>, <b>British Columbia</b> and <b>Alberta</b>, for people who lived in Canada all year. For any
            other province, or for someone who moved to or from Canada during the year, the page says the return needs other software.
          </p>
        </>
      ),
    },
    {
      id: "saving",
      title: "Saving the step",
      body: (
        <>
          <p>
            People are saved as you add or change them. The rest of the page is saved with <b>Save</b> or <b>Save and continue</b>. Under the form,
            "Before you continue" lists what is still missing. When nothing is missing, the step shows a check mark.
          </p>
          <p>
            If someone else changed the same year while you were editing, your save is refused and nothing is lost on their side. Choose{" "}
            <b>Reload</b> to see their changes, then make yours again.
          </p>
        </>
      ),
    },
  ],
};
