import { DocLink, DocTable, InApp, type DocTopic } from './parts.tsx'

// Docs › Limits: the free limits (package.json `insulin.limits`, their defaults) and what happens at each (design
// section 12, src/app/server/limits.ts and tick.ts). The support address comes from the platform, never from here.

export const limits: DocTopic = {
  slug: 'limits',
  title: 'Limits and what happens at each',
  summary: 'Knowledge is free within limits for each organization: what they are, what happens near and at each one, and how to ask for more.',
  group: 'background',
  sections: [
    {
      id: 'the-limits',
      title: 'The limits',
      body: (
        <>
          <p>
            Insulin Knowledge is free on insulinapps.com. To keep it free for everyone, each organization has limits, which
            Insulin Apps sets and can raise for one organization. These are the defaults; Admins see your organization's own
            under <b>Usage and limits</b> in <b>Rules and data</b>, with what you used beside each.
          </p>
          <DocTable
            label="The limits and their defaults"
            columns={['Limit', 'Default', 'What counts']}
            rows={[
              ['Collections', '20', 'Every collection, asleep or not'],
              ['Documents', '500', 'Every file, web page and note stored, including the ones not used'],
              ['Largest file', '25 MB', 'One file; at most 2 MB of text is learned from it'],
              ['Stored files', '2 GB', 'The text Knowledge keeps, with hidden values removed'],
              ['Documents learned a month', '1,000', 'Files, web pages, notes and corrections learned this month (not re-reads after a hiding rule changes)'],
              ['Questions a month', '5,000', 'Questions on the site, from AI assistants and from API clients'],
              ['Built-in answers a month', '2,000', "Answers written by Insulin Knowledge's built-in model; your organization's own model doesn't count"],
              ['Awake hours a month', '100', 'Time collections are awake: while people ask and 10 minutes after, while learning, while exporting, and kept-ready hours'],
              ['Collections kept ready', '1', 'Collections with a keep-ready window'],
              ['Days of daily backups', '30', 'How long daily backups are kept (at least a day, at most ten years); the latest is kept as long as the collection exists. History and Health show it'],
            ]}
          />
          <p>The monthly limits start again on the 1st of each month (UTC).</p>
        </>
      ),
    },
    {
      id: 'what-happens-at-a-limit',
      title: 'What happens at a limit',
      body: (
        <>
          <ul>
            <li><b>At 80%</b> of a monthly limit, your organization's admins get an e-mail, once that month; of any other limit, each time use goes past 80% again.</li>
            <li><b>Collections, documents, stored files, largest file:</b> new files are refused before anything starts, saying what to remove. Nothing partial is learned. <b>Remove for good</b> frees space; <b>Stop using</b> doesn't. Until a file is learned, it holds room for the most its text can come to with values hidden: up to six times its size (at most 4 MB), or 4 MB for a PDF, Word, PowerPoint or Excel file, whose text can be larger than the file. Short words of your organization's own in the hiding rules raise this (a two-letter word, to twice as much).</li>
            <li><b>Documents learned:</b> new files, web pages, notes and corrections wait and are learned on the 1st, by themselves; their files are kept until then, and if the month after is full too, until the next 1st. Everything already learned keeps answering. A file Insulin couldn't keep (one uploaded more than a day before it was added) is named, to be added again.</li>
            <li><b>Questions:</b> the site, AI assistants and API clients are told your organization has used this month's questions, until the 1st.</li>
            <li><b>Built-in answers:</b> people get the sources without a written answer. An Admin can switch to your organization's own model in Rules and data, which doesn't count.</li>
            <li><b>Awake hours:</b> keep-ready pauses at 90%, so the rest stays for questions, and starts again on the 1st. At 100%, Knowledge stops until the 1st: it doesn't answer, refuses what would wake a collection to work (adding files and notes, going back, exporting), and stops what is running: learning that was under way keeps nothing and starts again then, going back that was under way is stopped and changes nothing (History says so), and collections show <b>Stopped until the 1st</b>. Removing a file for good still works. On the site a pop-up says so and names Insulin Apps support; AI assistants and API clients get the same message. If Insulin Apps raises the limit, everything goes on within minutes.</li>
            <li><b>Collections kept ready:</b> turn keep-ready off on another collection first.</li>
          </ul>
          <p>
            Every limit message names Insulin Apps support. Assistants and programs get 429 <b>quota_exceeded</b> with the limit
            and when it resets. See <DocLink to="ai-assistants-and-api" section="rules-every-request-follows">Rules every request follows</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'ask-for-more',
      title: 'Ask for more',
      body: (
        <>
          <p>
            <b>Ask for more</b>, in Rules and data, e-mails Insulin Apps support with your organization's usage beside each limit.
            They reply by e-mail, and a raised limit shows in Rules and data within five minutes.
          </p>
          <p>
            Need much more? Insulin Knowledge is open source under the MIT license: you can run the same code on your own
            Cloudflare account and set your own limits.
          </p>
          <InApp>Rules and data › Usage and limits, and Ask for more. Admins also see the awake hours this month of each collection they have a role in.</InApp>
        </>
      ),
    },
  ],
}
