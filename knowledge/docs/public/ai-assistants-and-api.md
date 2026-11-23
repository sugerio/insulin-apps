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

The base URL is `https://knowledge.insulin-apps.com`, and every endpoint is under `/api/`.

- **AI assistants.** Connect an MCP client to `https://knowledge.insulin-apps.com/mcp`. Knowledge's **Connect AI** page
  (`https://insulin-apps.com/apps/knowledge/settings/connect-ai`, or **Settings › Connect AI** in Knowledge) has the setup
  for Claude Code, Codex, Gemini CLI, opencode, Claude.ai and ChatGPT. The assistant signs in as you and acts with your
  role in Knowledge and your role in each collection, no more. See [AI agents](/docs/platform/ai-agents).
- **OAuth clients.** An owner or admin of the organization creates an OAuth client, with a role in Knowledge, on
  Knowledge's **API access** page (`https://insulin-apps.com/apps/knowledge/settings/api`). The program gets a token
  with the client-credentials grant and sends it as a Bearer token. See
  [API access with OAuth clients](/docs/platform/api-and-service-accounts).

![Knowledge's Connect AI page on insulin-apps.com: the address of Knowledge's MCP server, what happens the first time an assistant connects, and the setup for Claude Code and Codex CLI](/docs/assets/screenshots/knowledge-connect-ai.png "Settings › Connect AI: Knowledge's MCP server and each client's setup")

```bash
# Get an access token, then ask what this OAuth client may call.
TOKEN=$(curl -s https://insulin-apps.com/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d resource=https://knowledge.insulin-apps.com | jq -r .access_token)

curl -s https://knowledge.insulin-apps.com/api/catalog -H "Authorization: Bearer $TOKEN"
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
box mcp 240 30 260 84 accent "Knowledge's MCP server" "knowledge.insulin-apps.com/mcp" "acts as you: your roles, no more"
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
| `GET /api/collections/{id}/imports/{importId}` | Viewer | An import's progress, file by file, with the time left |
| `GET /api/collections/{id}/imports?state=waiting` | Viewer | Imports waiting for the 1st: what each brings, who added it, when it starts (`?state=queued`: those Insulin has but hasn't started learning) |
| `DELETE /api/collections/{id}/imports/{importId}` | Editor | Cancel an import waiting for the 1st, or one Insulin hasn't started learning: it is never learned |
| `POST /api/collections/{id}/import-export` | Editor | Start an empty collection from a Knowledge export (`{ fileId }`, after preflight with `"export": true` and the upload) |
| `POST /api/collections/{id}/notes` | Editor | Add a note |
| `POST /api/collections/{id}/web-pages` | Editor | Add a public web page; add it again to read it again |
| `PATCH /api/collections/{id}/sources/{docId}` | Editor | Stop using a file (`{ "active": false }`) or use it again |
| `DELETE /api/collections/{id}/sources/{docId}` | Admin | Remove a file for good |

### What it knows, fixes and reports

| Endpoint | Role | What it does |
|---|---|---|
| `GET /api/collections/{id}/facts` | Viewer | Facts as sentences, each with its source sentence and `checked` (`{ by, at }` or null) (`?cursor=` for more) |
| `POST /api/collections/{id}/facts/{factId}/check` | Editor | Mark a fact as checked ("Looks right"), with your name |
| `POST /api/collections/{id}/corrections` | Editor | Fix an answer or a fact once |
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
the same name is learned), `hidden` (a recent file or note in which values were hidden, with how many in all as
`total`, never the values), `reported` (open reports) and `needs_check` (a correction whose file was read again: its
text as learned, the file, and the `noteId`, `documentId` and `textHash` that clear it). Assistants and API clients see
only collections whose switch for them is on.

### History

| Endpoint | Role | What it does |
|---|---|---|
| `GET /api/collections/{id}/history` | Viewer | Restore points, and whether each can be brought back |
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
