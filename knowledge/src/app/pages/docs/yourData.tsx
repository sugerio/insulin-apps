import { Code, DocLink, DocTable, InApp, type DocTopic } from './parts.tsx'

// Docs › Your data: export (engine/src/exporter.ts: what a download holds), delete, backups and what is kept, and the
// numbers Knowledge sends Insulin Apps every hour (src/app/server/usage-metrics.ts: exactly the limit keys that measure
// use, plus database_bytes). A new gauge in the report changes this topic too.

export const USAGE_REPORT_KEYS = [
  ['collections', 'How many collections the organization has'],
  ['documents', 'How many files, web pages and notes they hold'],
  ['storage_bytes', 'The size of the text kept'],
  ['learned_month', 'Documents learned this month'],
  ['questions_month', 'Questions asked this month, on the site, from AI assistants and from API clients'],
  ['answers_month', "Answers written by the built-in model this month"],
  ['awake_hours_month', 'Hours collections were awake this month'],
  ['ready_collections', 'Collections kept ready'],
] as const

export const yourData: DocTopic = {
  slug: 'your-data',
  title: 'Your data',
  summary: 'Export a collection, delete one, what Knowledge keeps and for how long, and the numbers it sends Insulin Apps.',
  group: 'background',
  sections: [
    {
      id: 'export',
      title: 'Export a collection',
      body: (
        <>
          <p>
            A collection's owner and admins can export it from its <b>Sharing</b> tab: <b>Export</b> prepares a download, which
            stays available for 7 days. Exports are per collection: nobody, not even an owner of the organization, can export
            every collection at once, and an owner of the organization can't export a collection they have no role in.
          </p>
          <p>An export is a zip file in open formats, with:</p>
          <ul>
            <li>the text Knowledge learned from each file, web page or note, with hidden values shown as [hidden], and each document's page map;</li>
            <li>the notes people wrote, the facts Knowledge found (each with the sentence it came from), the corrections and the history;</li>
            <li>the collection's settings and counts.</li>
          </ul>
          <p>Original files are never part of an export: Knowledge doesn't keep them after reading them.</p>
        </>
      ),
    },
    {
      id: 'delete',
      title: 'Delete a collection',
      body: (
        <>
          <p>
            A collection's owner, or an owner of the organization, deletes it from <b>Delete…</b> after typing its name. Its files,
            notes, facts and backups are removed at once, and everyone it was shared with loses access. Saved restore points
            can't be opened afterwards and expire within 30 days. When an owner of the organization deletes someone else's
            collection, its owner gets an e-mail.
          </p>
          <p>
            Nobody deletes collections in bulk. When an organization is deleted on insulinapps.com, everything Knowledge kept for
            it is deleted too.
          </p>
        </>
      ),
    },
    {
      id: 'what-is-kept',
      title: 'What Knowledge keeps',
      body: (
        <>
          <DocTable
            label="What Knowledge keeps, and for how long"
            columns={['What', 'How long']}
            rows={[
              ['Original files', 'Only until they are read: then deleted'],
              ['The text learned, with hidden values removed, and the facts', 'As long as the collection exists, or until the file is removed for good'],
              ['Restore points', '30 days'],
              ['Daily backups', '30 days; the latest as long as the collection exists'],
              ['Exports', '7 days'],
              ['Who may do what: sharing, the list of collections, questions asked and reports', 'In Knowledge\'s own database, for the organization only'],
            ]}
          />
          <p>
            Each collection is kept apart from every other, and one organization never sees another's. See also
            <DocLink to="hiding-personal-data"> Hiding personal data</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'numbers-sent-to-insulin-apps',
      title: 'The numbers Knowledge sends to Insulin Apps',
      body: (
        <>
          <p>
            Every hour, Knowledge sends Insulin Apps a few numbers, so that Insulin Apps can see usage beside each organization's
            limits and plan its capacity. For each organization, exactly these:
          </p>
          <DocTable label="The numbers sent for each organization" columns={['Key', 'What it counts']} rows={USAGE_REPORT_KEYS.map(([key, what]) => [<Code>{key}</Code>, what])} />
          <p>
            And for Knowledge as a whole, <Code>database_bytes</Code>: the size of its database. The monthly numbers drop to 0
            on the 1st.
          </p>
          <p>
            These are counts and sizes only. Knowledge never sends names, e-mail addresses, questions, answers, the text of
            files or anything else from a collection.
          </p>
          <InApp>Admins see the same numbers beside each limit in Rules and data › Usage and limits.</InApp>
        </>
      ),
    },
  ],
}
