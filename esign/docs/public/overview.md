---
title: E-sign overview
description: What E-sign does, who it is for, its pages, and how it runs on Insulin Apps. Experimental, for synthetic documents only.
order: 1
---

E-sign sends PDFs for electronic signature. This page is for anyone deciding whether to use it, and for AI agents that need
a map of the app before they act on it.

> [!WARNING]
> **E-sign is experimental.** Use synthetic documents and test email addresses only. The consent wording, the
> certificate of completion and the timestamp service still need legal and operational review before real documents
> are signed.

## What E-sign does

Someone in your organization uploads a PDF as a **template** and names the roles that sign it, in order. They send the
template as an **envelope**, naming one signer for each role. Each signer, in turn, opens the signing page. E-sign:

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

Members open E-sign at `https://esign.insulinapps.com`. Its navigation has three entries:

| Page | What it shows |
| --- | --- |
| **Envelopes** | Every envelope in your organization, newest first, with its status. Open one to see its signers, its audit trail and, once completed, the signed PDF and the certificate. Those who manage also find **New envelope** and **Process due work** here. |
| **Templates** | The PDFs your organization sends, with their signer roles and placed fields. Those who manage upload new ones here. |
| **Docs** | The built-in help: getting started, the main tasks, what signers see, statuses, evidence, roles, background on electronic signatures and a glossary. Every role can open it. |

Signers see only the public pages: the signing page (`/sign`), the page that downloads their signed copy (`/copy`) and,
for host products, the embedded field editor (`/editor/page/...`).

## How it runs on Insulin Apps

E-sign is an open-source Insulin app. On insulinapps.com it runs at `https://esign.insulinapps.com`, behind the platform:

- **Sign-in is the platform's.** You sign in at `https://insulinapps.com` with email and password, Google or your
  company's single sign-on. E-sign has no sign-in screens of its own. See
  [Sign-in and security](/docs/platform/sign-in-and-security).
- **Your role comes from your organization.** Owners, admins and editors send and manage envelopes; viewers see them.
  See [Roles and access](/docs/esign/roles-and-access).
- **One organization at a time.** Everything you see in E-sign belongs to your active organization. Switch organization
  in the top bar to see another one's templates and envelopes.
- **Due work runs every five minutes.** The platform calls E-sign every five minutes so it can expire envelopes past
  their deadline, finish envelopes a request left unfinished and retry signed-copy emails, for every organization.
- **Mail goes through the platform.** E-sign has no mail service of its own. It sends a signer two kinds of email only:
  their verification code and, at the end, the link to their signed copy. It doesn't email signers an invitation to
  sign.
- **Signing must be set up.** A published E-sign signs nothing until its code pepper, the mail relay and its AWS KMS key
  are configured. Until then, the **Envelopes** page says that signing isn't set up on the deployment.

![An envelope's page in E-sign, with its signers and audit trail](/docs/assets/screenshots/esign-envelope.png "One envelope: its signers in order, where each stands, and the audit trail")

## What E-sign doesn't do

- It doesn't email signers an invitation to sign. The signer opens the signing page in your host product, or someone who
  manages opens it for them from the envelope's page.
- It doesn't check what kind of document is sent. Whoever sends decides whether an electronic signature fits it.
- It doesn't verify identity documents. The emailed code shows control of the signer's mailbox at the time, and a host
  product can tell E-sign how it signed the signer in, which E-sign records as the host's statement.
- It doesn't make advanced or qualified electronic signatures (in the EU's eIDAS terms), and the signed PDF carries no
  embedded PDF signature.

## Where to go next

- [Getting started](/docs/esign/getting-started): your first template and envelope.
- [Templates and fields](/docs/esign/templates) and [Sending envelopes](/docs/esign/sending-envelopes).
- [Signing](/docs/esign/signing): what a signer sees.
- [API](/docs/esign/api): for host products, OAuth clients and AI agents.
- [How it works](/docs/esign/how-it-works): evidence, seals and certificates.
