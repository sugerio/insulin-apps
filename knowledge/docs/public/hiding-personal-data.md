---
title: Hiding personal data
description: What Knowledge removes from every file before reading it, so no answer can show it, and how Admins choose and try the hiding rules.
order: 9
---

This page explains what Knowledge hides before it learns anything, where people see it, and how Admins change and try
the rules. It is for Admins deciding what may be learned, and for anyone wondering why a source says "[hidden]".

## What is hidden

Before Insulin reads a file, a web page or a note, it hides sensitive values in it. A hidden value is removed before
anything is learned or kept, so no answer, source, fact or export can show it. Where it was, the text says `[hidden]`.

Knowledge hides:

- e-mail addresses;
- phone numbers;
- card numbers;
- API keys and access tokens in common formats;
- values labelled as passwords or secrets, such as "password: …".

Every rule is on for a new organization. If hiding fails for any reason, the file isn't learned: nothing is kept
rather than something unhidden.

## Where people see it

- In a source, a hidden value shows as hidden, in place.
- **Needs attention** lists recent files where values were hidden before learning, and how many of each kind, for the
  collection's owner, admins and editors.
- Original files aren't kept after they are read: only the text with its hidden values removed.

## Choose and try the rules

Admins in Knowledge choose which kinds of values are hidden, under **Hide before learning** in **Rules and data**. The
rules apply to every collection in the organization.

**Try it** shows what the rules would hide in a text you paste, before anything changes. It uses the same rules
Insulin applies to files (`POST /api/rules/hiding-preview` does the same through the API).

A new or stricter rule also re-reads the files learned before, in the background, which counts as learning. Earlier
restore points that still hold the newly hidden text can't be brought back.
