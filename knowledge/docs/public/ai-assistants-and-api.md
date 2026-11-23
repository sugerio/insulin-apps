---
title: Knowledge for AI assistants and the API
description: How AI assistants and OAuth clients ask Knowledge collections, the rules every request follows, and every endpoint as GET /api/catalog publishes it.
order: 8
---

This page describes how AI assistants and programs use Knowledge: how to connect, the rules every request follows, and
every endpoint grouped by area with the collection role it needs. It is for AI agents connected over MCP and for
developers connecting a program with an OAuth client. The authoritative list for any caller is `GET /api/catalog`,
which returns only what that caller may use right now.

## Connect

The base URL is `https://knowledge.insulinapps.com`, and every endpoint is under `/api/`.

- **AI assistants.** Connect an MCP client to `https://knowledge.insulinapps.com/mcp`. Knowledge's **Connect AI** page
  (`https://insulinapps.com/apps/knowledge/settings/connect-ai`, or **Settings › Connect AI** in Knowledge) has the setup
  for Claude Code, Codex, Gemini CLI, opencode, Claude.ai and ChatGPT. The assistant signs in as you and acts with your
  role in Knowledge and your role in each collection, no more. See [AI agents](/docs/platform/ai-agents).
- **OAuth clients.** An owner or admin of the organization creates an OAuth client, with a role in Knowledge, on
  Knowledge's **API access** page (`https://insulinapps.com/apps/knowledge/settings/api`). The program gets a token
  with the client-credentials grant and sends it as a Bearer token. See
  [API access with OAuth clients](/docs/platform/api-and-service-accounts).

![Knowledge's Connect AI page on insulinapps.com: the address of Knowledge's MCP server, what happens the first time an assistant connects, and the setup for Claude Code and Codex CLI](/docs/assets/screenshots/knowledge-connect-ai.png "Settings › Connect AI: Knowledge's MCP server and each client's setup")

```bash
# Get an access token, then ask what this OAuth client may call.
TOKEN=$(curl -s https://insulinapps.com/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d resource=https://knowledge.insulinapps.com | jq -r .access_token)

curl -s https://knowledge.insulinapps.com/api/catalog -H "Authorization: Bearer $TOKEN"
```

## Who sees what

- An **AI assistant** acts as its person: it lists and searches exactly the collections that person can ask.
- An **OAuth client** (an API client) has access of its own: it reaches a collection only when the collection's owner
  or an admin shares it with that client by name, never through general access, and it can't start collections.
- A collection's owner or admins can turn off **AI assistants and API clients** for that collection; then both get
  403 `assistants_off`, and `GET /api/collections` leaves it out for them.

## Rules every request follows

- **Every request names its collections.** A search names at least one collection and at most five, by their ids from
  `GET /api/collections`. With none, 400 `collection_required`; with more than five, 400 `too_many_collections`.
  Nothing searches every collection.
- **The same checks as the site.** The role in Knowledge and the role in each collection are checked on the server for
  every request. A collection of the organization without a role answers 403; an id of another organization answers
  404, exactly as an unknown id.
- **Browser only.** Sharing, a collection's settings, export, transfer, delete and changes to Rules and data are done
  by a person on the site. Assistants and API clients get 403 `browser_only`, and the catalog doesn't list them.
- **No waiting.** A collection that is asleep or learning answers at once with `status` `waking` or `learning` and
  `retryAfterSeconds`, never after the wake: ask again then.
- **Idempotency.** Requests that create something (a collection, a note, an import, a web page, a correction, a report,
  going back) need an `Idempotency-Key` header with a fresh random value. A retry with the same key answers the first
  result with `idempotent-replay: true`.
