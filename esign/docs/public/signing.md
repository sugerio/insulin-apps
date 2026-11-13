---
title: Signing
description: What a signer sees and does on Esign's signing page, from the one-time link and the emailed code to signing, declining and their copy.
order: 5
---

This page describes the signing page from the signer's side, step by step. It is for people who send envelopes and want
to know what their signers go through, for host products that embed the page, and for signers themselves. Signers don't
need an account.

## Opening the signing page

When it is a signer's turn, they open the signing page in one of three ways:

- **From an invitation.** When Esign invites the signer (always, for envelopes sent from Esign's own pages), Esign emails them when their turn comes,
  with a link to the signing page and the sender's message. The link works while it is their turn; when the sender
  sends the invitation again, only the newest link works.
- **In a host product.** The system your organization uses Esign from shows the signing page inside its own pages, to
  the signer it has signed in, whose account must have the signer's email. Esign emails such a signer no invitation.

Each way, the page is opened with a one-time link that works once, within two minutes, and only for that signer. The
page then stays usable for 15 minutes; after that, the signer opens it again the same way. A signer whose turn hasn't come
yet, or whose envelope has ended, can't open it.

The page is titled **Sign document** and shows the three steps at the top: **Review**, **Confirm it's you** and **Sign**.
**About signing**, in its top corner, explains the steps in plain words.

## Step 1: Review

The signer reads the document. The page shows every page of the PDF and, beside it:

- **Message from** *the sender*: the sender's message to them, when there is one;
- **Document**: its name, version, number of pages and **Fingerprint (SHA-256)**, which identifies exactly this file;
- **Signing as**: the signer's name and email;
- their **Title**, which they can correct, when the sender gave one, the document has a Title field, or they sign for a
  company;
- when they sign for a company, a box to confirm "I'm authorized to sign for" that company;
- **Viewed** *n* **of** *n* **pages**: Esign records each page the signer has looked at (at least half on screen for a
  second).

**Download PDF** saves a copy of the document. The signer chooses **Continue** when ready, or **Decline to sign** (see
below).

## Step 2: Confirm it's you

Esign emails a 6-digit code to the signer's address. The page says "Enter the 6-digit code we sent to" that address, with
a countdown.

- The code works for 10 minutes and only once.
- **Resend code** becomes available after a minute. Each signer can have up to 3 codes sent and 5 tries in 15 minutes,
  whichever window they open the page in.
- Only the window the code was sent for can use it. A newer code sent in another window replaces it.

The signer types the code and chooses **Verify code**. The page then says "Your email address is confirmed."

When a host product told Esign how it signed the signer in (for example through single sign-on), the page also shows
that sign-in, and the audit trail records it as the host's statement. **Why we ask** explains that the code and the
sign-in are recorded in the audit trail, with the time, the IP address and the browser.

![The signing page asking for the emailed code](/docs/assets/screenshots/esign-signing-code.png "Confirm it's you: the 6-digit code emailed to the signer")

## Step 3: Sign

Under **Adopt your signature**, the signer:

1. types their **Full name**, in English letters with single spaces, up to 64 characters;
2. checks the **Preview**, which shows how the signature will look in each place it goes, drawn by the server;
3. gives their **Title**, when it is asked for (as on the first step);
4. reads the electronic records disclosure (**Read the electronic records disclosure**);
5. ticks the consent box, which says: "I agree to use electronic records and signatures, and I intend this to be my
   signature on" the document (and "on behalf of" the company, when there is one);
6. chooses **Sign document**.

The side panel repeats the document's details and shows **After you sign**: what happens next, including any lines the
sender added.

The page says "Signature recorded." and the next signer's turn starts. A host product that embeds the page is told the
signer signed.

![The signing page with the signature preview and the consent box](/docs/assets/screenshots/esign-signing-review.png "Sign: adopt the signature, check the preview, agree and sign")

### What the signer agrees to

The electronic records disclosure says that the signer signs electronically, with the same effect as a handwritten
signature, and consents to receive the document and the records of the signing electronically. It explains that they may
ask the sender for a paper copy, or withdraw consent, by contacting the sender before they sign (withdrawing ends the
electronic signing, at no charge), that they receive the signed document and its certificate after everyone has signed
(Esign emails a link to download it), and that they need a current web browser, a PDF reader and access to their email.

Signing records which version of the disclosure the signer agreed to. Its wording is a draft that still needs review by
counsel; Esign is experimental.

### Placed fields

When the template has placed fields, the preview shows each of the signer's fields:

- **Signature**: their typed name, drawn in a handwriting style. If it doesn't fit without overlapping another field, the
  page says so; shorten the name or ask the sender to move the field.
- **Title**: their typed title, which must fit its box.
- **Date signed**: today's date in UTC, filled in by Esign. If the date changes between the preview and signing (after
  midnight UTC), the page asks the signer to review and sign again.

Without placed fields, the signer signs on the page Esign adds after the document, with their name and the signing time.

## Declining

A signer who doesn't want to sign chooses **Decline to sign** on the first step:

1. Under **Why are you declining?**, they give a reason (up to 1,000 characters).
2. They choose **Decline**, or **Keep the document** to go back.
3. If they haven't confirmed the code yet, the page asks them to first.

The envelope then ends for everyone: its status becomes **Declined**, nobody can sign it, and the audit trail records who
declined, why and when. The page says "You declined to sign. The sender has been told." (an embedding host product
receives a message saying the signer declined).

## After everyone has signed

Esign seals the signed PDF and emails every signer a link to their copy. The link opens the **Your signed document**
page, where **Download my copy** prepares the signed document followed by its certificate of completion, and **Save the
PDF** saves it.

- The link works once, within 30 days. After that the page says "This link has already been used or has expired. Ask the
  sender for a copy."
- Your organization can download the signed PDF and certificate from the envelope's page for as long as the envelope
  exists.

## What gets recorded

Each step goes into the envelope's audit trail with its time, the signer's IP address and their browser: the signing link
issued, the page opened, each code sent, the code verified, the document fetched, the pages viewed, the signature or the
decline, completion, and each signed copy sent and downloaded. Codes themselves are never recorded. See
[How it works](/docs/esign/how-it-works).

## Embedding the signing page

A host product embeds `https://esign.insulinapps.com/sign#code=...`, with a code its backend gets from
`POST /api/envelopes/{id}/tasks/{taskId}/recipient-view`. See [API](/docs/esign/api#embed-the-signing-page).

- The page works only inside the origins the deployment allows to embed it, and refuses to open in a frame it can't
  identify.
- Add `&host=` followed by the host's origin to the fragment to receive the page's messages: `esign.signing.finished`
  with the outcome `signed` or `declined`, and `esign.signing.cancel` when the signer chooses **Cancel**. The messages
  carry no token, address or signing data.
- The page renders the PDF itself (to images, not with the browser's PDF viewer), so it works inside a sandboxed frame.
  It offers signing only after every page has rendered; if one fails, it offers **Retry document**. The rendered pages
  have no selectable text, and are not an accessible reader.
