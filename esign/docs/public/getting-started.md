---
title: Getting started with Esign
description: Open Esign, upload your first template, send an envelope and follow it to a signed PDF with its certificate.
order: 2
---

This page takes you from an empty Esign to your first completed envelope. It is for the person in your organization
who sends documents for signature. Use a synthetic PDF and test addresses: Esign is experimental.

## Before you start

- **An account and an organization.** Sign up at `https://insulinapps.com`, create an organization or accept an
  invitation to one. See [Getting started with Insulin Apps](/docs/platform/getting-started).
- **A role that can send.** Organization owners, admins and editors can send and manage envelopes. Someone with access
  to specific apps needs Esign's Admin or Editor role, or a custom role with **Send and manage envelopes**. Viewers can
  follow along but not send. See [Roles and access](/docs/esign/roles-and-access).
- **Signing set up on the deployment.** If it isn't, the **Envelopes** page says "Signing isn't set up on this deployment
  yet". You can still upload templates and send envelopes, but nobody can sign until whoever runs Esign adds its
  settings.

Open Esign at `https://esign.insulinapps.com`, or from your organization's apps on the Insulin Apps home page. The
navigation on the left shows your organization at the top and your name and role at the bottom; see
[The navigation](/docs/esign/overview#the-navigation).

## 1. Upload a template

A template is a PDF and the roles that sign it, in signing order.

1. Open **Templates**.
2. Under **New template**, choose the **PDF** (up to 5 MB and 100 pages).
3. Under **Signer roles, in signing order**, name each role, such as `partner` and `seller`. Use letters, digits, `-` and
   `_`, with no spaces. Choose **Add a role** for another one.
4. Choose **Upload with a signature page** for the quickest start. Signers then sign on a page Esign adds after the
   document's last page.

Or choose **Upload and place fields** to put each role's signature, title and date exactly where they belong. See
[Templates and fields](/docs/esign/templates).

![The Templates page with the New template form and one template](/docs/assets/screenshots/esign-templates.png "Templates: upload a PDF with its roles, then send it")

## 2. Send an envelope

1. On **Templates**, choose **Send** next to your template, or open **Envelopes** and choose **New envelope**.
2. Under **Template**, choose the template if it isn't chosen already.
3. Under **Signers**, give a **Name** and an **Email** for each role. They sign in this order.
4. Optionally, under **Document**, give a **Document name**, a **Version**, the **Sender name** and **Sender company**,
   and a **Sign by (optional)** day.
5. Choose **Send for signature**.

The envelope's page opens. Its status is **Out for signature**, and the first signer is **Asked to sign**. See
[Sending envelopes](/docs/esign/sending-envelopes) for every field.

## 3. Have each signer sign

The signer whose turn it is opens the signing page in one of three ways:

- **From the invitation Esign emails them** when their turn comes, unless you chose to open the page for them.
- **In your host product**, the system your organization uses Esign from, which shows the signing page inside its own
  pages.
- **From the envelope's page**: choose **Open** *name*'s **signing page** next to the active signer (for example
  **Open Avery Patel's signing page**). Use this when the signer is with you, or to try Esign out.

The signer reviews the document, enters the 6-digit code Esign emails them, types their name to adopt their signature,
agrees to sign electronically and chooses **Sign document**. Then the next signer's turn starts. See
[Signing](/docs/esign/signing).

## 4. Follow the envelope and keep the result

The envelope's page updates by itself while the envelope is out for signature: each signer's status, when they opened
the signing page, and every event in the **Audit trail**.

When the last signer has signed, the envelope shows **Finishing** for a few seconds while Esign seals it, then
**Completed**. Then:

- choose **Signed PDF with certificate** to download the signed document followed by its certificate of completion;
- choose **Certificate of completion** to see the seal, checked against the stored files, with the signers and the audit
  trail;
- each signer gets an email with a link to download their own copy, once, within 30 days.

![A completed envelope with its download buttons](/docs/assets/screenshots/esign-completed.png "A completed envelope: the signed PDF with its certificate, and the certificate of completion")

## If your role only views

With a role that only views, you see the same pages: every envelope with its status, signers and audit trail, the
templates, and the signed PDF and certificate of a completed envelope. You can't upload templates, send, void or open a
signing page; those buttons aren't shown, and Esign refuses them on the server however they are asked.

If there are no templates or envelopes yet, the pages say so. Nothing is missing: nobody has sent anything yet.

## Next steps

- Place signature, title and date fields: [Templates and fields](/docs/esign/templates).
- Deadlines, voiding and statuses: [Sending envelopes](/docs/esign/sending-envelopes).
- Connect a host product or an AI agent: [API](/docs/esign/api).
