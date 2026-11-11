import type React from 'react'
import { anchorId, DocLink, h, type DocSection, type DocTopic } from './parts.ts'

// Docs › Glossary: the terms the app uses, A–Z, each with an id of its own (anchorId) so other topics can link to it.
// The sections are built from the list: one per first letter.

const TERMS: readonly (readonly [term: string, definition: React.ReactNode])[] = [
  ['AI agent', ['An AI assistant someone connects to E-sign through the Insulin platform. It acts with that person\'s role and permissions. See ', h(DocLink, { to: 'roles', section: 'service-accounts-and-ai-agents' }, 'Service accounts and AI agents'), '.']],
  ['Audit trail', ['The record of everything that happened to an envelope: what, when, to which signer, and from which IP address and browser. It can\'t be changed. See ', h(DocLink, { to: 'evidence', section: 'the-audit-trail' }, 'The audit trail'), '.']],
  ['Certificate of completion', 'The summary of a completed envelope: its seal, checked against the stored files, the fingerprints it binds, the signers and the audit trail. It follows the signed PDF in the file each signer gets.'],
  ['Consent disclosure', 'The statement a signer agrees to before signing: that they sign electronically, and receive the document and its records electronically. Also called the electronic records disclosure.'],
  ['Decline', 'A signer\'s choice not to sign, with a reason. It ends the envelope for everyone.'],
  ['Due work', ['Expiring envelopes past their deadline, finishing envelopes a request left unfinished, and retrying signed-copy emails. The platform runs it every five minutes; someone who manages can run it at once from Envelopes, and a host with ', h('code', null, 'POST /api/process-due'), '.']],
  ['Electronic signature', ['A sound, symbol or process attached to a record and adopted by someone with the intent to sign it. See ', h(DocLink, { to: 'e-signatures' }, 'Electronic signatures in general'), '.']],
  ['Envelope', 'A template sent to named signers, one for each role, who sign in order. It has a status and an audit trail.'],
  ['Field', 'A place on a template\'s page where a role signs or gives their title, or where the date they sign goes.'],
  ['Field editor', 'Where fields are placed on a template\'s pages. It opens from Templates, or inside a host product.'],
  ['Fingerprint', 'A SHA-256 hash of a file: a short value that changes completely if the file changes in any way. E-sign shows and records the fingerprints of the documents it handles.'],
  ['Hash chain', 'The link between each signature and the one before it, through the fingerprints of the PDFs they were made on and produced. Changing any step breaks it.'],
  ['Host product', 'The system your organization uses E-sign from. It can send envelopes and show the signing page and the field editor inside its own pages.'],
  ['Idempotency key', 'A random value sent with a request to send an envelope. A retry with the same key never sends the envelope twice.'],
  ['Local test seal', 'The stand-in seal of a local preview, with a test key and no independent timestamp. Its certificate says LOCAL TEST ONLY.'],
  ['Role', 'A part in a template, such as partner or seller, that one signer fills when the template is sent. Not to be confused with your role in your organization, which decides what you can do in E-sign.'],
  ['Seal', 'A completed envelope\'s evidence, signed with the seal key and timestamped, so a later change shows.'],
  ['Seal key', 'The key E-sign seals completed envelopes with. The deployment holds it so that it can sign but can\'t be read back; the public half of every seal key E-sign has used is listed in its source, which is what a seal is checked against.'],
  ['Service account', 'Another system that calls E-sign\'s API with a role of its own, such as a host product.'],
  ['Sign-by day', 'An optional deadline. If a signer hasn\'t signed by the end of it, the envelope expires.'],
  ['Signature page', 'The page E-sign adds after a document\'s last page, where signers sign when the template has no placed fields.'],
  ['Signed copy link', 'The link each signer gets by email when everyone has signed, to download the signed PDF with its certificate. It works once, within 30 days.'],
  ['Signer', 'Someone named in an envelope to sign for one role. Signers need no account.'],
  ['Signing order', 'The order of a template\'s roles. Each signer is asked when the one before has signed.'],
  ['Signing page', 'Where a signer reviews the document, confirms it\'s them and signs. It opens with a one-time link from a host product, or from the envelope\'s page.'],
  ['Template', 'A PDF and the roles that sign it, signed on a signature page or in placed fields. A saved template never changes.'],
  ['Time-stamping authority', 'An independent service that signs a timestamp for a piece of data (RFC 3161), showing it existed at that time.'],
  ['Verification code', 'The 6-digit code E-sign emails a signer to confirm it\'s them. It works for 10 minutes.'],
  ['Void', 'Withdrawing an envelope that is out for signature. Nobody can sign it afterwards, and it can\'t be undone.'],
]

const LETTERS = [...new Set(TERMS.map(([term]) => term[0].toUpperCase()))]

export const glossary: DocTopic = {
  slug: 'glossary',
  title: 'Glossary',
  summary: 'The terms E-sign uses, from A to Z.',
  group: 'background',
  compactContents: true,
  sections: LETTERS.map((letter): DocSection => ({
    id: `letter-${letter.toLowerCase()}`,
    title: letter,
    body: h('dl', { className: 'flex flex-col gap-3' }, ...TERMS.filter(([term]) => term[0].toUpperCase() === letter).map(([term, definition]) =>
      h('div', { key: term },
        h('dt', { id: anchorId(term), className: 'font-medium' }, term),
        h('dd', { className: 'text-muted-foreground' }, ...(Array.isArray(definition) ? definition : [definition]))))),
  })),
}
