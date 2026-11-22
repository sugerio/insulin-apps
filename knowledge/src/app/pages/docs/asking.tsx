import { DocLink, Example, InApp, type DocTopic } from './parts.tsx'

// Docs › Asking and checking sources: answers with numbered sources, the source viewer, "I won't guess", sleeping and
// learning collections, and asking across collections from Home. It follows src/app/server/ask.ts and routes/asking.ts.

export const asking: DocTopic = {
  slug: 'asking',
  title: 'Asking and checking sources',
  summary: 'How answers are written from your collections only, how to check the exact words behind them, and when Knowledge won\'t guess.',
  group: 'app',
  sections: [
    {
      id: 'ask-a-question',
      title: 'Ask a question',
      body: (
        <>
          <p>
            Ask on a collection's <b>Ask</b> tab, or on <b>Home</b>, where you pick the collections to search: at least one and
            up to five. Nothing searches every collection by default, and a collection you can't ask is never searched.
          </p>
          <p>
            Answers come only from the collections you picked, never from the internet. Insulin finds the passages that answer
            the question, and a model writes a short answer from those passages alone, citing each one with a number.
          </p>
          <Example>
            <p>"It needs sign-off from the alliance lead, because it is above the $25,000 limit [1]."</p>
            <p>[1] MDF request playbook.docx · page 3 · "Anything above $25,000 needs sign-off from the alliance lead."</p>
          </Example>
          <p>
            Knowledge checks every number in the answer against the passages the model was given. If the answer cites something
            it wasn't given, or none at all, you get the sources without a written answer instead. Under the answer, Knowledge
            says which model wrote it: Insulin Knowledge's built-in model, Gemma 4, or your organization's own model, as an Admin
            chose in Rules and data.
          </p>
        </>
      ),
    },
    {
      id: 'check-the-source',
      title: 'Check the source',
      body: (
        <>
          <p>Open a numbered source to see the text it comes from:</p>
          <ul>
            <li>the text of the file at the exact words the answer used, highlighted;</li>
            <li>the pages they are on (slides, for a PowerPoint deck: "pages 1–2" when the words run over two), who owns the collection, and when the file was last added to it;</li>
            <li>values that were hidden before learning, shown as <b>hidden</b>: nobody, not even the collection's owner, can see what was there.</li>
          </ul>
          <p>Anyone who can ask a collection can open every source it used.</p>
        </>
      ),
    },
    {
      id: 'i-wont-guess',
      title: '"I won\'t guess"',
      body: (
        <>
          <p>
            When nothing in the collections you picked covers the question, Knowledge answers "I couldn't find this in …, so I
            won't guess." It never answers without a source. The question is kept as a gap, something the collection doesn't
            cover yet, with how many times it was asked: the collection's owner, admins and editors can list them through the API
            (<DocLink to="ai-assistants-and-api" section="writing-for-people">Writing for people</DocLink>), so a note can answer them.
          </p>
          <ul>
            <li><b>Ask &lt;owner&gt; to add it</b> sends the question to the collection's owner and its admins by e-mail.</li>
            <li><b>Write the answer</b> (owners, admins and editors) adds the answer as a note the collection learns, so the next person gets it with its source.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'sleeping-and-learning',
      title: 'Sleeping, waking and learning',
      body: (
        <>
          <ul>
            <li><b>Asleep.</b> A collection sleeps 10 minutes after the last question, which keeps Insulin Knowledge free. Your first question wakes it up: the answer shows three steps and takes about a minute. Its owner can keep it ready during a daily window; see <DocLink to="sharing-and-roles" section="keep-it-ready">Keep it ready</DocLink>.</li>
            <li><b>Not used for over 30 days.</b> It comes back from its latest backup, which takes a few minutes. It is never lost by sitting unused.</li>
            <li><b>Learning.</b> While a collection learns new files, questions to it wait until it finishes. Ask again in a few minutes.</li>
          </ul>
          <p>
            When you ask several collections from Home and some are asleep or learning, the answer comes from the ones that are
            ready, and says which ones weren't.
          </p>
        </>
      ),
    },
    {
      id: 'when-knowledge-cant-answer',
      title: "When Knowledge can't answer",
      body: (
        <ul>
          <li><b>Questions used up.</b> When your organization has used this month's questions, Knowledge says so and answers again on the 1st.</li>
          <li><b>Written answers used up.</b> When this month's answers from the built-in model are used up, you get the sources without a written answer. An Admin can switch to your organization's own model.</li>
          <li><b>Awake hours used up.</b> At 100% of the month's awake hours a pop-up says Knowledge has stopped until the 1st, and names Insulin Apps support.</li>
        </ul>
      ),
    },
    {
      id: 'from-an-ai-assistant',
      title: 'From an AI assistant',
      body: (
        <>
          <p>
            Once you connect your AI assistant (Claude, ChatGPT, Codex, Gemini and others) in <b>Settings › Connect AI</b>, it can
            ask the collections you can ask, as you. It names the collections it searches, writes its own answer from the
            passages it gets back, and links to the sources. When nothing covers the question, it is told so, so it can say it
            won't guess. See <DocLink to="ai-assistants-and-api">AI assistants and the API</DocLink>.
          </p>
          <InApp>Ask on a collection's Ask tab, or on Home with Search in to pick up to five collections.</InApp>
        </>
      ),
    },
  ],
}
