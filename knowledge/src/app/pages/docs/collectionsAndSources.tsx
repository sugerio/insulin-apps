import { DocLink, DocTable, InApp, type DocTopic } from './parts.tsx'

// Docs › Collections and sources: what a collection is, the files, web pages and notes it holds, preflight, learning,
// and stop using against remove for good. It follows src/app/server/uploads.ts (the types and the reasons),
// routes/sources.ts and the engine contract's import states.

export const collectionsAndSources: DocTopic = {
  slug: 'collections-and-sources',
  title: 'Collections and sources',
  summary: 'What a collection holds, how files, web pages and notes are added and learned, and what happens when something goes wrong.',
  group: 'app',
  sections: [
    {
      id: 'collections',
      title: 'Collections',
      body: (
        <>
          <p>
            A collection is files, web pages and notes about one subject, such as "Partner Programs" or "Product FAQ". Each has
            a name, a one-sentence purpose, an owner, its own sharing and its own history. Whoever starts it owns it, and it is
            private to them until they share it.
          </p>
          <p>A collection's <b>Overview</b> says what state it is in:</p>
          <DocTable
            label="Collection states"
            columns={['State', 'What it means']}
            rows={[
              ['Ready', 'Answers in a few seconds.'],
              ['Asleep', 'Nobody asked for a while, so it sleeps to keep Knowledge free. Your first question wakes it up, in about a minute.'],
              ['Waking up', 'It is starting from its last restore point, checking nothing changed while it slept, and opening what it knows.'],
              ['Coming back from its backup', "It wasn't used for over 30 days, so it comes back from its latest backup. This takes a few minutes. It is never lost by sitting unused."],
              ['Learning', 'It is reading new files. Questions to it wait until it finishes.'],
              ['Saving a restore point', 'So you can always come back to this version.'],
              ['Going back to an earlier version', 'About a minute; questions wait for a moment.'],
              ['Repairing', "It couldn't open its latest restore point, so it answers from an earlier version while Insulin repairs it."],
              ['Stopped until the 1st', "Your organization has used this month's awake hours (see Limits). Everything learned is kept; removing a file for good still works."],
            ]}
          />
        </>
      ),
    },
    {
      id: 'adding-sources',
      title: 'Adding files, web pages and notes',
      body: (
        <>
          <p>On a collection's <b>Sources</b> tab, its owner, admins and editors can add three kinds of source:</p>
          <ul>
            <li><b>Upload files</b>: PDF (with text), Word (.docx), PowerPoint (.pptx), Excel (.xlsx), Markdown (.md), plain text (.txt) and web pages saved as HTML, up to 100 at a time. Each file can be up to your organization's largest-file limit, 25 MB by default. At most 2 MB of text is learned from one file; if a file has more, Knowledge says so.</li>
            <li><b>Add a web page</b>: the address of a public page (http or https). Knowledge reads it now; add it again to read it again. Pages on private or local networks can't be added.</li>
            <li><b>Write a note</b>: a few lines in your own words, such as "Since October, partner managers approve requests up to $50,000." A note is learned like a file and cited as a note, and can be up to 20,000 characters (add a longer text as a file). Notes go ahead of files that are waiting to be learned.</li>
          </ul>
          <p>
            A new collection can instead <b>Start from an export</b>: the .zip file a collection's <b>Export</b> made, from this
            organization or another. It brings back the same sources, the files it stopped using, its notes and corrections, so it
            answers the same; its history starts afresh with one restore point. Only an empty collection starts from an export, and
            what it holds counts toward your organization's limits before anything starts.
          </p>
          <p>
            What waits for the 1st (your organization has learned this month's documents) is listed on <b>Sources</b>, under
            <b> Waiting for the 1st</b>, with who added it and when it starts; its editors can <b>Cancel</b> it, and it is never learned. What Insulin has but hasn't started learning yet (sent on the 1st, or waiting its turn behind other imports) is listed under <b>Waiting to be learned</b>, and its editors can <b>Cancel</b> it too. Once learning has started, it can't be cancelled: Knowledge says so, and it is learned.
          </p>
          <p>
            Before Insulin reads anything, it hides e-mail addresses, phone numbers, card numbers, API keys and values labelled
            as passwords or secrets. See <DocLink to="hiding-personal-data">Hiding personal data</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'files-that-cant-be-learned',
      title: "Files that can't be learned",
      body: (
        <>
          <p>
            Before anything starts, Knowledge checks every file you picked and names the ones it can't learn, with the reason and
            what to do instead. Only the others are learned:
          </p>
          <ul>
            <li><b>A type Insulin can't read</b>, such as an Excel workbook with macros (.xlsm), an older Word or PowerPoint file (.doc, .ppt) or an image. Save it in one of the types above and add it again.</li>
            <li><b>An empty file</b>, or one <b>larger than your organization's largest file</b>. Split it, or save it in a smaller format.</li>
            <li><b>A scanned PDF</b>: a PDF that is only an image, with no text in it, is named when it is uploaded. Upload a PDF with text, or a Word file.</li>
            <li><b>Your organization's limits</b>: if the files would go past the documents or stored files, nothing starts and Knowledge says which limit. Past this month's documents learned, they are taken and wait for the 1st. See <DocLink to="limits">Limits</DocLink>.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'learning',
      title: 'Learning',
      body: (
        <>
          <p>
            Learning is how Insulin reads each file and works out the facts in it. Each file goes <b>Waiting → Reading →
            Understanding → learned</b>, and the progress shows the time left in real minutes. When it ends, Knowledge saves a
            restore point and says how many files it learned and how many new facts it found.
          </p>
          <ul>
            <li><b>Questions wait.</b> While a collection learns, questions to it wait until it finishes; AI assistants are told to ask again in a minute.</li>
            <li><b>You can leave.</b> Learning goes on without the page, and Knowledge e-mails whoever added the files when they are learned, or if they couldn't be. If Insulin Knowledge never received an import (a connection dropped), it says so after an hour, by e-mail too; an import that waited for the 1st is sent again instead.</li>
            <li><b>Waiting your turn.</b> An organization learns two imports at a time, and Insulin Knowledge has a limit for everyone together; a new import waits behind them and says when it should start. Notes and corrections go first.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'when-learning-goes-wrong',
      title: 'When learning goes wrong',
      body: (
        <>
          <p>An import is all or nothing: a collection never answers from half-learned files.</p>
          <ul>
            <li><b>Interrupted.</b> If an import stops part-way, nothing from it is kept, so the collection is exactly as it was before, and Insulin tries again by itself, up to 3 times.</li>
            <li><b>Failed.</b> After 3 tries Knowledge names the file that keeps failing. Nothing from that import was kept: add the other files again without it.</li>
            <li><b>Already here.</b> Files with the same content as files the collection has already learned change nothing, and no restore point is saved.</li>
          </ul>
          <p>Files Insulin couldn't read also show under <b>Needs attention</b> for the collection's owner, admins and editors.</p>
        </>
      ),
    },
    {
      id: 'stop-using-or-remove',
      title: 'Stop using, or remove for good',
      body: (
        <>
          <DocTable
            label="Stop using and remove for good"
            columns={['', 'Stop using', 'Remove for good']}
            rows={[
              ['What it does', "Keeps the file, but answers no longer use it. Use again brings it back.", 'Deletes the file and its text from the collection and its latest backup.'],
              ['Who can', "The collection's owner, admins and editors", "The collection's owner and admins"],
              ['History', 'A restore point, like any change', "Earlier restore points that held the file can't be brought back any more"],
              ['Space and limits', 'Still counts as a document and as stored files', 'Frees the space it took'],
              ['Undo', 'Use again, or go back in History', "Can't be undone"],
            ]}
          />
          <InApp>Sources: Stop using or Use again on each file, and Remove for good for owners and admins, after a warning.</InApp>
        </>
      ),
    },
  ],
}
