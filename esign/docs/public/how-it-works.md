---
title: How Esign works
description: The signing lifecycle, the hash chain, codes and sessions, the seal key and RFC 3161 seal, the certificate of completion, what is stored, the usage Esign reports to Insulin Apps, and known limits.
order: 8
---

This page explains what happens behind Esign's pages: how an envelope moves from template to sealed PDF, what evidence
Esign keeps and how it protects it, and what it doesn't establish. It is for people who need to judge the evidence, for
developers of host products, and for AI agents answering questions about a signing. Esign is experimental: its evidence
and wording still need review before real documents are signed.

## The signing lifecycle

```diagram
title: From template to sealed PDF
description: A template is a PDF with its signer roles and either placed fields or an added signature page. Sending it makes an envelope with one recipient per role, signed in order. For each signer in turn, a one-time link opens the signing page, a six-digit code emailed to the signer confirms who they are, and they agree to sign electronically and sign; the signature is drawn into the PDF and hash-chained to the previous one. After the last signer, Esign checks the chain, seals it with a seal key signature and an RFC 3161 timestamp, and the envelope is completed with the signed PDF, a certificate of completion and a copy link emailed to each signer.
size: 740 x 550
box template 20 20 260 70 "Template" "a PDF and its signer roles, with" "fields or an added signature page"
box envelope 380 20 340 70 "Envelope" "one recipient per role, signed in order;" "document name, sender, sign-by date"
group each 20 130 700 200 "For each signer, in order"
box link 40 170 200 66 accent "Signing page" "opened with a one-time" "link; review the PDF"
box code 270 170 200 66 accent "Emailed code" "six digits, confirms" "who is signing"
box sign 500 170 200 66 accent "Agree and sign" "consent to sign" "electronically, then sign"
box render 270 256 430 58 "Drawn and chained" "drawn into the PDF, hash-chained to the one before"
box seal 40 372 320 80 accent "Seal" "the chain checked, then a seal key" "signature and an RFC 3161 timestamp"
box done 400 372 320 80 "Completed" "the signed PDF, a certificate of" "completion, copy links emailed"
box status 20 482 700 52 muted "Envelope status" "Out for signature, then Finishing, then Completed; or Voided, Declined or Expired"
arrow template.r -> envelope.l "send"
arrow envelope.b:0.3 -> link.t:0.95 mid=112
arrow link.r -> code.l
arrow code.r -> sign.l
arrow sign.b -> render.t:0.767
arrow render.l -> link.b "next signer"
arrow render.b:0.1 -> seal.t:0.85 "after the last signer"
arrow seal.r -> done.l
```

1. **Template.** Someone uploads a PDF with its roles, signed on an added signature page or in placed fields.
2. **Envelope.** Sending names one recipient per role. In the same request, Esign copies the template's PDF to the
   envelope as its initial document, makes the first signer's task active and marks the envelope **Out for signature**
   (`IN_PROGRESS`).
