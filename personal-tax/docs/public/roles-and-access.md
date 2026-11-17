---
title: Roles and access
description: What owners, admins, editors and viewers can do in Personal Tax, the two permissions for custom roles, and how AI agents and API clients are limited.
order: 3
---

Personal Tax follows the roles of your Insulin Apps organization. This page says what each role can do, which
permissions a custom role can be given, and how AI agents and API clients are limited.

## What each role can do

| Role | In Personal Tax |
|---|---|
| Owner, Admin, Editor | Start a tax year, add and change people, and save the household's facts. |
| Viewer | See the household and every tax year, and change nothing. |
| Custom role | What its permissions allow (below). |

People and roles are managed on Insulin Apps, under **Settings › People**. Personal Tax has no sign-in or user list of
its own.

## Permissions for custom roles

| Permission | Lets someone | Least built-in role with it |
|---|---|---|
| Prepare returns (`personaltax.prepare`) | Change the household, and later add and confirm documents and download forms. Includes viewing. | Editor |
| View returns (`personaltax.view`) | See the household, its documents and every number, read only. | Viewer |

A custom role only takes permissions away from its base role; it never adds one.

## AI agents and API clients

An AI agent connected over MCP acts as its person, with their current role. An API client has the role an owner or
admin gave it. Both see the same API as the browser, under the same rules: `GET /api/catalog` lists only what the caller
may use. See [Personal Tax API](/docs/personal-tax/api).

## Organizations

Each organization has one household. One organization never sees another's people or tax years.
