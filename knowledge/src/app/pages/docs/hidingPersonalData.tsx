import { DocLink, InApp, type DocTopic } from './parts.tsx'

// Docs › Hiding personal data: what is hidden before anything is learned (the HidingRules of the engine contract,
// without the organization's own words, which come later), the "Try it" box, and stricter rules.

export const hidingPersonalData: DocTopic = {
  slug: 'hiding-personal-data',
  title: 'Hiding personal data',
  summary: 'What Insulin removes from every file before reading it, so no answer can show it, and how Admins choose and try the rules.',
  group: 'background',
  sections: [
    {
      id: 'what-is-hidden',
      title: 'What is hidden',
      body: (
        <>
          <p>
            Before Insulin reads a file, a web page or a note, it hides sensitive values in it. A hidden value is removed before
            anything is learned or kept, so no answer, source, fact or export can show it. Where it was, the text says
            <b> [hidden]</b>.
          </p>
          <p>Knowledge hides:</p>
          <ul>
            <li>e-mail addresses;</li>
            <li>phone numbers;</li>
            <li>card numbers;</li>
            <li>API keys and access tokens in common formats;</li>
            <li>values labelled as passwords or secrets, such as "password: …".</li>
          </ul>
          <p>
            Every rule is on for a new organization. If hiding fails for any reason, the file isn't learned: nothing is kept
            rather than something unhidden.
          </p>
        </>
      ),
    },
    {
      id: 'where-you-see-it',
      title: 'Where you see it',
      body: (
        <ul>
          <li>In a source, a hidden value shows as <b>hidden</b>, in place.</li>
          <li><b>Needs attention</b> lists recent files where values were hidden before learning, and how many of each kind, for the collection's owner, admins and editors. Open the file to see where. See <DocLink to="fixing-and-reporting" section="needs-attention">Needs attention</DocLink>.</li>
          <li>Original files aren't kept after they are read: only the text with its hidden values removed.</li>
          <li>Corrections, and notes waiting for the 1st, are kept the same way, with hidden values hidden; Needs attention shows a correction as Insulin learned it.</li>
        </ul>
      ),
    },
    {
      id: 'choose-and-try-the-rules',
      title: 'Choose and try the rules',
      body: (
        <>
          <p>
            Admins in Knowledge choose which kinds of values are hidden, under <b>Hide before learning</b> in <b>Rules and data</b>.
            The rules apply to every collection in the organization.
          </p>
          <p>
            <b>Try it</b> shows what the rules would hide in a text you paste, before you change anything. It uses the same
            rules Insulin applies to files.
          </p>
          <p>
            A new or stricter rule also re-reads the files learned before, in the background, which counts as learning, and hides
            what Knowledge keeps of corrections and waiting notes. Earlier restore points that still hold the newly hidden text
            can't be brought back.
          </p>
          <InApp>Rules and data › Hide before learning, with the Try it box.</InApp>
        </>
      ),
    },
  ],
}
