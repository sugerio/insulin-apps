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

- **Every answer has a source.** Answers cite the exact words they come from, with the file and the pages (or slides)
  they are on. When nothing in the collection covers a question, Knowledge says "I won't guess" instead of answering
  without a source.
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

## How it works, end to end

What a team adds goes through two steps before anyone can ask it: hidden values are removed, then the collection
learns what is left. Questions, from the site, an AI assistant or a program, are answered from the collections they
name and nothing else.

```diagram
title: From your files to an answer with its sources
description: Hidden values are removed from your files, web pages and notes before the collection learns them, and a restore point is saved. A question from the site, an AI assistant or the API names one to five collections, and Knowledge answers with numbered sources, or says it won't guess.
size: 820 x 410
box files 20 20 170 46 "Files" "PDF, Word, Excel, slides…"
box web 20 76 170 46 "Web pages" "public pages"
box notes 20 132 170 46 "Notes" "in your own words"
box hidden 240 40 240 118 "Hidden values removed" "e-mail addresses, phone and" "card numbers, API keys and" "passwords, before learning;" "originals deleted once read"
box collection 530 30 270 138 db accent "Your collection" "learns the text as passages and" "facts, each with its file and" "pages; every change saves a" "restore point"
arrow files.r -> hidden.l:0.25
arrow web.r -> hidden.l:0.5
arrow notes.r -> hidden.l:0.75
arrow hidden.r -> collection.l "learned"
box site 20 240 170 46 "The site" "the Ask tab, or Home"
box assistant 20 296 170 46 "An AI assistant" "over MCP, as you"
box api 20 352 170 46 "A program" "the API, OAuth client"
box search 240 269 240 100 "Finds the passages" "that answer it, only in the" "1 to 5 collections named," "never on the internet"
box answer 530 236 270 70 accent "An answer with its sources" "numbered, at the exact words," "with the file and its pages"
box wontguess 530 326 270 70 muted "“I won't guess”" "when nothing in them covers" "the question"
arrow site.r -> search.l:0.2
arrow assistant.r -> search.l:0.5
arrow api.r -> search.l:0.8
arrow collection.b -> search.t dashed "its passages" mid=218
arrow search.r:0.2 -> answer.l
arrow search.r:0.8 -> wontguess.l
```

On the site, a model writes a short answer from those passages alone, and Knowledge checks every number it cites; an
AI assistant or a program gets the passages and writes its own. See
[Asking and checking sources](/docs/knowledge/asking) and [Hiding personal data](/docs/knowledge/hiding-personal-data).

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
question, so the hosted app can stay free (see
[where Knowledge runs and keeps your data](/docs/knowledge/your-data#where-knowledge-runs-and-keeps-your-data)).
Knowledge is open source under the MIT license, so anyone can run the same code on their own Cloudflare account.

## Where to go next

- [Getting started](/docs/knowledge/getting-started): your first collection, and what each role sees.
- [Collections and sources](/docs/knowledge/collections-and-sources): adding files, web pages and notes.
- [Asking and checking sources](/docs/knowledge/asking): answers, sources and "I won't guess".
- [AI assistants and the API](/docs/knowledge/ai-assistants-and-api): connecting assistants and programs.
