import type { ReactNode } from 'react'
import { anchorId, DocLink, type DocSection, type DocTopic } from './parts.tsx'

// Docs › Glossary: the words Knowledge uses (design section 06, "We say" and "What it means"), A–Z, each with an id of
// its own (anchorId) so other topics can link to it. The sections are built from the list: one per first letter.

const TERMS: readonly (readonly [term: string, definition: ReactNode])[] = [
  ['AI assistant', <>Claude, ChatGPT, Codex, Gemini and others, connected once in Settings › Connect AI, asking as you, with your access and no more. See <DocLink to="ai-assistants-and-api">AI assistants and the API</DocLink>.</>],
  ['Already here', 'You added files with the same content as files the collection had already learned; nothing changed.'],
  ['API client', 'A program your organization set up on insulinapps.com to call Knowledge. It reaches a collection only when the collection is shared with it by name.'],
  ['Asleep', 'A collection nobody asked for a while sleeps, to keep Knowledge free. The first question wakes it up, in about a minute.'],
  ['Awake hours', 'The time collections are awake: while people ask and shortly after, while learning, while exporting and while kept ready. Each organization has a limit a month.'],
  ['Backup', "A daily copy of a collection, kept for your organization's days of daily backups (30 by default); the latest is kept as long as the collection exists."],
  ['Collection', 'Files, web pages and notes about one subject, with its own owner, sharing and history.'],
  ['Collection role', <>Owner, Admin, Editor or Viewer in one collection, from owning it, its general access or a share by name. See <DocLink to="sharing-and-roles" section="collection-roles">Collection roles</DocLink>.</>],
  ['Correction', 'A note that fixes a wrong answer or fact. The collection learns it, and the source it corrects is no longer used for answers.'],
  ['Fact', 'One sentence taken from a file that a person can check.'],
  ['General access', 'The role everyone in your organization who can use Knowledge gets in a collection: Viewer, Editor or none.'],
  ['Go back', 'Make the collection answer from an earlier restore point. Later files are set aside, not deleted, and it can be undone.'],
  ['Hidden', <>Removed before Insulin read the file, so no answer can show it. See <DocLink to="hiding-personal-data">Hiding personal data</DocLink>.</>],
  ['Interrupted', 'An import stopped part-way; nothing from it was kept, and Insulin tries again.'],
  ['Keep it ready', 'Stay awake during a daily window, so answers then take a few seconds.'],
  ['Learning', 'Insulin reads each file (reading) and works out the facts in it (understanding).'],
  ['Needs attention', "What only a person can settle: files Insulin couldn't read, values hidden before learning, reported answers, corrections to check."],
  ['Note', 'A few lines you write yourself, learned like a file and cited as a note.'],
  ['Remove for good', 'Delete a file and its text, so no earlier version can bring it back.'],
  ['Report', 'Telling a collection\'s owner that an answer or a fact may be wrong. The answer shows it was reported until someone checks it.'],
  ['Restore point', 'A saved copy of the collection after every change, kept 30 days.'],
  ['Role in Knowledge', 'Admin, Editor or Viewer, from your organization role or a role given for Knowledge only. It decides whether you can start collections and see Rules and data.'],
  ['Set aside', 'A file added after the version you went back to: kept, not used, and ready to be added again.'],
  ['Source', 'The exact words an answer is based on, with the file and page.'],
  ['Stop using', "Keep the file, but don't answer from it."],
  ['Viewer cap', 'Someone whose role in Knowledge can only read acts as a Viewer in every collection, whatever it gives them.'],
  ['Waking up', 'A sleeping collection starting again for a question: about a minute, or a few minutes from its backup after 30 days unused.'],
  ["Won't guess", 'What Knowledge says when nothing in the collection covers a question, instead of answering without a source.'],
]

function sections(): DocSection[] {
  const byLetter = new Map<string, (typeof TERMS)[number][]>()
  for (const entry of [...TERMS].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const letter = entry[0][0]!.toUpperCase()
    byLetter.set(letter, [...(byLetter.get(letter) ?? []), entry])
  }
  return [...byLetter].map(([letter, entries]) => ({
    id: `letter-${letter.toLowerCase()}`,
    title: letter,
    body: (
      <dl className="flex flex-col gap-3">
        {entries.map(([term, definition]) => (
          <div key={term}>
            <dt id={anchorId(term)} tabIndex={-1} className="font-semibold text-foreground">{term}</dt>
            <dd className="mt-0.5">{definition}</dd>
          </div>
        ))}
      </dl>
    ),
  }))
}

export const glossary: DocTopic = {
  slug: 'glossary',
  title: 'Glossary',
  summary: 'The words Knowledge uses, A to Z, in plain words.',
  group: 'background',
  compactContents: true,
  sections: sections(),
}
