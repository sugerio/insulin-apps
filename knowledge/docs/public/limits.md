---
title: Knowledge limits
description: The free limits each organization has in Knowledge, what happens near and at each one, and how to ask Insulin Apps support for more.
order: 10
---

Insulin Knowledge is free on insulinapps.com. To keep it free for everyone, each organization has limits, which Insulin
Apps sets and can raise for one organization. This page lists them and what happens at each. It is for Admins watching
usage, and for AI agents that get a `quota_exceeded` error.

## The limits

These are the defaults. Admins see their organization's own under **Usage and limits** in **Rules and data**, with
what was used beside each; a raised limit shows there within five minutes.

| Limit | Key | Default | What counts |
|---|---|---|---|
| Collections | `collections` | 20 | Every collection, asleep or not |
| Documents | `documents` | 500 | Every file, web page and note stored, including the ones not used |
| Largest file | `file_bytes` | 25 MB | One file; at most 2 MB of text is learned from it |
| Stored files | `storage_bytes` | 2 GB | The text Knowledge keeps, with hidden values removed |
| Documents learned a month | `learned_month` | 1,000 | Files, web pages and notes learned this month, including re-reads |
| Questions a month | `questions_month` | 5,000 | Questions on the site, from AI assistants and from API clients |
| Built-in answers a month | `answers_month` | 2,000 | Answers written by the built-in model; the organization's own model doesn't count |
| Awake hours a month | `awake_hours_month` | 100 | Time collections are awake: while people ask and 10 minutes after, while learning, while exporting, and kept-ready hours |
| Collections kept ready | `ready_collections` | 1 | Collections with a keep-ready window |
| Days of daily backups | `backup_days` | 30 | How long daily backups are kept; the latest is kept as long as the collection exists |

The monthly limits start again on the 1st of each month (UTC).

## What happens at a limit

- **At 80%** of a monthly limit, the organization's admins get an e-mail, once that month; of any other limit, each time
  use goes past 80% again.
- **Collections, documents, stored files, largest file:** new files are refused before anything starts, saying what to
  remove. Nothing partial is learned. **Remove for good** frees space; **Stop using** doesn't. Until a file is learned,
  it holds room for up to twice its size, or 4 MB for a PDF, Word, PowerPoint or Excel file, whose text can be larger
  than the file.
- **Documents learned:** new files, web pages, notes and corrections wait and are learned on the 1st, by themselves;
  their files are kept until then, and if the month after is full too, until the next 1st. Everything already learned
  keeps answering. A file Insulin couldn't keep (one uploaded more than a day before it was added) is named, to be
  added again. Over the API the import answers 202 with `import.state` `waiting` and `waiting: { until, message }`.
- **Questions:** the site, AI assistants and API clients are told the organization has used this month's questions,
  until the 1st.
- **Built-in answers:** people get the sources without a written answer. An Admin can switch to the organization's own
  model in Rules and data, which doesn't count.
- **Awake hours:** keep-ready pauses at 90%, so the rest stays for questions, and starts again on the 1st. At 100%,
  Knowledge stops answering until the 1st, and refuses what would wake a collection to work (adding files and notes,
  removing a file for good, going back, exporting): on the site a pop-up says so and names Insulin Apps support; AI
  assistants and API clients get 429 `quota_exceeded` with the same message.
- **Collections kept ready:** turn keep-ready off on another collection first.

Every limit message names Insulin Apps support. Over the API, a limit answers 429 with `error: "quota_exceeded"`, the
`limit` key, `resets_at` (for the monthly limits) and the `message`.

## Ask for more

**Ask for more**, in Rules and data, e-mails Insulin Apps support with the organization's usage beside each limit.
They reply by e-mail, and a raised limit shows in Rules and data within five minutes.

Need much more? Insulin Knowledge is open source under the MIT license: anyone can run the same code on their own
Cloudflare account and set their own limits.
