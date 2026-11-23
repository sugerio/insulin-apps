---
title: Taxi API
description: Taxi's HTTP API for AI agents and OAuth clients: every endpoint, the permission it needs, and how saves are protected from overwriting someone else's change.
order: 4
---

This page describes Taxi's API. It is for developers connecting another system with an OAuth client, and for AI
agents connected over MCP. The list for any caller is `GET /api/catalog`, which returns only what that caller may use.

## Base URL and authentication

The base URL is `https://taxi.insulin-apps.com`, and every endpoint is under `/api/`.

- **AI agents over MCP.** Connect an MCP client to `https://taxi.insulin-apps.com/mcp`. The **Connect AI** page
  (**Settings › Connect AI**) has the setup for each client. The agent acts with your role.
- **OAuth clients.** An owner or admin creates one on the **API access** page (**Settings › API access**), with a role.
  Get a token with the client-credentials grant and send it as `Authorization: Bearer <token>`.

## Endpoints

| Method and path | Permission | What it does |
|---|---|---|
| `GET /api/me` | any | Who is calling: their role and permissions. |
| `GET /api/catalog` | any | The endpoints the caller may use, with request bodies and query parameters as JSON Schema, the two that answer with a file included. |
| `GET /api/years` | View returns | The people in the profile and tax years, with each adult's return and its steps. |
| `POST /api/years` | Prepare returns | Start a tax year with the people in it: `{"year": 2025, "people": ["…"]}`. You must be one of them; your spouse in it prepares both returns together. Starting one that exists returns it unchanged. |
| `GET /api/years/{year}` | View returns | A tax year: who is in it, the marital status, each adult's province and residency, open issues, and each adult's return with the state of its seven steps (`returns`: personal, upload, income, deductions, credits, confirm, finish). |
| `GET /api/years/{year}/estimate` | View returns | What the engine computes for each return of the year (below). |
| `GET /api/years/{year}/hints` | View returns | Each return's hints (below), with their state: `open`, `applied` (an accepted saving) or `dismissed`. |
| `POST /api/years/{year}/hints/{hint}` | Prepare returns | Decide on a hint of an adult's return: `{"revision", "personId", "decision"}`, where `decision` is `accept` (a saving: its answers are saved), `dismiss`, or `undo` (puts back the answers an accepted saving changed while they are still as it set them, or shows a dismissed hint again). A saving is `applied` only while every answer it set is unchanged; after that it is listed `open` again only if it still saves something, it can be dismissed, and `undo` only removes its decision. A saving that no longer applies is refused with 409, and so is dismissing a saving that is still applied. |
| `PUT /api/years/{year}/people` | Prepare returns | Change who is in the year: `{"revision", "people"}`. Someone taken out loses their facts for that year. |
| `PUT /api/years/{year}/personal-info` | Prepare returns | Save the year's facts (below). |
| `GET /api/years/{year}/documents` | View returns | The files uploaded for the year, with what reading each one found and the slips it added. |
| `POST /api/years/{year}/documents` | Prepare returns | Upload one file for AI to read: its bytes as the body, its `Content-Type` (`application/pdf`, `image/png` or `image/jpeg`), its name in an `X-File-Name` header (URI-encoded; required, since a file replaces the one of the same name in the return: without it the upload is refused with 400), and the adult whose return it is uploaded in as `X-Person-Id` (the person preparing without it). Up to 10 MiB. A slip with the other adult's name goes to their return. A slip naming someone else in the year, who has no return here (a child), isn't added, and the message says whose it is; a receipt for them, such as a medical receipt, stays in this return. A slip whose name matches no one in the year, or several, stays in this return, and the message says to check whose it is. Answers with what reading gave (`status`, `message`), the file as saved, the files it `replaced`, and the year. A file with the name of one in the same return, changed or not, replaces it and its slips once it is read into slips; if it can't be, the earlier one is kept and the file is null. Otherwise the same file under another name, or a file whose slips are all in the year already, isn't saved, even when both are uploaded at the same time: `status` is `duplicate` and the file is null. An upload that fails part-way changes nothing. |
| `POST /api/years/{year}/documents/{id}/read` | Prepare returns | Read a file again that couldn't be read (`failed` or `not_available`), from its stored bytes. Answers like an upload. |
| `DELETE /api/years/{year}/documents/{id}` | Prepare returns | Delete a file and every slip read from it, in whichever return it is. Body: `{"revision": …}`, the revision you read; a stale one is refused with 409. |
| `GET /api/years/{year}/documents/{id}/file` | View returns | The stored file, as uploaded: the PDF, PNG or JPEG itself. |
| `GET /api/years/{year}/returns/{personId}/forms` | View returns | A finished return as a PDF to save: the CRA's T1 and provincial form with the amounts filled in, then a worksheet. For a resident of Quebec, Revenu Québec's TP-1 and its schedules come after the federal forms. Add `language=fr` to print Revenu Québec's forms in French; the CRA's forms and the worksheet stay in English. Add `download=1` to save the file instead of opening it. Refused with 400 for another language, with 409 while anything is left before filing (the message says what), and with 503 when canada.ca or revenuquebec.ca doesn't answer or its form changed. |
| `PUT /api/years/{year}/answers` | Prepare returns | Save an adult's answers: `{"revision", "personId", "answers": {"rrspDeduction": "5000", "hasRentalIncome": false}}`. `null` clears an answer. A count is a whole number from 0 to 999, or up to the most its question allows (such as 12 for the months of a year, 365 for its days); any other answer is refused with 400, naming the range. |
| `GET /api/years/{year}/slips` | View returns | Every slip of the year's adults, with its boxes and whether it is confirmed. |
| `POST /api/years/{year}/slips` | Prepare returns | Add a slip: `{"revision", "personId", "type": "T4", "issuer", "boxes": {"14": "60000.00"}}`. It starts unconfirmed. |
| `PATCH /api/years/{year}/slips/{id}` | Prepare returns | Change whose slip it is, its issuer or its boxes: `{"revision", "personId"?, "issuer"?, "boxes"?}`. It goes back to unconfirmed. `boxes` replaces them all; a box in `unsure` is no longer marked once it is among them, and one left out stays marked. |
| `DELETE /api/years/{year}/slips/{id}` | Prepare returns | Remove a slip: `{"revision"}`. |
| `POST /api/years/{year}/slips/confirm` | Prepare returns | Confirm one adult's unconfirmed slips: `{"revision", "personId"}`; without `personId`, every adult's. Refused with 400, naming each box, while a slip has a box AI couldn't read (in `unsure`) and no amount: send it in the slip's `boxes` first, as `0` if it is blank on the slip. |
| `GET /api/people` | View returns | Everyone in the profile, the same every year. |
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
and nothing is changed: read the year again and retry. `maritalStatus` is `married` or `common_law` when the profile
has a spouse, and `single`, `widowed`, `divorced` or `separated` when it has none; another value is refused with `400`.
`province` is a two-letter code.

