import { DocLink, type DocTopic } from "./parts.tsx";

// Docs › The household: step 1 of a tax year, field by field.

export const household: DocTopic = {
  slug: "household",
  title: "The household",
  summary: "Who is in the household, who is in each tax year, and the facts no document shows.",
  group: "app",
  sections: [
    {
      id: "people",
      title: "Add the people",
      body: (
        <>
          <p>
            Open <b>Household</b> in the navigation. Start with yourself: the person preparing the returns. Then add the others who live with you:
          </p>
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
            decide whose document each file is. The people stay the same from one year to the next. You can't remove yourself.
          </p>
        </>
      ),
    },
    {
      id: "start-a-year",
      title: "Start a year: who is in it",
      body: (
        <>
          <p>
            On <b>Returns</b>, choose <b>Start 2025</b>. The app lists everyone in the household with a box to tick:
          </p>
          <ul>
            <li>
              <b>You</b> are always in your own year.
            </li>
            <li>
              <b>Your spouse or partner:</b> tick them to prepare both returns together. Each of you still files your own return; together, the app
              can later decide who claims shared credits, such as donations and medical expenses, so the household pays less. Leave them unticked to
              prepare only your return.
            </li>
            <li>
              <b>Children and other dependants:</b> tick those who lived with you that year.
            </li>
          </ul>
          <p>
            Someone missing? Choose <b>Add a new person</b>: it opens the Household page, and <b>Back to Start 2025</b> brings you back to the list.
            To change who is in a year later, use <b>Change</b> at the top of the year's household step.
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
            Choose your status on the last day of the year, as the T1 asks it. If it changed during the year, the status on December 31 counts.
          </p>
          <p>
            The choices follow the Household. With a spouse or partner there, choose married or living common-law, even if their return isn't
            prepared this year. Without one, choose single, widowed, divorced or separated. If you add or remove a spouse later, the year asks for
            the status again.
          </p>
          <p>
            The tax treats married and common-law couples the same; the T1 only has a separate box for each. The app doesn't prepare the return
            for the year of a separation yet. See <DocLink to="tax-basics" section="spouses">Spouses and common-law partners</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: "province-and-residency",
      title: "Province and residency",
      body: (
        <>
          <p>For you, and your spouse when they are in the year, choose the province they lived in on December 31, and say whether they lived in Canada all year.</p>
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
            People are saved as you add or change them, and who is in the year with <b>Save people</b>. The year's facts are saved with <b>Save</b> or{" "}
            <b>Save and continue</b>. If something is still missing, <b>Save and continue</b> saves what you entered and lists what is left.
            When nothing is missing, the step shows a check mark.
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
