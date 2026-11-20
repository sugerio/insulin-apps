import { Link, useParams } from 'react-router'
import { Docs } from '../components/Docs.tsx'
import { Page } from '../components/Page.tsx'
import { docTopic } from './docs/topics.ts'

// The in-app Docs (root AGENTS.md, "Every app" rule 2): `/docs` opens "Getting started", `/docs/:topic` a topic. Open to
// every role, before any collection exists too: the pages are static and need nothing from the server.

export function DocsPage() {
  const slug = useParams().topic
  const topic = docTopic(slug)
  if (!topic) {
    return (
      <Page title="Not found — Docs" crumbs={[['Docs', '/docs'], ['Not found']]} wide>
        <div className="flex flex-col gap-2 rounded-xl bg-card px-4 py-5 ring-1 ring-foreground/10 sm:px-8">
          <h1 className="text-2xl font-semibold tracking-tight">There's no such Docs page</h1>
          <p className="text-sm text-muted-foreground">
            The address may be mistyped, or the page has moved. <Link className="font-medium underline underline-offset-4" to="/docs">Open the Docs</Link>
          </p>
        </div>
      </Page>
    )
  }
  return (
    <Page title={`${topic.title} — Docs`} crumbs={[['Docs', '/docs'], [topic.title]]} wide>
      <Docs base="/docs" topic={topic} />
    </Page>
  )
}
