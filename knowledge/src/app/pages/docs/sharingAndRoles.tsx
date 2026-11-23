import { DocLink, DocTable, InApp, type DocTopic } from './parts.tsx'

// Docs › Sharing and roles: the three kinds of roles (design section 08), the collection role table (README.md "Who can
// do what"), the Viewer cap, general access, AI assistants and API clients, keep it ready, transfer and delete, and
// what happens when people leave and come back (src/app/server/members.ts).

export const sharingAndRoles: DocTopic = {
  slug: 'sharing-and-roles',
  title: 'Sharing and roles',
  summary: 'Who can open and change a collection, how to share it like a shared document, and what happens when people leave.',
  group: 'app',
  sections: [
    {
      id: 'three-kinds-of-roles',
      title: 'The three kinds of roles',
      body: (
        <>
          <p>Three kinds of roles work together. They are different, and related only where this page says so.</p>
          <DocTable
            label="The three kinds of roles"
            columns={['Kind', 'Values', 'Set where', 'What it decides in Knowledge']}
            rows={[
              ['Organization role', 'Owner, Admin, Editor, Viewer, or specific apps', 'Settings › People, on insulin-apps.com', "Organization owners see every collection's basic information (owner, created, last used, size and how it is shared) and can delete any collection, one at a time. Without a collection role they can't open, ask, export or change it. The organization role also sets the role in Knowledge."],
              ['Role in Knowledge', 'Admin, Editor, Viewer, or a custom role', 'From the organization role (owners and admins are Admins here), or given for Knowledge only', 'Admins and Editors start collections; Viewers can\'t. Admins also see Rules and data and Health. Being an Admin gives no access to any collection\'s content.'],
              ['Collection role', 'Owner, Admin, Editor, Viewer', "Each collection's Sharing", 'Everything inside one collection, below. Nobody gets into a collection without one.'],
            ]}
          />
        </>
      ),
    },
    {
      id: 'collection-roles',
      title: 'Collection roles',
      body: (
        <>
          <DocTable
            label="What each collection role can do"
            columns={['In a collection', 'Owner', 'Admin', 'Editor', 'Viewer']}
            rows={[
              ['Ask, open sources, see what it knows and its history, report a wrong answer', '✓', '✓', '✓', '✓'],
              ['Add files, web pages and notes, fix answers and facts, stop using a file, go back', '✓', '✓', '✓', ''],
              ['Remove a file for good', '✓', '✓', '', ''],
              ['Share it; change its settings; export it', '✓', '✓', '', ''],
              ['Transfer ownership; delete it', '✓', '', '', ''],
            ]}
          />
          <ul>
            <li><b>The highest role wins.</b> Someone shared with both through everyone in the organization and by name gets the higher of the two.</li>
            <li><b>The Viewer cap.</b> A Viewer in Knowledge, or a custom role without "Change content", can only ever read: whatever role a collection gives them, they act as a Viewer. The sharing list says "acts as Viewer" next to their name.</li>
            <li><b>Custom roles narrow.</b> A custom role without "Share collections" can't share or remove files for good, and one without "Export collections" can't export, even as a collection Admin.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'share-a-collection',
      title: 'Share a collection',
      body: (
        <>
          <p>On a collection's <b>Sharing</b> tab, its owner and admins share it like a shared document:</p>
          <ul>
            <li><b>Share</b> with a person who can use Knowledge, as a Viewer, Editor or Admin. They get an e-mail with a link. Admin is given only to people by name.</li>
            <li><b>General access</b> gives everyone in your organization who can use Knowledge one role, Viewer or Editor, or no access. It adds to the roles given by name.</li>
            <li>A collection admin can change anyone's role except the owner's.</li>
          </ul>
          <p>
            Sharing isn't part of a collection's content: going back to an earlier restore point never changes who has access.
            Sharing, settings, export, transfer and delete can only be done here on the site, by a person, never by an AI
            assistant or an API client.
          </p>
        </>
      ),
    },
    {
      id: 'ai-assistants-and-api-clients',
      title: 'AI assistants and API clients',
      body: (
        <>
          <p>
            <b>AI assistants and API clients can ask it</b> is one switch per collection, on by default. Off, neither can reach
            the collection at all.
          </p>
          <ul>
            <li>An <b>AI assistant</b> acts as its person, with that person's collection roles and no more.</li>
            <li>An <b>API client</b> (a program your organization's owners or admins set up on insulin-apps.com) reaches a collection only when it is shared with that client by name, never through general access.</li>
          </ul>
          <p>See <DocLink to="ai-assistants-and-api">AI assistants and the API</DocLink>.</p>
        </>
      ),
    },
    {
      id: 'keep-it-ready',
      title: 'Keep it ready',
      body: (
        <>
          <p>
            A collection sleeps 10 minutes after the last question, and the next question wakes it in about a minute. Its owner
            or admins can <b>keep it ready</b> during a daily window instead, so answers then take a few seconds: pick the days,
            the start time and up to 3 hours a day. The window follows your organization's time zone, which an Admin sets in
            Rules and data.
          </p>
          <ul>
            <li>Kept-ready time counts against your organization's awake hours, and keep-ready pauses at 90% of them, so the rest stays for questions. It starts again on the 1st.</li>
            <li>Your organization can keep a limited number of collections ready at once: 1 by default.</li>
            <li>An owner of the organization can turn keep-ready off on any collection, even without a role in it.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'transfer-and-delete',
      title: 'Transfer and delete',
      body: (
        <>
          <ul>
            <li><b>Transfer ownership</b> (the owner): to someone who is an Admin or Editor in Knowledge. The new owner gets an e-mail, and the old owner stays as a collection Admin.</li>
            <li><b>Delete…</b> (the owner, or an owner of the organization): after typing the collection's name. Its files, notes, facts and backups are removed; saved restore points can't be opened afterwards and expire within 30 days. This can't be undone, so export it first if you might need it.</li>
          </ul>
          <p>
            <b>Organization owners</b> see, on the Collections page, "Other collections in" your organization: the name, owner,
            created, last used, documents, size and how each is shared, but never what is in it. They can delete one at a time,
            after typing its name, and its owner gets an e-mail. They can't open, ask or export it unless its owner shares it
            with them.
          </p>
          <InApp>A collection › Sharing: Share, General access, the switch for AI assistants and API clients, Keep it ready, Export, and for the owner Transfer ownership and Delete….</InApp>
        </>
      ),
    },
    {
      id: 'leaving-and-returning',
      title: 'People who leave and return',
      body: (
        <ul>
          <li><b>Leaving.</b> Someone removed from the organization, or from Knowledge, loses access at once. Their shares are kept on hold.</li>
          <li><b>Returning.</b> If they are invited again, the shares on hold come back, and they get a "Welcome back" e-mail.</li>
          <li><b>An owner leaves.</b> When a collection's owner leaves, or can only read from then on (a Viewer in Knowledge, or a custom role without "Change content"), the longest-standing owner of the organization becomes its owner and gets an e-mail. An owner who can only read keeps Viewer access.</li>
          <li><b>An owner returns.</b> A former owner who comes back gets their other shares back, but not ownership; the new owner can transfer it back.</li>
          <li><b>Checking who is still here.</b> If Knowledge has missed news of people leaving for a long time (more than 90 days), or starts for the first time, it checks everyone it knows with insulin-apps.com. Until someone is checked, which takes a moment, they count as away (Sharing says “checking”). Someone using Knowledge meanwhile is checked by using it: insulin-apps.com says who they are with every request. Each check also moves collections whose owner can now only read to the longest-standing owner of the organization.</li>
        </ul>
      ),
    },
  ],
}
