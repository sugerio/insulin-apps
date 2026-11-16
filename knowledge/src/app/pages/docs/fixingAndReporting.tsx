import { DocLink, InApp, type DocTopic } from './parts.tsx'

// Docs › Fixing and reporting: fix a wrong answer once (a correction the engine learns, marking the outdated passage),
// report one when you can only read, and check facts on What it knows. It follows routes/knowledge.ts (corrections,
// reports) and the fact checks.

export const fixingAndReporting: DocTopic = {
  slug: 'fixing-and-reporting',
  title: 'Fixing and reporting',
  summary: 'Fix a wrong answer once so every new question uses the fix, report one when you can only read, and check what a collection knows.',
  group: 'app',
  sections: [
    {
      id: 'fix-a-wrong-answer',
      title: 'Fix a wrong answer once',
      body: (
        <>
          <p>
            Under every answer, <b>Was this right?</b> offers <b>Yes</b> and <b>Not right</b>. If you are the collection's
            owner, an admin or an editor, <b>Not right</b> opens the fix:
          </p>
          <ol>
            <li>Write the right answer.</li>
            <li>Pick the source that is out of date, or "None of them" if something is missing.</li>
            <li>If you like, tick <b>Tell the person who added this file</b>: whoever added it gets an e-mail saying an answer from their file was corrected, with a link to the collection (not your correction), so they can update the file too.</li>
            <li><b>Save the correction.</b></li>
          </ol>
          <p>
            Knowledge saves your correction as a note, learns it (about a minute; questions to that collection wait meanwhile)
            and saves a restore point. The source you picked is marked as corrected, so answers stop using that passage. Then:
          </p>
          <ul>
            <li>New questions on this site and from every AI assistant use your correction, and cite it.</li>
            <li>Answers already given don't change.</li>
            <li>The correction is listed with the collection's notes in Sources, and it can be undone by going back in History.</li>
            <li>If the file it corrects is read again later and the words it applies to now read differently, the correction asks to be checked under <b>Needs attention</b>.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'report-a-wrong-answer',
      title: 'Report a wrong answer',
      body: (
        <>
          <p>
            If you can only read a collection, <b>Not right</b> lets you tell its owner what's wrong instead: say what you
            expected, then <b>Send to &lt;owner&gt;</b>. The owner and the collection's admins get an e-mail, and the report waits
            for them under <b>Needs attention</b>.
          </p>
          <p>
            Until someone checks it, the answer shows that it was reported, to everyone who gets it. The report is settled when
            an owner, admin or editor fixes the answer (once Insulin has learned the fix; if learning it fails, the report stays
            open), or marks the answer as right.
          </p>
        </>
      ),
    },
    {
      id: 'what-it-knows',
      title: 'What it knows',
      body: (
        <>
          <p>
            A collection's <b>What it knows</b> tab lists the facts Insulin found, each as one sentence taken from a file that a
            person can check, with the file it came from. Search them by word.
          </p>
          <ul>
            <li><b>Looks right</b> (owners, admins and editors) marks a fact as checked, with your name, so others can see someone checked it.</li>
            <li><b>Fix</b> writes the right sentence. It is saved as a correction, like a fixed answer, and answers that used the fact use your fix.</li>
            <li><b>Report a problem</b> (everyone else) tells the owner something is wrong, like a reported answer.</li>
          </ul>
          <InApp>A collection › What it knows. Reported answers and facts wait under Needs attention.</InApp>
        </>
      ),
    },
    {
      id: 'needs-attention',
      title: 'Needs attention',
      body: (
        <>
          <p>
            <b>Needs attention</b>, for Editors and Admins in Knowledge, lists what only a person can settle in the collections
            where they are an owner, admin or editor:
          </p>
          <ul>
            <li><b>Files Insulin couldn't read</b>, with the reason and what to upload instead.</li>
            <li><b>Values hidden before learning</b>: which file, and how many e-mail addresses, phone numbers or other values were hidden. Open the file to see where. See <DocLink to="hiding-personal-data">Hiding personal data</DocLink>.</li>
            <li><b>Reported answers waiting</b>: fix the answer, or say it is right.</li>
            <li><b>Corrections to check</b>: a file was read again, and the words a correction applies to now read differently. Check that the correction still says the right thing (shown as Insulin learned it, with hidden values hidden); writing a new correction of that file settles it.</li>
          </ul>
          <p>
            Insulin keeps answering while these wait. A file Insulin couldn't read stays listed for 30 days, or until a file
            with the same name is learned in that collection; a report stays until it is settled.
          </p>
        </>
      ),
    },
  ],
}
