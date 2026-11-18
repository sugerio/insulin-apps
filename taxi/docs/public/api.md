---
title: Taxi API
description: Taxi's HTTP API for AI agents and OAuth clients: every endpoint, the permission it needs, and how saves are protected from overwriting someone else's change.
order: 4
---

This page describes Taxi's API. It is for developers connecting another system with an OAuth client, and for AI
agents connected over MCP. The list for any caller is `GET /api/catalog`, which returns only what that caller may use.

## Base URL and authentication

The base URL is `https://taxi.insulinapps.com`, and every endpoint is under `/api/`.

- **AI agents over MCP.** Connect an MCP client to `https://taxi.insulinapps.com/mcp`. The **Connect AI** page
  (**Settings › Connect AI**) has the setup for each client. The agent acts with your role.
- **OAuth clients.** An owner or admin creates one on the **API access** page (**Settings › API access**), with a role.
  Get a token with the client-credentials grant and send it as `Authorization: Bearer <token>`.

## Endpoints

| Method and path | Permission | What it does |
|---|---|---|
| `GET /api/me` | any | Who is calling: their role and permissions. |
| `GET /api/catalog` | any | The endpoints the caller may use, with request bodies as JSON Schema. |
| `GET /api/years` | View returns | The household's people and tax years, with each adult's return and its steps. |
| `POST /api/years` | Prepare returns | Start a tax year with the people in it: `{"year": 2025, "people": ["…"]}`. You must be one of them; your spouse in it prepares both returns together. Starting one that exists returns it unchanged. |
| `GET /api/years/{year}` | View returns | A tax year: who is in it, the marital status, each adult's province and residency, open issues, and each adult's return with the state of its six steps (`returns`). |
| `GET /api/years/{year}/estimate` | View returns | What the engine computes for each return of the year (below). |
| `PUT /api/years/{year}/people` | Prepare returns | Change who is in the year: `{"revision", "people"}`. Someone taken out loses their facts for that year. |
| `PUT /api/years/{year}/household` | Prepare returns | Save the year's facts (below). |
| `GET /api/years/{year}/documents` | View returns | The files uploaded for the year, with what reading each one found and the slips it added. |
| `POST /api/years/{year}/documents` | Prepare returns | Upload one file for AI to read: its bytes as the body, its `Content-Type` (`application/pdf`, `image/png` or `image/jpeg`), its name in an `X-File-Name` header (URI-encoded), and the adult whose return it is uploaded in as `X-Person-Id` (the person preparing without it). Up to 10 MiB. A slip with the other adult's name goes to their return; one with no name that matches stays in this return. Answers with what reading gave (`status`, `message`), the file as saved and the year. The same file, or a file whose slips are all in the year already, isn't saved: `status` is `duplicate` and the file is null. |
| `POST /api/years/{year}/documents/{id}/read` | Prepare returns | Read a file again that couldn't be read (`failed` or `not_available`), from its stored bytes. Answers like an upload. |
| `DELETE /api/years/{year}/documents/{id}` | Prepare returns | Delete a file and every slip read from it, in whichever return it is. Body: `{"revision": …}`, the revision you read; a stale one is refused with 409. |
| `GET /api/years/{year}/documents/{id}/file` | View returns | The stored file, as uploaded. |
| `PUT /api/years/{year}/answers` | Prepare returns | Save an adult's answers: `{"revision", "personId", "answers": {"rrspDeduction": "5000", "hasRentalIncome": false}}`. `null` clears an answer. |
| `GET /api/years/{year}/slips` | View returns | Every slip of the year's adults, with its boxes and whether it is confirmed. |
| `POST /api/years/{year}/slips` | Prepare returns | Add a slip: `{"revision", "personId", "type": "T4", "issuer", "boxes": {"14": "60000.00"}}`. It starts unconfirmed. |
| `PATCH /api/years/{year}/slips/{id}` | Prepare returns | Change whose slip it is, its issuer or its boxes: `{"revision", "personId"?, "issuer"?, "boxes"?}`. It goes back to unconfirmed. |
| `DELETE /api/years/{year}/slips/{id}` | Prepare returns | Remove a slip: `{"revision"}`. |
| `POST /api/years/{year}/slips/confirm` | Prepare returns | Confirm one adult's unconfirmed slips: `{"revision", "personId"}`; without `personId`, every adult's. |
| `GET /api/people` | View returns | Everyone in the household, the same every year. |
| `POST /api/people` | Prepare returns | Add a person: `{"name", "relationship", "birthDate"}`. |
| `PATCH /api/people/{id}` | Prepare returns | Change a person's name, relationship or birth date. |
| `DELETE /api/people/{id}` | Prepare returns | Remove a person, with their facts in every year. You can't remove yourself. |

`relationship` is `self`, `spouse`, `child` or `other_dependant`; there can be one `self` and one `spouse`. Dates are
`YYYY-MM-DD`.

## Saving a year's facts

```json
{
  "revision": 1,
  "maritalStatus": "married",
  "adults": [
    { "personId": "…", "province": "ON", "residentAllYear": true }
  ]
}
```

`adults` are you, and your spouse when they are in the year. Send the `revision` from your last read of the year (the
same for `PUT /api/years/{year}/people`). If someone changed the year since, the save is refused with `409`
and nothing is changed: read the year again and retry. `maritalStatus` is `married` or `common_law` when the household
has a spouse, and `single`, `widowed`, `divorced` or `separated` when it has none; another value is refused with `400`.
`province` is a two-letter code.

A year's answer lists `issues`. Those of kind `blocking` keep the step from being done; those of kind `unsupported` say
what the app can't prepare, such as a province other than Ontario, British Columbia or Alberta.

## A year's estimate

`GET /api/years/{year}/estimate` returns `input` and `result`. `input` is what the engine computed from: the year's
adults (`id`, `name`, `role`, `birthDate`, `province`), their `answers` and their `slips`. `result.people` has one entry
per return:

- `lines`: the result lines (total income, net income, taxable income, net federal tax, provincial tax, total payable,
  tax deducted, refund, balance owing), each with a `value` as decimal text and a `status`: `complete`, `estimate` or
  `missing`.
- `estimates`: questions with no answer whose usual answer was used, with the `assumed` value.
- `missing`: questions with no answer and no usual answer.
- `unhandled`: what was entered that the app doesn't use, such as a slip box, and the cases the rules can't compute
  yet, such as a CPP overpayment from two jobs. A line those cases reach is `missing`.

`result.rulesVersion` names the rules the result was computed with. Nothing is stored: each request computes again.
Each entry of `result.people` also lists `questions`: every question its result lines read. The year's rules say what
each question asks and its type (money as decimal text, yes/no, a choice); the slip types and their boxes come from
the same rules. A slip's box must be one its type has, and an amount is dollars and cents such as `1234.56`.

## Errors

Every error is JSON: `{"error": {"code", "message", "issues"?}}`. The codes are `validation_failed` (400, with each
field's issue), `unauthenticated` (401), `forbidden` (403), `not_found` (404, also for another organization's records),
`conflict` (409), `payload_too_large` (413) and `internal` (500).
