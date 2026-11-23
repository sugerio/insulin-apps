---
title: Roles and sharing
description: The three kinds of roles in Knowledge, what each collection role can do, sharing like a shared document, keep it ready, and what happens when people leave.
order: 6
---

This page explains who can open and change a collection, how collections are shared, and what happens when people
leave or change role. It is for organization owners and admins deciding what access to give, for collection owners,
and for AI agents working out what their connection allows.

## The three kinds of roles

| Kind | Values | Set where | What it decides in Knowledge |
|---|---|---|---|
| Organization role | Owner, Admin, Editor, Viewer, or specific apps | Settings › People, on insulin-apps.com | Organization owners see every collection's basic information (owner, created, last used, size and how it is shared) and can delete any collection, one at a time. Without a collection role they can't open, ask, export or change it. The organization role also sets the role in Knowledge. |
| Role in Knowledge | Admin, Editor, Viewer, or a custom role | From the organization role (owners and admins are Admins here), or given for Knowledge only | Admins and Editors start collections; Viewers can't. Admins also see Rules and data and Health. Being an Admin gives no access to any collection's content. |
| Collection role | Owner, Admin, Editor, Viewer | Each collection's Sharing | Everything inside one collection. Nobody gets into a collection without one. |

See [Organizations and roles](/docs/platform/organizations-and-roles) for the platform's side.

## Collection roles

| In a collection | Owner | Admin | Editor | Viewer |
|---|---|---|---|---|
| Ask, open sources, see what it knows and its history, report a wrong answer | ✓ | ✓ | ✓ | ✓ |
| Add files, web pages and notes, fix answers and facts, stop using a file, go back | ✓ | ✓ | ✓ | |
| Remove a file for good | ✓ | ✓ | | |
| Share it; change its settings; export it | ✓ | ✓ | | |
| Transfer ownership; delete it | ✓ | | | |

- **The highest role wins.** Someone shared with through everyone in the organization and by name gets the higher of
  the two.
- **The Viewer cap.** A Viewer in Knowledge, or a custom role without "Change content", can only ever read: whatever
  role a collection gives them, they act as a Viewer. The sharing list says "acts as Viewer" next to their name.
- **Custom roles narrow.** Knowledge's permissions are Ask and read, Start collections, Change content, Share
  collections, Export collections and Rules and data. A custom role without "Share collections" can't share or remove
  files for good, and one without "Export collections" can't export, even as a collection Admin.

## Share a collection

On a collection's **Sharing** tab, its owner and admins share it like a shared document:

- **Share** with a person who can use Knowledge, as a Viewer, Editor or Admin. They get an e-mail with a link. Admin is
  given only to people by name.
- **General access** gives everyone in the organization who can use Knowledge one role, Viewer or Editor, or no access.
  It adds to the roles given by name.
- A collection admin can change anyone's role except the owner's.

Sharing isn't part of a collection's content: going back to an earlier restore point never changes who has access.
Sharing, settings, export, transfer and delete can only be done on the site, by a person, never by an AI assistant or
an API client.

![A collection's Sharing tab: the owner, an Editor and a Viewer shared with by name, general access Viewer for everyone in the organization, then the collection's settings with the switch for AI assistants and API clients and keep it ready, Export, and the owner's Transfer and Delete](/docs/assets/screenshots/knowledge-sharing.png "The Sharing tab: people, general access, settings, export, transfer and delete")

## AI assistants and API clients

**AI assistants and API clients can ask it** is one switch per collection, on by default. Off, neither can reach the
collection. An AI assistant acts as its person, with that person's collection roles and no more. An API client reaches
a collection only when it is shared with that client by name, never through general access. See
[AI assistants and the API](/docs/knowledge/ai-assistants-and-api).

## Keep it ready

A collection sleeps 10 minutes after the last question, and the next question wakes it in about a minute. Its owner or
admins can **keep it ready** during a daily window instead, so answers then take a few seconds: pick the days, the start
time and up to 3 hours a day. The window follows the organization's time zone, which an Admin sets in Rules and data.

- Kept-ready time counts against the organization's awake hours, and keep-ready pauses at 90% of them; it starts again
  on the 1st.
- The organization can keep a limited number of collections ready at once: 1 by default.
- An owner of the organization can turn keep-ready off on any collection, even without a role in it.

## Transfer and delete

- **Transfer ownership** (the owner): to someone who is an Admin or Editor in Knowledge. The new owner gets an e-mail,
  and the old owner stays as a collection Admin.
- **Delete…** (the owner, or an owner of the organization): after typing the collection's name. Its files, notes, facts
  and backups are removed; saved restore points can't be opened afterwards and expire within 30 days.

Organization owners see "Other collections" in their organization on the Collections page: the name, owner, created,
last used, documents, size and how each is shared, but never what is in it. They can delete one at a time after typing
its name, and its owner gets an e-mail. Organization admins don't see this list.

## People who leave and return

- **Leaving.** Someone removed from the organization, or from Knowledge, loses access at once. Their shares are kept on
  hold.
- **Returning.** If they are invited again, the shares on hold come back, with a "Welcome back" e-mail.
- **An owner leaves.** When a collection's owner leaves, or can only read from then on (a Viewer in Knowledge, or a
  custom role without "Change content"), the longest-standing owner of the organization becomes its owner and gets an
  e-mail. An owner who can only read keeps Viewer access.
- **An owner returns.** A former owner who comes back gets their other shares back, but not ownership; the new owner
  can transfer it back.
- **Checking who is still here.** If Knowledge has missed news of people leaving for a long time (more than 90 days), or
  starts for the first time, it checks everyone it knows with insulin-apps.com. Until someone is checked, which takes a
  moment, they count as away (Sharing says "checking"). Someone using Knowledge meanwhile is checked by using it:
  insulin-apps.com says who they are with every request. Each check also moves collections whose owner can now only
  read to the longest-standing owner of the organization.
