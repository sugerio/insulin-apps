---
title: Electronic signatures in general
description: Background on electronic signatures, what usually makes one hold up, and where E-sign stands. General information, not legal advice.
order: 9
---

> [!NOTE]
> This page is general information, not legal advice. Laws differ between countries and states and change over time.
> Ask a lawyer about your own documents and situation.

This page gives the background a business user needs before sending documents for electronic signature. Each section
ends with how the idea shows up in E-sign, describing only what E-sign does.

## What an electronic signature is

Laws in many places define an electronic signature broadly: an electronic sound, symbol or process attached to a record
and adopted by someone with the intent to sign it.

- In the United States, the ESIGN Act and the Uniform Electronic Transactions Act (UETA), adopted by most states, say a
  signature or contract can't be denied effect just because it is electronic.
- In the European Union, the eIDAS Regulation does the same, and distinguishes simple, advanced and qualified electronic
  signatures. Advanced and qualified signatures rely on certificates issued to the signer.

**In E-sign:** the signer adopts their typed name as their signature after confirming a code sent to their email. In
eIDAS terms, that is generally a simple electronic signature. E-sign doesn't make advanced or qualified signatures.

## What usually matters

When an electronic signature is questioned, these points usually come up:

- **Intent**: the person meant to sign.
- **Consent**: they agreed to do business electronically.
- **Attribution**: the signature can be tied to them.
- **Integrity**: the document hasn't changed since it was signed.
- **Records**: everyone can keep an accurate copy.

**In E-sign:**

| Point | What E-sign does |
| --- | --- |
| Intent | The signer ticks a statement that they intend this to be their signature on the named document, and chooses **Sign document**. |
| Consent | The same statement includes agreeing to use electronic records and signatures, after an electronic records disclosure they can read. |
| Attribution | The signer confirms a code sent to their email address, which shows control of that mailbox at the time. A host product can add how it signed them in. |
| Integrity | Each signature records the fingerprint of the PDF it was made on and links to the one before; the finished envelope is sealed and timestamped. |
| Records | Each signer gets a link to the signed PDF with its certificate, and your organization can download both from the envelope's page. |

See [How it works](/docs/esign/how-it-works) for the details.

## Consent to electronic records

When the signer is a consumer, US law asks for more before electronic records replace paper: the consumer is told they
may have a paper copy, how to withdraw consent, and what they need to open and keep the records, and then they consent.

**In E-sign:** the signing page shows an electronic records disclosure that covers a paper copy, withdrawing consent and
what the signer needs; the signer agrees to it before signing, and the signature records which version they agreed to.
Its wording is a draft that still needs review by counsel.

## Knowing who signed

A code sent to an email address shows that the signer could read that mailbox at the time, not who they are. Where more
is needed, the usual ways are for the signer to sign in with an account their organization manages, or to check an
identity document.

**In E-sign:** the code shows control of the signer's email address. A host product that has signed the signer in can
tell E-sign how, and E-sign shows it to the signer and records it in the audit trail as the host's statement. E-sign
doesn't check identity documents.

## Signing for a company

When someone signs for a company, the question is often whether they had the authority to bind it.

**In E-sign:** when an envelope says a signer signs for a company, the signer must give their title and confirm "I'm
authorized to sign for" that company, and the statement they agree to names the company. E-sign records what they
confirmed; it doesn't check their authority.

## Documents that need more

Some documents commonly can't be signed electronically, or need more than a simple electronic signature: for example
wills, some family-law and court documents, some real-estate documents, and certain notices to consumers. Which ones
depends on the country and the state, and changes over time.

**In E-sign:** nothing checks what kind of document is sent. Whoever sends decides whether an electronic signature fits
it. While E-sign is experimental, send synthetic documents only.

## Keeping records

Signed records are usually only as good as your ability to produce them later, unchanged.

**In E-sign:** each signer's copy link works once, within 30 days. Your organization can download the signed PDF and the
certificate from the envelope's page for as long as the envelope exists. E-sign has no retention policy yet, so keep your
own copies of what you must retain.
