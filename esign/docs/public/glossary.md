---
title: Esign glossary
description: The terms Esign uses, from audit trail to void, in plain words.
order: 10
---

The terms Esign and these docs use, in alphabetical order. For the platform's terms (organization, role, service
account and the rest), see the [platform glossary](/docs/platform/glossary).

## A–C

**AI agent.** An AI assistant someone connects to Esign over MCP. It acts with that person's role and permissions. See
[Roles and access](/docs/esign/roles-and-access#ai-agents).

**Audit trail.** The record of everything that happened to an envelope: what, when, to which signer, and from which IP
address and browser. Nobody can change or delete it.

**Certificate of completion.** The summary of a completed envelope: its seal, checked against the stored files, the
fingerprints it binds, the signers and the audit trail. It follows the signed PDF in the file each signer gets.

**Consent disclosure.** The statement a signer agrees to before signing: that they sign electronically, and receive the
document and its records electronically. Also called the electronic records disclosure.

## D–F

**Decline.** A signer's choice not to sign, with a reason. It ends the envelope for everyone.

**Delivery PDF.** The signed PDF followed by its certificate of completion: what **Signed PDF with certificate** and each
signer's copy link download.

**Due work.** Expiring envelopes past their deadline, finishing envelopes a request left unfinished, and retrying
signed-copy emails. The platform runs it every five minutes; someone who manages can run it at once with **Process due
work**, and a host with `POST /api/process-due`.

**Electronic signature.** A sound, symbol or process attached to a record and adopted by someone with the intent to sign
it. See [Electronic signatures in general](/docs/esign/e-signatures).

**Emailed code.** See verification code.

**Envelope.** A template sent to named signers, one for each role, who sign in order. It has a status and an audit trail.

**Field.** A place on a template's page where a role signs (**Signature**) or gives their title (**Title**), or where the
date they sign goes (**Date signed**).

**Field editor.** Where fields are placed on a template's pages. It opens from **Templates**, or inside a host product.

**Fingerprint.** A SHA-256 hash of a file: a short value that changes completely if the file changes in any way. Esign
shows and records the fingerprints of the documents it handles.

## H–L

**Hash chain.** The link between each signature and the one before it, through the fingerprints of the PDFs they were
made on and produced. Changing any step breaks it.

**Host product.** The system your organization uses Esign from. It can send envelopes and show the signing page and the
field editor inside its own pages.

**Idempotency key.** A random value sent with a request to send an envelope. A retry with the same key never sends the
envelope twice.

**KMS.** AWS Key Management Service, which holds the key a published Esign seals completed envelopes with. The key
never leaves it.

**Local test seal.** The stand-in seal of a local preview, with a test key and no independent timestamp. Its certificate
says LOCAL TEST ONLY.

## O–R

**One-time link.** The link that opens the signing page for one signer's turn. It works once, within two minutes.

**Page session.** What the signing page gets for its one-time link: 15 minutes of access to that signer's turn.

**Process due work.** The button on **Envelopes** that runs due work for your organization at once.

**RFC 3161 timestamp.** A timestamp signed by an independent time-stamping authority, showing that a piece of data
existed at that time. A published Esign timestamps each seal.

**Role (in a template).** A part in a template, such as `partner` or `seller`, that one signer fills when the template is
sent. Not to be confused with your role in your organization, which decides what you can do in Esign.

## S

**Seal.** A completed envelope's evidence, signed with the KMS key and timestamped, so a later change shows.

**Service account.** Another system that calls Esign's API with a role of its own, such as a host product. On Insulin
Apps it is an OAuth client, which the organization's owners and admins create on Esign's API access tab.

**Sign-by day.** An optional deadline. If a signer hasn't signed by the end of it, the envelope expires.

**Signature page.** The page Esign adds after a document's last page, where signers sign when the template has no placed
fields.

**Signed copy link.** The link each signer gets by email when everyone has signed, to download the signed PDF with its
certificate. It works once, within 30 days.

**Signer.** Someone named in an envelope to sign for one role. Signers need no account.

**Signing order.** The order of a template's roles. Each signer is asked when the one before has signed.

**Signing page.** Where a signer reviews the document, confirms it is them and signs. It opens with a one-time link from a
host product, or from the envelope's page.

## T–V

**Template.** A PDF and the roles that sign it, signed on a signature page or in placed fields. A saved template never
changes.

**Time-stamping authority.** An independent service that signs a timestamp for a piece of data (RFC 3161).

**Verification code.** The 6-digit code Esign emails a signer to confirm it is them. It works for 10 minutes.

**Void.** Withdrawing an envelope that is out for signature. Nobody can sign it afterwards, and it can't be undone.
