---
title: Asking and checking sources
description: How Knowledge answers from your collections only, with numbered sources you can open at the exact words, and when it says "I won't guess".
order: 4
---

This page explains how answers are written, how to check the words behind them, and what happens when a collection
is asleep, learning or doesn't cover a question. It is for everyone who asks Knowledge, and for AI agents deciding how
to present its results.

## Ask a question

Ask on a collection's **Ask** tab, or on **Home**, where you pick the collections to search: at least one and up to
five. Nothing searches every collection by default, and a collection you can't ask is never searched.

Answers come only from the collections you picked, never from the internet. Insulin finds the passages that answer the
question, and a model writes a short answer from those passages alone, citing each one with a number:

> It needs sign-off from the alliance lead, because it is above the $25,000 limit [1].

![An answer on a collection's Ask tab: two sentences, each with a numbered citation, then the two sources, page 3 of a PDF and a note, with the words used, the model that wrote it and Was this right?](/docs/assets/screenshots/knowledge-answer.png "An answer with its numbered sources")

Knowledge checks every number in the answer against the passages the model was given. If the answer cites something it
wasn't given, or nothing at all, you get the sources without a written answer instead. Under the answer, Knowledge
says which model wrote it: Insulin Knowledge's built-in model, Gemma 4, or the organization's own model, as an Admin
chose in Rules and data.

## Check the source

Open a numbered source to see the text it comes from: the file's text at the exact words the answer used,
highlighted, with the pages they are on (slides, for a PowerPoint deck: "pages 1–2" when the words run over two), who
owns the collection and when the file was added. Values hidden before
learning show as hidden: nobody, not even the collection's owner, can see what was there. Anyone who can ask a
collection can open every source it used.

![The source viewer beside an answer: deal-desk-faq.md with its collection, owner, last edit and status, and the paragraph the answer used highlighted in the file's text](/docs/assets/screenshots/knowledge-source-viewer.png "A source, opened at the exact words the answer used")

## "I won't guess"

When nothing in the collections you picked covers the question, Knowledge answers "I couldn't find this in …, so I
won't guess." It never answers without a source. The question is kept as a gap, something the collection doesn't
cover yet, with how many times it was asked: the collection's owner, admins and editors can list them with
`GET /api/collections/{id}/gaps` (see
[Writing for people](/docs/knowledge/ai-assistants-and-api#writing-for-people-notes-corrections-and-open-questions)), so a
note can answer them.

![A question nothing in the collection covers, answered I couldn't find this in “Partner Program”, so I won't guess, with the buttons Ask Ana Lima to add it and Write the answer](/docs/assets/screenshots/knowledge-wont-guess.png "“I won't guess”: no answer without a source")

- **Ask the owner to add it** sends the question to the collection's owner and its admins by e-mail.
- **Write the answer** (owners, admins and editors) adds the answer as a note the collection learns, so the next
  person gets it with its source.

## Sleeping, waking and learning

- **Asleep.** A collection sleeps 10 minutes after the last question, which keeps Insulin Knowledge free. The first
  question wakes it up, in about a minute. Its owner can keep it ready during a daily window (see
  [Roles and sharing](/docs/knowledge/roles-and-sharing#keep-it-ready)).
- **Not used for over 30 days.** It comes back from its latest backup, in a few minutes. It is never lost by sitting
  unused.
- **Learning.** While a collection learns new files, questions to it wait until it finishes.

When you ask several collections from Home and some are asleep or learning, the answer comes from the ones that are
ready, and says which ones weren't.

## When Knowledge can't answer

- **Questions used up.** When the organization has used this month's questions, Knowledge says so and answers again on
  the 1st.
- **Written answers used up.** You get the sources without a written answer; an Admin can switch to the organization's
  own model.
- **Awake hours used up.** At 100% of the month's awake hours a pop-up says Knowledge has stopped until the 1st, and
  names Insulin Apps support.

See [Limits](/docs/knowledge/limits).

## From an AI assistant

Once connected in **Settings › Connect AI**, an AI assistant asks the collections you can ask, as you. It names the
collections it searches, writes its own answer from the passages it gets back, and links to the sources on the site.
When nothing covers a question it gets `covered: false`, so it can say it won't guess. See
[AI assistants and the API](/docs/knowledge/ai-assistants-and-api).