- **Acting for someone.** A program that writes what a person approved can name that person in an `x-on-behalf-of`
  header when it adds a note, a correction, files or a web page. See
  [Writing for people](#writing-for-people-notes-corrections-and-open-questions).
- **Errors in plain words**: `{ "error": "<code>", "message": "<what happened and what to do>" }`. Over a limit, 429:

```json
{
  "error": "quota_exceeded",
  "limit": "awake_hours_month",
  "resets_at": "2026-12-01T00:00:00Z",
  "message": "Your organization has used this month's 100 awake hours. Knowledge can't answer until December 1. For a higher limit, contact Insulin Apps support."
}
```

The message names Insulin Apps support's address when the platform has one. See [Limits](/docs/knowledge/limits).

## Search: the main call

An AI assistant asks Knowledge the way a person does on the site, through Knowledge's MCP server, and gets the
passages back rather than a written answer:

```diagram
title: How an AI assistant asks Knowledge
description: An AI assistant signs in once to Knowledge's MCP server and asks with its person's roles, naming one to five collections in each search. Knowledge returns passages with their files, pages and exact words, covered false when nothing covers the question, or a time to ask again while a collection wakes or learns.
size: 760 x 360
box assistant 20 30 180 84 "Your AI assistant" "Claude, ChatGPT, Codex," "Gemini, opencode…"
box mcp 240 30 260 84 accent "Knowledge's MCP server" "knowledge.insulinapps.com/mcp" "acts as you: your roles, no more"
box search 530 30 200 84 "A search" "names 1 to 5 collections" "you can ask"
box passages 20 200 230 110 accent "Passages" "each with its file, pages and" "exact words: the assistant" "writes the answer and links" "to the sources"
box uncovered 265 200 230 110 muted "covered: false" "nothing in them covers" "the question: the assistant" "says it won't guess"
box waiting 520 200 220 110 dashed "Waking or learning" "status and retryAfterSeconds:" "ask again then"
arrow assistant.r -> mcp.l
arrow mcp.r -> search.l
arrow search.b -> passages.t mid=160
arrow search.b -> uncovered.t mid=160
arrow search.b -> waiting.t
text 380 340 small muted "Every request is checked as on the site; sharing, settings, export and delete stay on the site."
```

`POST /api/search` with `{ "collections": ["<id>", …], "query": "<question>", "topK": 8 }` (`topK` optional, 1 to 20)
returns:

- `status`: `ok`, or `waking`, `learning`, `busy` with `retryAfterSeconds`;
- `covered`: false when nothing answers the question, with a `message`: say you won't guess rather than answer
  without a source;
- `passages`: each with `documentId`, `documentName`, `page` and `pageEnd` (the first and last page, or slide, the
  passage runs over: the same number when it is on one page; null for a file without pages), `start` and `end`
  (character positions in the source's text), `text`, `textHash` and `score`;
- `facts`, `collections` (each named collection's status) and `skipped` (collections named that the caller can't ask).

Write the answer from the passages and link to the sources on the site. `GET /api/collections/{id}/sources/{documentId}`
returns the source's text (hidden values as `[hidden]`) and its pages.

## Writing for people: notes, corrections and open questions

A program can keep a collection up to date for the people who use it: it proposes notes and corrections, a person
approves them, and the program writes them. Three things make that safe. They need the collection's Editor role (an
OAuth client gets it from a share by name) and permission to change content.

**The collection's version.** Every collection has a `version` (in `GET /api/collections` and
`GET /api/collections/{id}`): the number of its latest restore point. It grows with every change to what the collection
knows: files, web pages, notes and corrections learned, a file stopped or used again, removed for good, going back and
undo. In `GET /api/collections` it can trail a change made elsewhere until Knowledge next reads the engine's changes,
right after any request to a collection or within five minutes; `engine.version` in `GET /api/collections/{id}` is
always current.

**Write only if nothing changed meanwhile: `expectedVersion`.** A note (`POST /api/collections/{id}/notes`) or a
correction (`POST /api/collections/{id}/corrections`) can carry `"expectedVersion": <version>`, the version the program
read before it proposed the change. Knowledge checks it twice:

- when it receives the request: at any other version it answers 409, and adds nothing:

```json
{
  "error": "version_changed",
  "currentVersion": 13,
  "message": "This collection has changed since version 12: it is at version 13 now, so nothing was added. Read it again and, if the change still applies, send it again with expectedVersion 13."
}
```

- when the collection learns it, after its turn in the queue (or on the 1st, for a change that waited for the month's
  documents learned): if something else changed the collection first, the import fails, learning nothing, and its
  status says why: `"state": "failed"`, `"error": { "error": "version_changed", "message": "…" }`.

A request sent again with the same `Idempotency-Key` answers its first result, whatever the version now. Once an import
is `committed`, its `version` is the collection's new version: the next change can name it. Without `expectedVersion`
nothing is checked.