3. **The signing page.** For the active signer, a host product (or someone who manages, from the envelope's page) gets a
   one-time code and opens the signing page with it.
4. **Review, confirm, sign.** The signer reviews the document, enters the 6-digit code emailed to them, agrees to sign
   electronically and signs. Reading the document needs only the page session; previews, declining and signing also need
   the code.
5. **Rendering.** Esign saves the signature, then draws it into the PDF from exactly what it saved. Then the next
   signer's task becomes active, and they sign the PDF the previous signer produced.
6. **Sealing.** After the last signature is drawn, the envelope is **Finishing** (`FINALIZING`). Esign checks the whole
   chain, seals it and marks the envelope **Completed**. Each signer is then emailed a link to their copy.

Rendering and sealing run after the signer gets their answer, so a signer never waits for the seal. If that work is cut
short (a time limit or an outage), the signature waits to be drawn, or the envelope stays **Finishing**, until due work
picks it up: the platform runs due work every five minutes, and someone who manages can run it at once.

An envelope can also end early: **Voided** (withdrawn by someone who manages), **Declined** (the active signer declined,
with a reason) or **Expired** (a signer's deadline passed before they signed). Every signing step requires the envelope
to be out for signature, so a void, a decline or an expiry is ordered entirely before or after any signature.

## Evidence

### The audit trail

Every envelope has an audit trail that nobody can change or delete: the database refuses updates and deletes. It records
the signing link issued, the page opened, each code sent, the code verified, the document fetched, the pages viewed, the
signature, a void, decline or expiry, completion, and each signed copy sent and downloaded. Signer steps record the IP
address Cloudflare saw and the browser's user agent. Codes are never recorded.

### Signatures and the hash chain

Each signature is saved as one record that holds:

- **who signed and how they were identified**: the task, role and recipient name, the email address the code was
  verified for, when the code was entered, when the signer consented, the version and fingerprint of the consent text
  they agreed to, and their title, company and the statement they agreed to, if any;
- **what was drawn and where**: each field's value, how it was drawn and the fingerprint of the image;
- **the input**: the fingerprint (SHA-256) of the PDF the signer signed;
- **the link**: the fingerprint of the signature before it.

The signature's own fingerprint covers all of these together. The PDF it produces is fingerprinted when it is drawn, and
the next signer signs exactly that PDF. Changing any record, image or PDF in the chain breaks it, and the database allows
nothing to change after a signature is saved but its drawing state.

### The seal

When everyone has signed, Esign builds an evidence manifest. First it checks the whole chain: the initial document's
fingerprint, every signature's order, link, input and fingerprint, every drawn PDF (drawn again, byte for byte), and every
stored file's fingerprint. Then it seals the manifest:

| | Managed seal (published) | Local test seal (local preview only) |
| --- | --- | --- |
| **How** | An ECDSA P-256 signature with Esign's seal key, which the deployment can sign with but not read back, then an RFC 3161 timestamp over that signature from an independent time-stamping authority (DigiCert's public service) | Two HMACs with a software test key; the "time" is the last signer's consent time |
| **Covers** | The manifest and the audit trail up to sealing; later events are listed as recorded after sealing | The manifest |
| **Checked** | On every read: the signature against a seal key Esign's source lists as in use at the timestamp's time, the timestamp against the pinned authority, as of its time | Recomputed with the current key on every read |
| **Certificate says** | "Sealed: Esign seal key signature + RFC 3161 timestamp", with the key's fingerprint | **LOCAL TEST ONLY** |

A published Esign seals only with the managed seal. The local test seal is a simulation, with server-recorded times and
no independent timestamp: don't rely on it.

### The certificate of completion

A completed envelope's page offers two downloads:

- **Signed PDF with certificate**: the signed document, page for page, followed by its certificate pages: the document and
  how it was sealed, each signer with their email, how they were identified, their IP address and device, and the events
  in order. It is the same file each signer's copy link downloads.
- **Certificate of completion**: the certificate as a page (and **Download certificate JSON**): the seal with its key, its
  key fingerprint, its timestamp and the authority; the envelope and document fingerprints; each signer's recorded events
  and fingerprints; and the audit trail.

The same checks as at sealing run again every time the certificate or the delivery PDF is read, so a changed record,
image or PDF makes them fail rather than show something wrong. The seal covers the signed PDF and the evidence, not the
delivery PDF itself.

What the certificate doesn't establish, it says:

- each signer's name, email address, role and the consent text they agreed to are sealed with their signing record, and
  shown as such; the envelope's other current details, such as each signer's status, are read from the database and
  aren't bound by the seal;
- for a signing link issued, the IP address and browser are those of whoever issued the link (a member or the host
  product's server), not the signer's;
- who a signer is, beyond control of their email address at the time (and any sign-in the host reported), isn't
  established;
- the time-stamping authority's certificates aren't checked for revocation.

## Codes and sessions

Signers never sign in. Two kinds of short-lived credentials give them access to their own turn only:

| Credential | What it is | Lifetime |
| --- | --- | --- |
| **One-time link code** | 64 hex characters in the signing link's fragment, for one signer's active task and one page origin | Once, within 2 minutes |
| **Page session** | The token the page gets for that code, sent in its own header | 15 minutes, and only while the task is active and the envelope out for signature |
| **Emailed code** | 6 digits sent to the signer's email address | 10 minutes, once; up to 3 sends and 5 tries per 15 minutes per signer, 60 seconds between sends |

Esign stores only hashes of link codes and sessions. The emailed code is stored as a keyed hash over the task, its
email address and the code, so it works only for the address it was sent to, and a task's email address can't be changed.
Only the page session the code was sent for can enter it, and only the session that entered the latest code can sign.

The field editor opens the same way, with its own kind of code and session that the signing page never accepts.

## What Esign stores

Everything is in Esign's one database, scoped to your organization:

- templates (the PDF, roles and placed fields), envelopes, signer tasks and each envelope's initial document;
- one record per signature, the drawn images and each signer's output PDF;
- the seal and the delivery PDF of each completed envelope;
- the audit trail;
- hashed link codes, sessions and emailed codes;
- the signed-copy links (as hashes) and when each was sent and used.

There is no retention policy yet: nothing is deleted automatically, and there is no endpoint to delete templates or
envelopes.

## What Esign reports to Insulin Apps every hour

Once an hour, Esign sends Insulin Apps a few numbers for each organization, so that Insulin Apps can watch usage and plan
capacity. They are counts and sizes only:

| Number | What it counts, for the organization |
| --- | --- |
| `envelopes` | Its envelopes, in every status |
| `envelopes_in_progress`, `envelopes_finalizing`, `envelopes_completed`, `envelopes_declined`, `envelopes_expired`, `envelopes_voided` | Its envelopes in each status: out for signature, finishing, completed, declined, expired and voided |
| `templates` | Its templates |
| `signatures` | The signatures recorded in its envelopes |
| `storage_bytes` | The bytes its documents take in Esign's storage: template PDFs (and PDFs waiting in the field editor), each envelope's PDFs, drawn signatures and seals |

For the whole deployment, Esign adds the size of its database (`database_bytes`) and how many organizations have data in
it (`organizations`). Each number is the total when it is measured, not what happened during the hour. Esign never sends
names, email addresses, document titles, document contents or anything a signer entered.

The report goes to the platform with Esign's own token, on the platform's five-minute run: the first run of each hour
sends it, and if the platform doesn't accept it, the next run tries again. A deployment the platform hasn't set up for it
sends nothing.

## Known limitations

- **Legal review.** The consent text, the evidence, the certificate and the intent wording are drafts for counsel. Legal
  effect under the US ESIGN Act and UETA isn't established.
- **Timestamp authority.** Revocation of the authority's certificates isn't checked, its terms for production use aren't
  confirmed, and the request goes over plain HTTP (the answer is signed and verified). The signed PDF carries no embedded
  (PAdES) signature.
- **Identity.** The emailed code shows control of a mailbox, not who someone is. Esign doesn't check identity documents.
- **Rate limits.** Beyond the code budget and its long link codes, Esign relies on the platform's per-IP limits on its
  public pages.
- **Retention and integrity.** No retention policy; storage writes are create-only but not write-once storage; privileged
  changes to the database or keys remain possible and are detected only where the checks above run again.
- **Due work.** Between the platform's five-minute runs, deadlines, unfinished envelopes and unsent copies wait for the
  next request on the envelope or a **Process due work**. One run handles up to 25 envelopes to finish and 25 owing copies.
- **Display.** The signing page draws the PDF as images, without selectable text, so it isn't an accessible reader. None
  of this proves a person read the document: Esign checks the session, the code, the consent and the current input, not
  the display.
