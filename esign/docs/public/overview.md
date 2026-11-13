---
title: Esign overview
description: What Esign does, who it is for, its pages, and how it runs on Insulin Apps. Experimental, for synthetic documents only.
order: 1
---

Esign sends PDFs for electronic signature. This page is for anyone deciding whether to use it, and for AI agents that need
a map of the app before they act on it.

> [!WARNING]
> **Esign is experimental.** Use synthetic documents and test email addresses only. The consent wording, the
> certificate of completion and the timestamp service still need legal and operational review before real documents
> are signed.

## What Esign does

Someone in your organization uploads a PDF as a **template** and names the roles that sign it, in order. They send the
template as an **envelope**, naming one signer for each role. Each signer, in turn, opens the signing page. Esign:

1. emails the signer a 6-digit code to confirm it is them;
2. shows them the document, with its fingerprint (a SHA-256 hash that identifies exactly this file);
3. records their consent to sign electronically and their signature;
4. once everyone has signed, seals the signed PDF and emails each signer a link to download their copy, followed by a
   certificate of completion.

Every step is written to the envelope's **audit trail**, which nobody can change. Each signature is linked to the one
before it and to the PDF it was made on, so a later change to any step shows.

## Who it is for

- **People who send documents for signature**: they upload templates, send envelopes and follow them.
- **People who only need to see what was signed**: they read envelopes, audit trails and certificates.
- **Host products**: another system your organization uses can send envelopes through the API with an OAuth client,
  show the signing page and the field editor inside its own pages, and follow each envelope's status.
- **AI agents**: an assistant connected over MCP can list templates and envelopes, send envelopes and read their status,
  with the role of the person who connected it.

Signers don't need an account and don't need to belong to your organization. Their one-time link and the code emailed
to them give access to their own turn, and nothing else.

## The pages

Members open Esign at `https://esign.insulinapps.com`. Its navigation has four entries:

| Page | What it shows |
| --- | --- |
| **Envelopes** | The envelopes you own or that are shared with you, newest first, with where each stands, searched and filtered by date, status, sender and quick views. Open one to see its signers, its audit trail and, once completed, the signed PDF and the certificate. Those who manage also find **New envelope** and **Process due work** here. |
| **Templates** | The PDFs your organization sends, with their signer roles and placed fields. Those who manage upload new ones here. |
| **Docs** | The built-in help: getting started, the main tasks, what signers see, statuses, evidence, roles, background on electronic signatures and a glossary. Every role can open it. |
| **Settings** | Esign's **People**, **Integrations**, **API access** and **Connect AI** pages, which are the platform's pages on `https://insulinapps.com/apps/esign/settings/` (see [Roles and access](/docs/esign/roles-and-access#people-and-integrations-live-on-the-platform)). |

Signers see only the public pages, which have no navigation: the signing page (`/sign`), the page that downloads their
signed copy (`/copy`) and, for host products, the embedded field editor (`/editor/page/...`).

## The navigation

The navigation on the left has two columns, as in every Insulin app. The first column has the organization switcher at
the top (your organization's name; choose it to switch to another of your organizations, go to **All apps** or create one), then
**Envelopes** and **Templates** under the heading Esign, then **Docs** and **Settings**, and at the bottom your name and
role, with your Insulin Apps **Account** and **Sign out**. The second column lists what the open section holds:

| Section | Second column |
| --- | --- |
| **Docs** | The topics, under Using Esign and Electronic signatures, then **Public docs**, a link to these pages. |
| **Settings** | **People**, **Integrations**, **API access** and **Connect AI**, links to the platform's pages (in the console's preview, listed without links). |
| **Envelopes**, **Templates**, **Contacts**, **Ownership** | None: each page has its own search, filters and buttons. |

The bar above the page shows where you are, such as Envelopes › Envelope; the section's name goes back to it.

Each column has its own button that collapses it to icons, whose names show when you point at them. The choice is kept
in this browser (`localStorage`, key `insulin-nav`). Below 768 pixels wide, a top bar holds the organization switcher and
a menu button that opens both columns.

Esign declares its sections in its `package.json` under `insulin.navigation`. The platform reads the same list, so
Esign's Settings pages on insulinapps.com show the same first column.

## How it runs on Insulin Apps

Esign is an open-source Insulin app. On insulinapps.com it runs at `https://esign.insulinapps.com`, behind the platform:

- **Sign-in is the platform's.** You sign in at `https://insulinapps.com` with email and password, Google or your
  company's single sign-on. Esign has no sign-in screens of its own. See
  [Sign-in and security](/docs/platform/sign-in-and-security).
- **Your role comes from your organization.** Owners, admins and editors send and manage envelopes; viewers see them.
  See [Roles and access](/docs/esign/roles-and-access).
- **One organization at a time.** Everything you see in Esign belongs to your active organization. Switch organization
  in the top bar to see another one's templates and envelopes.
- **Due work runs every five minutes.** The platform calls Esign every five minutes so it can expire envelopes past
  their deadline, finish envelopes a request left unfinished and retry signed-copy emails, for every organization.
- **Mail goes through the platform.** Esign has no mail service of its own. It emails a signer their invitation, when the sender
  chose that Esign invites them, their verification code and, at the end, the link to their signed copy.
- **Signing must be set up.** A published Esign signs nothing until its code pepper, the mail relay and its seal key
  are configured. Until then, the **Envelopes** page says that signing isn't set up on the deployment.

![An envelope's page in Esign, with its signers and audit trail](/docs/assets/screenshots/esign-envelope.png "One envelope: its signers in order, where each stands, and the audit trail")

## What Esign doesn't do

- It doesn't check what kind of document is sent. Whoever sends decides whether an electronic signature fits it.
- It doesn't verify identity documents. The emailed code shows control of the signer's mailbox at the time, and a host
  product can tell Esign how it signed the signer in, which Esign records as the host's statement.
- It doesn't make advanced or qualified electronic signatures (in the EU's eIDAS terms), and the signed PDF carries no
  embedded PDF signature.

## Where to go next

- [Getting started](/docs/esign/getting-started): your first template and envelope.
- [Templates and fields](/docs/esign/templates) and [Sending envelopes](/docs/esign/sending-envelopes).
- [Signing](/docs/esign/signing): what a signer sees.
- [API](/docs/esign/api): for host products, OAuth clients and AI agents.
- [How it works](/docs/esign/how-it-works): evidence, seals and certificates.
