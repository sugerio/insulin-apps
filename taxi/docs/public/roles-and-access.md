---
title: Roles and access
description: What owners, admins, editors and viewers can do in Taxi, the two permissions for custom roles, and how AI agents and API clients are limited.
order: 3
---

Taxi follows the roles of your Insulin Apps organization. This page says what each role can do, which
permissions a custom role can be given, and how AI agents and API clients are limited.

## What each role can do

| Role | In Taxi |
|---|---|
| Owner, Admin, Editor | Add and change the people in the profile, start a tax year and choose who is in it, and save its facts. |
| Viewer | See the people in the profile and every tax year, and change nothing. |
| Custom role | What its permissions allow (below). |

People and roles are managed on Insulin Apps, under **Settings › People**. Taxi has no sign-in or user list of
its own.

## Permissions for custom roles

| Permission | Lets someone | Least built-in role with it |
|---|---|---|
| Prepare returns (`taxi.prepare`) | Change the profile, add and confirm documents, enter answers, and apply or dismiss hints. Includes viewing. | Editor |
| View returns (`taxi.view`) | See the profile, its documents and every number, read only, and download a finished return's forms. | Viewer |

A custom role only takes permissions away from its base role; it never adds one.

## AI agents and API clients

An AI agent connected over MCP acts as its person, with their current role. An API client has the role an owner or
admin gave it. Both see the same API as the browser, under the same rules: `GET /api/catalog` lists only what the caller
may use. See [Taxi API](/docs/taxi/api).

## Organizations

Each organization has one profile. One organization never sees another's people or tax years.