**Say whom you act for: `x-on-behalf-of`.** On adding a note, a correction, files (`POST …/imports`), a web page or
starting from an export, the header `x-on-behalf-of: Ana Lee` (trimmed, 1 to 200 characters, one line, UTF-8) names
whom the program acts for. It is kept with the import, answered as `onBehalfOf` in the change's answer, in
`GET /api/collections/{id}/imports/{importId}` and in the lists of imports, and History shows it: "Partner Agent, on behalf
of Ana Lee". It is a label only: it gives no access, and Knowledge never checks it against anyone's account. It isn't part
of the request a retry repeats: a retry with the same `Idempotency-Key` and another value keeps the first value. Longer
than 200 characters, with control characters, or not sent as UTF-8, it answers 400 `bad_request` with
`"header": "x-on-behalf-of"`.

```bash
curl -s https://knowledge.insulinapps.com/api/collections/$COLLECTION/notes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "x-on-behalf-of: Ana Lee" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Renewal timeline", "text": "Start renewals 120 days before the end date.", "expectedVersion": 12 }'
```

It answers 202 with the import to follow:

```json
{
  "import": { "importId": "6f1c…", "state": "queued", "version": null, "error": null, "onBehalfOf": "Ana Lee" },
  "waiting": null
}
```

Then ask `GET /api/collections/{id}/imports/{importId}` until `state` is `committed` (with `version`), `duplicate`,
`failed` (with `error`) or `cancelled`. A correction answers the same, with `correction: { id, outdated }` beside it.
`GET /api/collections/{id}/history` lists who made each restore point's changes in `madeBy`
(`[{ "id", "type": "person" | "client", "name", "onBehalfOf" }]`); going back, undo and stopping a file name no one.

**What nothing answered: `GET /api/collections/{id}/gaps`.** The questions nothing in the collection covered (the
ones answered "I won't guess"), still open, newest asked first, with how many times each was asked:

```json
{
  "gaps": [
    { "question": "What is the parking policy?", "asked": 3, "firstAskedAt": "2026-11-02T09:15:00.000Z", "lastAskedAt": "2026-11-20T16:40:00.000Z" }
  ],
  "next": "WzE3OTU…"
}
```

`?limit=` takes 1 to 100 (50 by default); `next` is there only while there are more: send it back as `?cursor=`. The
questions are shown with the values your organization hides replaced by `[hidden]`. It needs the collection's Editor
role and permission to change content: a Viewer, or an OAuth client whose role only asks and reads, gets 403.

## Endpoints

Paths with `{id}` need the collection role shown; "–" needs none.

### Collections

| Endpoint | Role | What it does |
|---|---|---|
| `GET /api/me` | – | Who is calling: the organization, the role in Knowledge and its permissions |
| `GET /api/catalog` | – | The endpoints the caller may use, with their query and body schemas |
| `GET /api/collections` | – | The collections you can ask, with names, purposes and your role in each. Start here. |
| `POST /api/collections` | – | Start a collection (`{ name, purpose }`); people with Start collections only |
| `GET /api/collections/others` | – | Organization owners: basic information about the collections not shared with them, never their contents |
| `GET /api/collections/{id}` | Viewer | Its purpose, your role, its state, counts and current import |

### Asking

| Endpoint | Role | What it does |
|---|---|---|
| `POST /api/search` | Viewer | Passages that answer a question, from 1 to 5 named collections, and `covered` |
| `POST /api/ask` | Viewer | On the site only: a written answer with checked citations, or "I won't guess" |

### Sources

