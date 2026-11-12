---
title: Templates and fields
description: Upload a PDF with the roles that sign it, signed on an added page or in signature, title and date fields you place in the editor.
order: 3
---

A template is the document your organization sends for signature, with the roles that sign it. This page explains how to
upload one, how to place fields on its pages, and how a host product embeds the field editor. It is for people who send,
and for developers of host products.

## What a template is

A template is a PDF and its **roles**, in signing order. A role is a name for a part in the document, such as `partner`
or `seller`. When you send an envelope, you name one person for each role, and they sign in the template's order.

| Rule | Limit |
| --- | --- |
| PDF size | Up to 5 MB |
| Pages | 1 to 100 |
| Roles | 1 to 20, each different |
| Role names | Letters, digits, `-` and `_`, no spaces, up to 64 characters |

The PDF must be a valid PDF; a file Esign can't read is refused. Use synthetic documents until your organization has
reviewed Esign for real ones.

## A signature page, or placed fields

A template is signed in one of two ways:

- **On an added signature page.** Esign appends a page after the document's last page. Each signer gets a block on it
  with their name and the time they signed, eight blocks to a page. This works with any PDF.
- **In placed fields.** You put each role's **Signature**, and optionally **Title** and **Date signed**, exactly where
  they belong on the document's pages.

## Upload a template

You need a role that sends and manages envelopes.

1. Open **Templates**.
2. Under **New template**, choose the **PDF**.
3. Under **Signer roles, in signing order**, name each role. Choose **Add a role** for more (up to 20), or the bin icon to
   remove one. Next to a role you can give its [default signer](#default-signers): a **Signer name**, a **Signer email**,
   or both. Both are optional; matching contacts are suggested as you type.
4. Choose one of:
   - **Upload with a signature page**: the template is saved at once. The page says "Template uploaded. Signers sign it
     on a page added after its last page."
   - **Upload and place fields**: the field editor opens on the PDF. See below.

The new template appears in the list with its id, its roles, what it is **Signed on** ("A signature page" or the number
of placed fields) and when it was uploaded.

![The Templates page with the New template form and one template](/docs/assets/screenshots/esign-templates.png "Templates: the upload form and the organization's templates")

## Place fields

The editor shows the PDF's pages on the left and the tools on the right.

1. Under **Placing fields for**, choose a role.
2. Drag a field from **Fields** onto a page, or choose its button to add it: **Signature**, **Date signed** or **Title**.
   A new box marks a starting area of 150 by 34 points.
3. Move a placed field by dragging it, or select it and use the arrow keys. Page Up and Page Down move it to another
   page. Remove it with the × in the field.
4. Repeat for every role. Each role needs exactly one **Signature** field.
5. Choose **Save fields**. The page says "Fields saved as a new template. Send an envelope from it."

Choose **Close the editor** to leave without saving.

![The field editor with signature and date fields placed for two roles](/docs/assets/screenshots/esign-template-editor.png "Placing fields: choose a role, drag fields onto the page, then save")

| Field | What the signer gives | How it is drawn |
| --- | --- | --- |
| **Signature** | Their full name, typed | A handwriting-style image of the typed name, 30 points high. It may extend to the right of its box, so leave clear space there, but not off the page or over another field. |
| **Title** | Their title, typed | Text that must fit inside the box. |
| **Date signed** | Nothing | The date they sign (UTC), filled in by Esign. It must fit inside the box. |

Rules the editor and the server check:

- every role has exactly one Signature field, and only these three field types are used;
- at most 20 fields per template can be signed, and fields don't overlap;
- each field is at least 20 by 10 points and stays on its page;
- the PDF's pages are not rotated or cropped, and the PDF has no form fields or annotations. A PDF that breaks these rules
  can still be uploaded with a signature page, but an envelope sent from it with placed fields is refused.

## Default signers

A role can have a default signer: who usually signs as it, such as the person who always countersigns for your company.
Give a name, an email or both next to the role when you upload the template.

- **New envelope** fills them in for that role. You can still change them before you send.
- An envelope sent through the API with a recipient that leaves out its `name` or `email` gets its role's default.
- **Place fields** on an existing template keeps its default signers in the copy, for the roles the copy keeps.
- They aren't part of what is signed: an envelope records whom it was sent to, and changing a default later changes no
  envelope already sent. The API can change them (`POST /api/templates/{id}/default-signers`).

A default signer's name must be one the signature can draw, as for any signer.

## Templates don't change

A saved template is never changed, except its default signers. **Place fields** next to an existing template opens the editor on a copy, and saving
makes a new template; the old one stays as it was. An envelope keeps the exact PDF and fields it was sent with, so what a
signer signs is what was sent.

There is no button to delete a template.

## The editor on the Templates page

The **Templates** page hosts the editor exactly as a host product would: it opens an editing session for its own address,
stages the PDF, frames the editor and confirms the save with the server. The deployment's list of origins allowed to
embed Esign's pages must therefore include Esign's own address for **Upload and place fields** and **Place fields** to
work. Uploading with a signature page needs nothing more.

## Embed the editor in a host product

A host product can show the field editor inside its own pages. Its backend calls Esign's API with an OAuth client
(see [API](/docs/esign/api)):

1. `POST /api/template-editing-sessions` with `{"allowedParentOrigin": "https://app.example.com", "roles": ["partner",
   "seller"]}` for a new PDF, or with `sourceTemplateId` to start from an existing template's copy. Add `name` and
   `metadata` to label the template it saves (see [Names and metadata](/docs/esign/api#names-and-metadata)); a copy
   keeps its source's otherwise. The answer is `{sessionId, url}`; the one-time code is in the URL's fragment.
2. For a new PDF: `POST /api/template-editing-sessions/{id}/source` with the PDF bytes
   (`Content-Type: application/pdf`), once, before the page is opened.
3. Frame the `url` in the host page. The editor posts `esign.editor.ready` to the parent; the host sends
   `esign.editor.save` with a request id, and the editor answers `esign.editor.saved` or `esign.editor.save-error`, only
   to the parent origin.
4. Treat the message as a prompt only: read the result with `GET /api/template-editing-sessions/{id}`, which answers
   `{templateId}` once saved.

Rules for embedding:

- `allowedParentOrigin` must be one of the origins the deployment allows to embed Esign (https). The editor refuses to
  open inside any other page, and stops working at its next request if that origin is removed.
- One session saves once. For another version, open a new session.
- The editor's code works once, within two minutes. Never log codes or put them in a query string.
