---
title: Sending envelopes
description: Send a template to one signer per role, set a sign-by day, follow statuses, void an envelope and let due work finish the rest.
order: 4
---

An envelope is a template sent to named signers, one for each role, who sign in order. This page covers sending one step
by step, what each field does, the statuses an envelope and its signers go through, voiding, declines, deadlines, due
work and contacts. It is for people who send and for AI agents acting for them.

## Before you send

- You need a template. See [Templates and fields](/docs/esign/templates).
- Your role needs **Send and manage envelopes** (owners, admins and editors have it). See
  [Roles and access](/docs/esign/roles-and-access).
- Signing needs to be set up on the deployment. If it isn't, the **Envelopes** page says so; you can still send, but
  nobody can sign.

## Send an envelope

1. On **Envelopes**, choose **New envelope**. Or, on **Templates**, choose **Send** next to a template.
2. Under **Template**, choose the template.
3. Under **Signers**, fill in one block for each role, numbered in signing order (for example **1. partner**,
   **2. seller**). **Name** and **Email** are required. As you type two or more characters in either, matching
   [contacts](#contacts) are suggested; choose one (or use the arrow keys and Enter) to fill in the signer. Or choose
   **Choose** *the role* **from contacts**, search, and choose the person.
4. Under **Document**, add what signers should see about the document, and a sign-by day if there is one. All optional.
5. Choose **Send for signature**.

The envelope's page opens. It is **Out for signature**, and the first signer is **Asked to sign**.

![The New envelope form with two signers](/docs/assets/screenshots/esign-new-envelope.png "New envelope: one signer for each role, in signing order")

If sending fails, for example because the connection drops, choose **Send for signature** again. The retry carries the
same request key, so the envelope is never sent twice.

### Signer fields

| Field | What it does |
| --- | --- |
| **Name** | The signer's name, shown on their signing page and recorded with the signature. It must use characters the signature page's font (Helvetica) can draw, and fit at its size; otherwise sending is refused. |
| **Email** | Where their verification code and, at the end, the link to their signed copy are sent. Only someone who can read this mailbox can sign. It can't be changed after sending. |
| **Title (optional)** | Shown on the signing page and recorded with the signature. |
| **Signs for company (optional)** | The company they sign for. The signer must then give their title and confirm "I'm authorized to sign for" that company. |
| **How they get the signing page** | **Esign emails them an invitation when it is their turn** (the default here), or **You open it for them, from the envelope's page**, for someone who signs in person. |
| **Email subject** and **Message to** *the signer* (optional) | Their own message, shown when **Write a different message to each signer** is chosen (below). |

### Document fields

| Field | What it does |
| --- | --- |
| **Document name** | Shown to signers, and named in the statement they agree to when they sign. Without one, signers see "the document". |
| **Version** and **Published (YYYY-MM-DD)** | Which version of the document this is, and when it was published. |
| **Sender name** and **Sender company** | Who sent it, shown on the signing page. |
| **Sign by (optional)** | If a signer hasn't signed by the end of this day (in your time zone), the envelope expires and nobody can sign it. Up to 400 days ahead. |
| **Email subject** and **Message to the signers** (optional) | Your message, shown on the signing page next to the document, and the subject and text of the invitations Esign emails. Without a subject, an invitation's is "Please sign:" and the document's name. Choose **Write a different message to each signer** to give each their own instead. |

## Signing order

Signers sign one at a time, in the template's role order. Only the signer whose turn it is can open the signing page.
When they have signed, their signature is drawn into the PDF, and the next signer signs that result. So every signer signs
exactly what the signer before them produced.

When it is someone's turn, they open the signing page from the invitation Esign emails them, in your host product, or
from the envelope's page, where someone who manages chooses **Open** *name*'s **signing page** for them. An invited
signer whose email went astray can be sent a new one with **Send the invitation again**, which replaces the earlier
link. See [Signing](/docs/esign/signing).

## Follow an envelope

The envelope's page shows:

- the status, the envelope id and when it was created;
- **Signers**: each one's order, name and email, role and status, when they were invited, when they opened the signing page and their deadline;
- **Audit trail**: every event with its time, the signer and the IP address.

The page refreshes by itself every few seconds while the envelope is out for signature or finishing. The **Envelopes**
page lists every envelope, newest first; filter it with **Status**, or choose a status's view in the navigation's second
column (**Out for signature**, **Completed** and so on), which is the same filter at its own address, such as
`/envelopes?status=completed`.

![An envelope's page with its signers and audit trail](/docs/assets/screenshots/esign-envelope.png "An envelope out for signature: signers in order and the audit trail")

## Statuses

### Envelope statuses

| Status | API value | What it means |
| --- | --- | --- |
| **Out for signature** | `IN_PROGRESS` | Signers are signing in turn. The only status in which anyone can sign, decline or void. |
| **Finishing** | `FINALIZING` | Everyone has signed, and Esign is sealing the signed PDF. This usually takes seconds. |
| **Completed** | `COMPLETED` | Sealed. The signed PDF and the certificate can be downloaded, and each signer is sent a link to their copy. |
| **Voided** | `VOIDED` | Someone who manages envelopes withdrew it before everyone had signed. |
| **Declined** | `DECLINED` | The signer whose turn it was declined to sign, with a reason. |
| **Expired** | `EXPIRED` | A signer's sign-by deadline passed before they signed. |

### Signer statuses

| Status | API value | What it means |
| --- | --- | --- |
| **Waiting for an earlier signer** | `PENDING` | Someone before them hasn't signed yet. |
| **Asked to sign** | `ACTIVE` | It is their turn. The page also shows when they opened the signing page, and their deadline if there is one. |
| **Signed** | `SIGNED` | Their signature is recorded. |

When an envelope ends early (voided, declined or expired), signers who hadn't signed keep the status they had; the
envelope's status says why it ended, and the audit trail says who, when and, for a void or a decline, the reason.

## Void an envelope

To withdraw an envelope that is out for signature:

1. On the envelope's page, choose **Void envelope**.
2. Optionally, give a **Reason (optional, kept in the audit trail)**, up to 500 characters.
3. Choose **Void envelope** again to confirm, or **Keep it** to go back.

Signers who haven't signed can no longer open, verify or sign it. Voiding can't be undone; to try again, send a new
envelope. An envelope that is finishing, completed, declined or expired can't be voided.

## Declines

A signer who doesn't want to sign chooses **Decline to sign** on the signing page and gives a reason. They confirm it is
them with the emailed code first. The envelope then ends for everyone: its status becomes **Declined**, nobody can sign
it any more, and the audit trail records who declined, why and when. A host product that embeds the signing page is told
the signer declined.

## Sign-by deadlines

A sign-by day applies to every signer of the envelope. If a signer who hasn't signed passes it, the envelope expires. A
signer who has already signed is past their deadline's reach. Esign applies an expiry when someone next opens the
envelope, and when due work runs. Through the API, each signer can have a deadline of their own (`expiresAt`).

## Due work

Esign usually finishes an envelope right after its last signature, without making the signer wait. If that can't
happen, for example after a time limit or an outage, the envelope stays **Finishing** until due work runs.

Due work:

- expires envelopes past a deadline;
- finishes envelopes left half done (a signature not yet drawn, or an envelope not yet sealed);
- retries the signed-copy emails that didn't go out.

**The platform runs it every five minutes for every organization**, so there is nothing to schedule. To run it at once
for your organization:

- choose **Process due work** on **Envelopes** (it says what it did, for example "Due work done: 1 completed." or
  "Nothing was due."); or
- call `POST /api/process-due` with an OAuth client or an AI agent whose role can send and manage envelopes.

One run looks at up to 25 envelopes to finish and 25 owing signed copies, so a backlog takes several runs.

## Contacts

**Contacts** is your organization's address book. Everyone an envelope names as a signer is added, or refreshed with the
name, title and company you gave this time, and listed most recently used first, with how many envelopes named them.
Search it by name or email.

- To add someone before you send to them, choose **Add contact**. Adding an email that is already there changes that
  contact.
- To change or delete a contact, open them. Their page also lists the envelopes that name them. Deleting asks you to
  confirm; the next envelope you send them adds them again.
- When you send, a contact suggested under **Name** or **Email** as you type, or chosen with **Choose** *the role*
  **from contacts**, fills in the signer's name, email, title and company.

A contact only fills in the form. An envelope keeps the name and email it was sent with: changing or deleting a contact
changes no envelope. Everyone in your organization who can see envelopes sees the contacts; those who send can change them.

## Send from another system

A host product, or an AI agent someone connects, sends with `POST /api/envelopes` and an `Idempotency-Key` header, a
fresh random value for each new envelope. A retry with the same key and the same request returns the same envelope; the
same key with a different request is refused with `409 idempotency_conflict`. See [API](/docs/esign/api) for the request
and an example.