| Endpoint | Role | What it does |
|---|---|---|
| `GET /api/collections/{id}/sources` | Viewer | Its files, web pages and notes, and whether each is used |
| `GET /api/collections/{id}/sources/{docId}` | Viewer | One source's text, with hidden values as `[hidden]`, and its pages |
| `POST /api/collections/{id}/preflight` | Editor | Which files can be learned, with a `fileId` each, within the limits |
| `PUT /api/collections/{id}/uploads/{fileId}` | Editor | Upload a file preflight accepted (raw bytes; optionally `x-file-sha256`) |
| `POST /api/collections/{id}/imports` | Editor | Learn uploaded files, all or nothing |
| `GET /api/collections/{id}/imports/{importId}` | Viewer | An import's progress, file by file, with the time left, how it ended, and `onBehalfOf` |
| `GET /api/collections/{id}/imports?state=waiting` | Viewer | Imports waiting for the 1st: what each brings, who added it, when it starts (`?state=queued`: those Insulin has but hasn't started learning) |
| `DELETE /api/collections/{id}/imports/{importId}` | Editor | Cancel an import waiting for the 1st, or one Insulin hasn't started learning: it is never learned |
| `POST /api/collections/{id}/import-export` | Editor | Start an empty collection from a Knowledge export (`{ fileId }`, after preflight with `"export": true` and the upload) |
| `POST /api/collections/{id}/notes` | Editor | Add a note (`expectedVersion` and `x-on-behalf-of` optional) |
| `POST /api/collections/{id}/web-pages` | Editor | Add a public web page; add it again to read it again |
| `PATCH /api/collections/{id}/sources/{docId}` | Editor | Stop using a file (`{ "active": false }`) or use it again |
| `DELETE /api/collections/{id}/sources/{docId}` | Admin | Remove a file for good |

### What it knows, fixes and reports

| Endpoint | Role | What it does |
|---|---|---|
| `GET /api/collections/{id}/facts` | Viewer | Facts as sentences, each with its source sentence and `checked` (`{ by, at }` or null) (`?cursor=` for more) |
| `POST /api/collections/{id}/facts/{factId}/check` | Editor | Mark a fact as checked ("Looks right"), with your name |
| `POST /api/collections/{id}/corrections` | Editor | Fix an answer or a fact once (`expectedVersion` and `x-on-behalf-of` optional) |
| `GET /api/collections/{id}/gaps` | Editor | The questions nothing covered, newest asked first (`?limit=`, `?cursor=`); needs permission to change content |
| `POST /api/collections/{id}/reports` | Viewer | Report that an answer may be wrong |
| `GET /api/collections/{id}/reports` | Viewer | Reports, open, fixed or dismissed |
| `PATCH /api/collections/{id}/reports/{reportId}` | Editor | Settle a report |
| `POST /api/collections/{id}/correction-checks/clear` | Editor | A correction to check is still right (`{ noteId, documentId, textHash }` from Needs attention) |
| `POST /api/answers/{answerId}/right` | – | "Was this right?" Yes, for an answer you asked for |

### Needs attention

| Endpoint | Role | What it does |
|---|---|---|
| `GET /api/attention` | Editor | Files Insulin couldn't read, values hidden before learning, reported answers waiting and corrections to check, in every collection you can change (`?collection=<id>` for one, always read in full). Values hidden before learning are read for the 50 collections changed most recently; the others are marked `"partial": true`, and `notice` says how many. Needs permission to change content. |

Its items are `unreadable` (an import that failed, or a file refused at upload, in the last 30 days, until a file with
the same name is learned; not one that failed with `version_changed`, which its sender is told about), `hidden` (a recent file or note in which values were hidden, with how many in all as
`total`, never the values), `reported` (open reports) and `needs_check` (a correction whose file was read again: its
text as learned, the file, and the `noteId`, `documentId` and `textHash` that clear it). Assistants and API clients see
only collections whose switch for them is on.

### History

| Endpoint | Role | What it does |
|---|---|---|
| `GET /api/collections/{id}/history` | Viewer | Restore points, whether each can be brought back, and who made their changes (`madeBy`) |
| `GET /api/collections/{id}/history/{version}/preview` | Viewer | What going back would do |
| `POST /api/collections/{id}/history/{version}/go-back` | Editor | Answer from an earlier restore point |
| `POST /api/collections/{id}/history/undo` | Editor | Undo going back |

### Rules and data (Admins in Knowledge)

| Endpoint | What it does |
|---|---|
| `GET /api/rules` | The time zone, who writes answers on the site, and what is hidden before learning |
| `POST /api/rules/hiding-preview` | What the hiding rules would hide in a text |
| `POST /api/rules/ask-for-more` | Ask Insulin Apps support for higher limits, with the organization's usage |
| `GET /api/usage` | Usage beside each limit, and awake hours for the collections you have a role in |
| `GET /api/health` | Each collection you have a role in, and the organization's totals |

On the site only (never listed for assistants or API clients): changing a collection's settings, sharing, export,
transfer, delete and changing Rules and data.
