import { DocLink, type DocTopic } from "./parts.tsx";

// Docs › Profile and personal info: the people, who is in a year, and step 1 of a tax year, field by field.

export const profile: DocTopic = {
  slug: "profile",
  title: "Profile and personal info",
  summary: "Who is in the profile, who is in each tax year, and the facts no document shows.",
  group: "app",
  sections: [
    {
      id: "people",
      title: "Add the people",
      body: (
        <>
          <p>
            Open <b>Profile</b> in the navigation. Start with yourself: the person preparing the returns. Then add the others who live with you:
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
          <p>
            <b>Remove</b> asks first: removing someone deletes their facts, answers and slips (confirmed ones too) in every tax year they are in.
            Files uploaded in their return stay in the year. To leave someone out of one year only, change who is in that year instead.
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
            On <b>Returns</b>, choose <b>Start 2025</b>. The app lists everyone in the profile with a box to tick. Only you are ticked to begin with:
          </p>
          <ul>
            <li>
              <b>You</b> are always in your own year.
            </li>
            <li>
              <b>Your spouse or partner:</b> tick them to prepare both returns together. Each of you still files your own return; together, the app
              can later decide who claims shared credits, such as donations and medical expenses, so the two of you pay less. Leave them unticked to
              prepare only your return.
            </li>
            <li>
              <b>Children and other dependants:</b> tick those who lived with you that year.
            </li>
          </ul>
          <p>
            Someone missing? Choose <b>Add a new person</b>: it opens the Profile page, and <b>Back to Start 2025</b> brings you back to the list.
            To change who is in a year later, use <b>Change</b> under <b>People in 2025</b> on <b>Returns</b>. Someone taken out of a year loses their facts, answers and slips for that year.
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
            The choices follow the Profile. With a spouse or partner there, choose married or living common-law, even if their return isn't
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
          <p>On each return, choose the province the person lived in on December 31, and say whether they lived in Canada all year.</p>
          <p>
            The app prepares returns for every province and territory. A resident of Quebec gets two returns: the federal one and Revenu Québec's
            TP-1. If the person moved to or from Canada during the year, answer No: Personal info then asks for the days they lived in Canada and
            their income for the rest of the year, and the personal amounts are reduced by the days in Canada. The app doesn't prepare a Quebec
            return (TP-1) for the year of a move yet: it says so on that return.
          </p>
          <p>
            The spouse amount and similar credits go down by the spouse's net income for the days the person lived in Canada: for the whole year
            if they lived here all year. If the person moved and the spouse's return is prepared here too, Personal info asks whether the spouse
            lived in Canada on the same days (the app then works it out from the spouse's return) and, if not, the spouse's net world income on
            the person's days. When the spouse's return isn't prepared here, it asks the spouse's net world income for the year, and for the
            person's days too if the person moved. Credits that depend on family income use both spouses' net incomes for the year.
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
            When nothing is missing, the step shows a check mark. While it saves, the step can't be changed. If an answer doesn't fit, such as
            part of a day, the answers aren't saved and the reason shows under it.
          </p>
          <p>
            If someone else changed the same year while you were editing, your save is refused and nothing is lost on their side. Choose{" "}
            <b>Reload</b> to see their changes: what you typed stays, except where they changed the same answer (theirs shows), and you can save
            again.
          </p>
        </>
      ),
    },
  ],
};
