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
| `GET /api/years` | View returns | The household's people and tax years, with each year's progress. |
| `POST /api/years` | Prepare returns | Start a tax year: `{"year": 2025}`. Starting one that exists returns it unchanged. |
| `GET /api/years/{year}` | View returns | A tax year: people, marital status, each adult's province and residency, and open issues. |
| `PUT /api/years/{year}/household` | Prepare returns | Save the year's household facts (below). |
| `POST /api/people` | Prepare returns | Add a person: `{"name", "relationship", "birthDate"}`. |
| `PATCH /api/people/{id}` | Prepare returns | Change a person's name, relationship or birth date. |
| `DELETE /api/people/{id}` | Prepare returns | Remove a person, with their facts in every year. You can't remove yourself. |

`relationship` is `self`, `spouse`, `child` or `other_dependant`; there can be one `self` and one `spouse`. Dates are
`YYYY-MM-DD`.

## Saving a year's household facts

```json
{
  "revision": 1,
  "maritalStatus": "married",
  "prepareTogether": true,
  "adults": [
    { "personId": "…", "province": "ON", "residentAllYear": true }
  ]
}
```

Send the `revision` from your last read of the year. If someone changed the year since, the save is refused with `409`
and nothing is changed: read the year again and retry. `maritalStatus` is `married`, `common_law`, `widowed`,
`divorced`, `separated` or `single`; `province` is a two-letter code.

A year's answer lists `issues`. Those of kind `blocking` keep the step from being done; those of kind `unsupported` say
what the app can't prepare, such as a province other than Ontario, British Columbia or Alberta.

## Errors

Every error is JSON: `{"error": {"code", "message", "issues"?}}`. The codes are `validation_failed` (400, with each
field's issue), `unauthenticated` (401), `forbidden` (403), `not_found` (404, also for another organization's records),
`conflict` (409), `payload_too_large` (413) and `internal` (500).
