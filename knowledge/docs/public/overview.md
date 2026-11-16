---
title: Knowledge overview
description: What Insulin Knowledge does, who it is for, and how it runs on Insulin Apps, with answers that cite their sources or say "I won't guess".
order: 1
---

Insulin Knowledge keeps what a team knows in **collections**: files, web pages and notes about one subject, each with
its own owner, sharing and history. People ask a collection on the site, and their AI assistants ask it with the same
access as their person. Read this page first if you are deciding whether Knowledge suits your team, or if you are an AI
agent that needs the big picture before calling its API.

## What Knowledge does

- **Every answer has a source.** Answers cite the exact words they come from, with the file and the page. When nothing
  in the collection covers a question, Knowledge says "I won't guess" instead of answering without a source.
- **No technical settings.** Insulin chooses how to read, store and search the files. You name a collection, say in
  one sentence what it is for, and add what you know.
- **Checkable.** What a collection learned is shown as plain sentences, each with the file it came from, which people
  can mark as checked or fix.
- **Fix it once.** A correction becomes a note the collection learns, so new questions on the site and from every AI
  assistant use it.
- **Nothing is lost by a change.** Every change saves a restore point. Going back sets later files aside rather than
  deleting them, and it can be undone.
- **Private until shared.** A new collection is visible to its owner only, until they share it with everyone in the
  organization or with specific people, like a shared document.
- **Yours to keep.** A collection's owner and admins export it in open formats; its latest backup is kept as long as it
  exists.

## Who it is for

Business teams without engineers: partner, sales, support and operations leads, consultants and small companies, who
want one place for what their team knows and answers they can quote. And the AI assistants those people use, such as
Claude, ChatGPT, Codex and Gemini, which ask Knowledge as their person.

## How it runs on Insulin Apps

Knowledge runs at `https://knowledge.insulinapps.com` and is free within limits for each organization (see
[Limits](/docs/knowledge/limits)). Sign-in, organizations, people and roles, AI assistant connections, API clients and
mail are Insulin Apps' own, as for every Insulin app (see [Organizations and roles](/docs/platform/organizations-and-roles)).
Knowledge has no accounts or passwords of its own.

Each collection is kept apart from every other in its own engine, which sleeps when nobody asks and wakes for the next
question, so the hosted app can stay free. Knowledge is open source under the MIT license, so anyone can run the same
code on their own Cloudflare account.

## Where to go next

- [Getting started](/docs/knowledge/getting-started): your first collection, and what each role sees.
- [Collections and sources](/docs/knowledge/collections-and-sources): adding files, web pages and notes.
- [Asking and checking sources](/docs/knowledge/asking): answers, sources and "I won't guess".
- [AI assistants and the API](/docs/knowledge/ai-assistants-and-api): connecting assistants and programs.
