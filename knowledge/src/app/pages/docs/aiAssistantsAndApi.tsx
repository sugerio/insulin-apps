import { Code, DocLink, DocTable, type DocTopic } from './parts.tsx'

// Docs › AI assistants and the API: connecting an assistant, API clients, the rules every request follows (collections
// named, 1 to 5), and the endpoints as GET /api/catalog publishes them (src/app/server/catalog.ts).

export const aiAssistantsAndApi: DocTopic = {
  slug: 'ai-assistants-and-api',
  title: 'AI assistants and the API',
  summary: 'Ask your collections from Claude, ChatGPT and other AI assistants, or from your own programs, with the same access you have on the site.',
  group: 'app',
  sections: [
    {
      id: 'connect-an-ai-assistant',
      title: 'Connect an AI assistant',
      body: (
        <>
          <p>
            Connect your AI assistant once in <b>Settings › Connect AI</b>, Insulin Apps' page for Knowledge on insulinapps.com.
            It has the setup for Claude Code, Codex, Gemini CLI, opencode, Claude.ai and ChatGPT, and lists the assistants you
            connected, so you can disconnect one.
          </p>
          <ul>
            <li>The assistant <b>acts as you</b>: it can ask exactly the collections you can ask, with your collection roles, and no more. If your role changes, its next request follows.</li>
            <li>It sees your collections with their names and purposes, and names the ones it searches in every question.</li>
            <li>It writes its own answer from the passages Knowledge returns, and links to the sources here on the site.</li>
            <li>When nothing covers a question, Knowledge says so, so the assistant can say it won't guess.</li>
            <li>A collection's owner or admins can turn AI assistants and API clients off for that collection in its Sharing.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'api-clients',
      title: 'API clients',
      body: (
        <p>
          Your organization's owners and admins create API clients for other programs in <b>Settings › API access</b> on
          insulinapps.com, each with a role in Knowledge. A program gets a token with its client's secret and calls Knowledge's
          API. An API client has access of its own, not a person's: it reaches a collection only when the collection's owner or an admin shares
          it with that client by name, never through general access, and it can't start collections.
        </p>
      ),
    },
    {
      id: 'rules-every-request-follows',
      title: 'Rules every request follows',
      body: (
        <>
          <ul>
            <li><b>Every request names its collections.</b> A search names at least one collection and at most five, by their ids from <Code>GET /api/collections</Code>. With none, Knowledge answers 400 <Code>collection_required</Code>; with more than five, 400 <Code>too_many_collections</Code>. Nothing searches every collection.</li>
            <li><b>The same checks as the site.</b> Your role in Knowledge and your role in each collection are checked on the server for every request, whichever way it comes in.</li>
            <li><b>Some things only a person on the site can do:</b> sharing, a collection's settings, export, transfer, delete, and changes to Rules and data. Assistants and API clients get 403 <Code>browser_only</Code>, and the catalog doesn't list them.</li>
            <li><b>No waiting.</b> A collection that is asleep or learning answers at once with <Code>status</Code> <Code>waking</Code> or <Code>learning</Code> and <Code>retryAfterSeconds</Code>: ask again then.</li>
            <li><b>Changes that create something</b> (a collection, a note, an import, a correction, a report) need an <Code>Idempotency-Key</Code> header with a new random value, so a retry never does it twice.</li>
            <li><b>A program that writes for people</b> can name whom it acts for, and write only if nothing changed meanwhile. See <DocLink to="ai-assistants-and-api" section="writing-for-people">Writing for people</DocLink>.</li>
            <li><b>Errors are plain words:</b> <Code>{'{ error, message }'}</Code>. Over a limit, 429 with <Code>quota_exceeded</Code>, the <Code>limit</Code>, when it resets (<Code>resets_at</Code>) and a message naming Insulin Apps support. See <DocLink to="limits">Limits</DocLink>.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'writing-for-people',
      title: 'Writing for people',
      body: (
        <>
          <p>
            A program can keep a collection up to date for the people who use it: it proposes notes and corrections, a person
            approves them, and the program writes them, with the collection's Editor role and permission to change content.
          </p>
          <ul>
            <li>
              <b>The collection's version.</b> Every collection has a <Code>version</Code>: the number of its latest restore point.
              It grows with every change to what it knows, including stopping a file and going back. The list of collections can
              trail a change made elsewhere until Knowledge next reads the engine's changes, right after any request to a
              collection or within five minutes; one collection's <Code>engine.version</Code> is always current.
            </li>
            <li>
              <b>Only if nothing changed meanwhile.</b> A note or a correction can carry <Code>expectedVersion</Code>, the version the
              program read. At any other version Knowledge answers 409 <Code>version_changed</Code> with <Code>currentVersion</Code>,
              and adds nothing. If something else changes the collection before it is learned (it waited its turn, or for the 1st),
              it isn't learned: its import fails with the error <Code>version_changed</Code>. A request sent again with the same
              Idempotency-Key answers its first result. Once learned, the import's <Code>version</Code> is the one to name next.
            </li>
            <li>
              <b>Whom it acts for.</b> The header <Code>x-on-behalf-of</Code> (1 to 200 characters, one line, UTF-8) on adding a note, a
              correction, files or a web page names whom the program acts for, such as the person who approved it. It is kept with
              the import, answered as <Code>onBehalfOf</Code>, and History shows it: "Partner Agent, on behalf of Ana Lee". It is a
              label only: it gives no access and isn't checked against anyone's account. A retry with the same Idempotency-Key keeps
              the first value. Longer, with control characters, or not UTF-8: 400.
            </li>
            <li>
              <b>What nothing answered.</b> <Code>GET /api/collections/{'{id}'}/gaps</Code> lists the questions nothing in the
              collection covered, newest asked first, with how many times each was asked, 50 at a time (up to 100
              with <Code>limit</Code>; <Code>next</Code> asks for more). Values your organization hides show as [hidden]. It needs the
              collection's Editor role and permission to change content.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'the-api-catalog',
      title: 'The API catalog',
      body: (
        <>
          <p>
            <Code>GET /api/catalog</Code> lists the endpoints the caller may use right now, with their query and body, whether
            they need an <Code>Idempotency-Key</Code>, the collection role they need and the errors they can answer. Start with it.
            The main ones:
          </p>
          <DocTable
            label="Main endpoints"
            columns={['Endpoint', 'What it does', 'Collection role']}
            rows={[
              [<Code>GET /api/collections</Code>, 'The collections you can ask, with their names, purposes and your role in each', '–'],
              [<Code>POST /api/search</Code>, <>Passages that answer a question, from the named collections, with their file, pages (<Code>page</Code> and <Code>pageEnd</Code>, the first and last page or slide) and exact position, and <Code>covered</Code>: false means nothing answers it</>, 'Viewer'],
              [<Code>GET /api/collections/{'{id}'}</Code>, 'A collection: its purpose, your role, its state and counts', 'Viewer'],
              [<Code>GET /api/collections/{'{id}'}/sources/{'{docId}'}</Code>, 'One source\'s text, with hidden values shown as [hidden], and its pages', 'Viewer'],
              [<Code>GET /api/collections/{'{id}'}/facts</Code>, 'What a collection knows, as sentences, and who checked each', 'Viewer'],
              [<Code>POST /api/collections/{'{id}'}/facts/{'{factId}'}/check</Code>, 'Mark a fact as checked ("Looks right"), with your name', 'Editor'],
              [<Code>POST /api/collections/{'{id}'}/reports</Code>, 'Report that an answer may be wrong', 'Viewer'],
              [<Code>POST /api/collections/{'{id}'}/notes</Code>, <>Add a note the collection learns (optional <Code>expectedVersion</Code> and <Code>x-on-behalf-of</Code>)</>, 'Editor'],
              [<Code>POST /api/collections/{'{id}'}/preflight</Code>, 'Check files before adding them; then upload each one and start learning them, all or nothing', 'Editor'],
              [<Code>POST /api/collections/{'{id}'}/corrections</Code>, <>Fix an answer or a fact once (optional <Code>expectedVersion</Code> and <Code>x-on-behalf-of</Code>)</>, 'Editor'],
              [<Code>GET /api/collections/{'{id}'}/gaps</Code>, 'The questions nothing in it covered, newest asked first', 'Editor'],
              [<Code>POST /api/collections/{'{id}'}/correction-checks/clear</Code>, 'A correction to check is still right: Needs attention lets go of it', 'Editor'],
              [<Code>GET /api/collections/{'{id}'}/imports?state=waiting</Code>, 'Imports waiting for the 1st (or ?state=queued: those Insulin has but hasn\'t started learning); DELETE one by its id to cancel it', 'Viewer'],
              [<Code>POST /api/answers/{'{answerId}'}/right</Code>, '"Was this right?" Yes, for an answer you asked for', '–'],
              [<Code>GET /api/collections/{'{id}'}/history</Code>, 'Restore points, whether each can be brought back, and who made their changes', 'Viewer'],
              [<Code>GET /api/attention</Code>, "Needs attention: files Insulin couldn't read, values hidden before learning (a total, never the values), reported answers waiting and corrections to check, in the collections you can change", 'Editor'],
            ]}
          />
          <p>
            Searches, sources, facts and history are open to assistants and API clients; written answers (<Code>POST /api/ask</Code>)
            are for the site only, since assistants write their own.
          </p>
        </>
      ),
    },
  ],
}