A year's answer lists `issues`. Those of kind `blocking` keep the step from being done; those of kind `unsupported` say
what the app can't prepare. Every province and territory is prepared, so today no issue is of that kind.

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
  yet, such as T4 slips where only some show box 26. A line those cases reach is `missing`.

`result.rulesVersion` names the rules the result was computed with. Nothing is stored: each request computes again.
Each entry of `result.people` also lists `questions`: every question its result lines read. The year's rules say what
each question asks and its type (money as decimal text, yes/no, a choice); the slip types and their boxes come from
the same rules. A slip's box must be one its type has, and an amount is dollars and cents such as `1234.56`.

## Hints

`GET /api/years/{year}/hints` answers `{"revision", "hints": [...]}`. Each hint has:

- `id`, the hint in the year's rules (`poolDonations`), and `personId`, the return it is about;
- `kind`: `saving`, `info` or `warning`; `title` and `text`;
- `amount`: a number shown with it, `{"label", "value"}`, or null;
- `effect`: for a saving, what the combined refund less balance owing of the year's returns goes up by with its change (for an applied
  one, what it saved when accepted); for an info hint with a change, what the change makes, named by `effectLabel`;
- `state`: `open`, `applied` or `dismissed`.

Accepting a saving saves its answers on one or both returns, for example `claimSpouseDonations: true` on one return
and `false` on the other. These answers are ordinary answers: the estimate explains them like any other.

## Errors

Every error is JSON: `{"error": {"code", "message", "issues"?}}`. The codes are `validation_failed` (400, with each
field's issue), `unauthenticated` (401), `forbidden` (403), `not_found` (404, also for another organization's records),
`conflict` (409), `payload_too_large` (413), `internal` (500) and `unavailable` (503, when canada.ca or
revenuquebec.ca doesn't answer or a form changed).
