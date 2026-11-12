import { b, DocLink, h, p, ul, type DocTopic } from './parts.ts'

// Docs › Certificates, seals and the audit trail: what Esign records, how a completed envelope is sealed, what the
// certificate shows and what it doesn't, and the local test seal.

export const evidence: DocTopic = {
  slug: 'evidence',
  title: 'Certificates, seals and the audit trail',
  summary: 'What Esign records about a signing, how it seals the result, and what the certificate of completion shows.',
  group: 'app',
  sections: [
    {
      id: 'the-audit-trail',
      title: 'The audit trail',
      body: [
        p('Every envelope has an audit trail: what happened, when, to which signer, and from which IP address and browser. It records when a signing link was issued and the page opened, when a code was sent and verified, which pages the signer viewed, when they signed or declined, when the envelope was voided, expired or completed, and when signed copies were sent and downloaded.'),
        p('Nothing in the audit trail can be changed or deleted, and it is the same for every role. Open an envelope to see it.'),
      ],
    },
    {
      id: 'signatures-and-the-hash-chain',
      title: 'Signatures and the hash chain',
      body: p('Each signature is recorded with the fingerprint (SHA-256) of the PDF it was made on and of the PDF it produced, and is linked to the signature before it. Each signer signs exactly what the previous signer produced, so changing any step breaks the chain. The signing event also records which version of the consent wording the signer agreed to.'),
    },
    {
      id: 'the-seal',
      title: 'The seal',
      body: [
        p('When everyone has signed, Esign seals the envelope: it signs a summary of the evidence (the source PDF, each signature, the audit events and the signed PDF) with Esign\'s seal key, and has that signature timestamped by an independent time-stamping authority (RFC 3161). The seal shows that the evidence hasn\'t changed since, and when it existed.'),
        p('Events after sealing, such as the signed copies being sent, are still recorded, and marked as recorded after sealing.'),
      ],
    },
    {
      id: 'the-certificate-of-completion',
      title: 'The certificate of completion',
      body: [
        p('A completed envelope has two downloads on its page:'),
        ul(
          [b('Signed PDF with certificate: '), 'the signed document followed by its certificate of completion, the same file each signer gets.'],
          [b('Certificate of completion: '), 'the seal checked against the stored files, shown on the page, with its key, its timestamp and the fingerprints it binds, the signers and the audit trail. It can be downloaded as JSON.'],
        ),
        p('What the certificate doesn\'t establish, it says. Each signer\'s name, email address, role and the consent text they agreed to are sealed with their signing record; the envelope\'s other current details, such as each signer\'s status, are read from the database and aren\'t bound by the seal. For a signing link issued, the IP address and browser are those of whoever issued the link, not the signer\'s. Who a signer is, beyond control of their email address at the time, isn\'t established. The time-stamping authority\'s certificates aren\'t checked for revocation.'),
      ],
    },
    {
      id: 'the-local-test-seal',
      title: 'The local test seal',
      body: p('A local preview has no seal key, so Esign seals with a test key instead, and the certificate says ', b('LOCAL TEST ONLY'), '. Such a certificate is a simulation, with server-recorded times and no independent timestamp. Don\'t rely on it. In a local preview, codes go to a test mailbox instead of being emailed, and the signing page says where to find them.'),
    },
    {
      id: 'keeping-records',
      title: 'Keeping records',
      body: p('Each signer\'s copy link works once, within 30 days. Your organization can download the signed PDF and the certificate from the envelope\'s page for as long as the envelope exists. For what this evidence means in general, see ', h(DocLink, { to: 'e-signatures' }, 'Electronic signatures in general'), '.'),
    },
  ],
}
