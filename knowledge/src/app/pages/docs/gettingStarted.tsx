import { DocLink, DocTable, InApp, type DocTopic } from './parts.tsx'

// Docs › Getting started: what Knowledge does, the first collection, and what each kind of user sees. It follows
// README.md ("Who can do what") and the navigation manifest (package.json `insulin.navigation`).

export const gettingStarted: DocTopic = {
  slug: 'getting-started',
  title: 'Getting started',
  summary: "What Knowledge does, how to start your first collection, and what each kind of user sees.",
  group: 'app',
  sections: [
    {
      id: 'what-knowledge-does',
      title: 'What Knowledge does',
      body: (
        <>
          <p>
            Insulin Knowledge keeps what your team knows in <b>collections</b>: files, web pages and notes about one subject,
            each with its own owner, sharing and history. People ask a collection here on the site, and their AI assistants ask
            it as them.
          </p>
          <ul>
            <li><b>Every answer has a source.</b> Answers cite the exact words they come from, with the file and the pages (or slides) they are on. When nothing in the collection covers a question, Knowledge says "I won't guess" instead of answering without a source.</li>
            <li><b>No technical settings.</b> Insulin chooses how to read, store and search your files. You name a collection, say what it is for and add what you know.</li>
            <li><b>Checkable.</b> What it learned is shown as plain sentences under <b>What it knows</b>, each with the file it came from.</li>
            <li><b>Fix it once.</b> A correction becomes a note the collection learns, so new questions on the site and from every AI assistant use it.</li>
            <li><b>Nothing is lost by a change.</b> Every change saves a restore point. Going back sets later files aside instead of deleting them, and it can be undone.</li>
            <li><b>Private until shared.</b> A new collection is visible to its owner only, until they share it with everyone in the organization or with specific people, like a shared document.</li>
          </ul>
          <p>
            Sign-in, organizations, people and roles, AI assistant connections and API clients are managed on insulin-apps.com, as
            for every Insulin app. Knowledge has no accounts of its own.
          </p>
        </>
      ),
    },
    {
      id: 'your-first-collection',
      title: 'Your first collection',
      body: (
        <>
          <p>Admins and Editors in Knowledge can start collections. <b>New collection</b> takes five steps:</p>
          <ol>
            <li><b>What it is for.</b> Give it a name and say, in one sentence, what it is for. AI assistants read that sentence to decide when to use the collection.</li>
            <li><b>Add what you know.</b> Upload files, add a web page or write a note. Files Insulin can't read are named, with the reason, before anything starts. See <DocLink to="collections-and-sources">Collections and sources</DocLink>.</li>
            <li><b>Learning.</b> Each file goes Waiting → Reading → Understanding → learned, with the time left. You can leave the page; Knowledge e-mails you when it is done.</li>
            <li><b>What it learned.</b> Check the facts it found, mark the ones that look right and fix the ones that don't. Then try a question: pick one of up to three made from those facts (each reads “… — is that right?”) to ask it and see the answer with its sources, or type your own.</li>
            <li><b>Share it.</b> Share it with everyone in your organization, or with specific people, and choose whether AI assistants can ask it. See <DocLink to="sharing-and-roles">Sharing and roles</DocLink>.</li>
          </ol>
          <p>
            Then ask it on its <b>Ask</b> tab, or from <b>Home</b> across up to five collections at once. See <DocLink to="asking">Asking and checking sources</DocLink>.
          </p>
          <InApp>Collections › + New collection, or New collection on Home when you have none yet.</InApp>
        </>
      ),
    },
    {
      id: 'what-each-user-sees',
      title: 'What each kind of user sees',
      body: (
        <>
          <p>
            Knowledge uses the role each person has in Knowledge on insulin-apps.com: from their organization role (organization
            owners and admins are Admins here), or a role given for Knowledge alone. The navigation shows each role what it can use:
          </p>
          <DocTable
            label="The navigation for each role"
            columns={['Role in Knowledge', 'Navigation', 'What they can do']}
            rows={[
              ['Viewer', 'Home, Collections, Docs, Settings', 'Ask the collections shared with them, open sources, see what a collection knows and its history, and report a wrong answer. A Viewer never changes anything, whatever role a collection gives them.'],
              ['Editor', 'Also Needs attention', 'Start collections, and change the collections where their collection role allows it.'],
              ['Admin', 'Also Rules and data and Health, under Admin', 'Everything an Editor does, plus what is hidden before learning, who writes answers, usage beside the limits and the health of the collections they have a role in.'],
            ]}
          />
          <p>
            Being an Admin in Knowledge gives no access to any collection's content: inside a collection, what you can do comes
            from your <b>collection role</b> (Owner, Admin, Editor or Viewer). Owners of the organization also see the basic
            information of every collection on the Collections page, and can delete one at a time. See <DocLink to="sharing-and-roles" section="three-kinds-of-roles">The three kinds of roles</DocLink>.
          </p>
          <p>
            <b>Settings</b> opens Insulin Apps' own pages on insulin-apps.com: People, Integrations, API access and Connect AI.
            Knowledge only links to them.
          </p>
        </>
      ),
    },
    {
      id: 'where-to-find-things',
      title: 'Where to find things',
      body: (
        <ul>
          <li><b>Home</b>: before you have a collection, a picture of how Knowledge works and your next step (<b>New collection</b>, or for a Viewer, asking a colleague to share one); then ask across the collections you pick, and see your collections.</li>
          <li><b>Collections</b>: your collections with your role in each; the second column lists them, with <b>+ New collection</b> for those who can start one.</li>
          <li><b>A collection</b>: <b>Overview</b> (what it covers and its state), <b>Ask</b>, <b>Sources</b> (files, web pages and notes), <b>What it knows</b> (facts as sentences), <b>Sharing</b> and <b>History</b>.</li>
          <li><b>Needs attention</b> (Editors and Admins): files Insulin couldn't read, values hidden before learning, reported answers waiting for someone, and corrections to check.</li>
          <li><b>Rules and data</b> and <b>Health</b> (Admins): see <DocLink to="hiding-personal-data">Hiding personal data</DocLink>, <DocLink to="limits">Limits</DocLink> and <DocLink to="your-data">Your data</DocLink>.</li>
          <li><b>Docs</b>: these pages, open to everyone, before any collection exists too.</li>
        </ul>
      ),
    },
  ],
}
