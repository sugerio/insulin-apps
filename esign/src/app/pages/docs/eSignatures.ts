import { DocLink, h, InApp, p, ul, type DocTopic } from './parts.ts'

// Docs › Electronic signatures in general: the background a business user needs, labelled general information, not
// legal advice. Each section ends with how the idea shows up in E-sign, and says only what E-sign does.

export const eSignatures: DocTopic = {
  slug: 'e-signatures',
  title: 'Electronic signatures in general',
  summary: 'What an electronic signature is, what usually makes one hold up, and where E-sign stands.',
  group: 'background',
  generalInformation: true,
  sections: [
    {
      id: 'what-an-electronic-signature-is',
      title: 'What an electronic signature is',
      body: [
        p('Laws in many places define an electronic signature broadly: an electronic sound, symbol or process attached to a record and adopted by someone with the intent to sign it. In the United States, the ESIGN Act and the Uniform Electronic Transactions Act (UETA), adopted by most states, say a signature or contract can\'t be denied effect just because it is electronic. In the European Union, the eIDAS Regulation does the same, and distinguishes simple, advanced and qualified electronic signatures.'),
        h(InApp, null, 'the signer adopts their typed name as their signature after confirming a code sent to their email. In eIDAS terms, that is generally a simple electronic signature. E-sign doesn\'t make advanced or qualified signatures, which rely on certificates issued to the signer.'),
      ],
    },
    {
      id: 'what-usually-matters',
      title: 'What usually matters',
      body: [
        p('When an electronic signature is questioned, these are the points that usually come up:'),
        ul(
          'Intent: the person meant to sign.',
          'Consent: they agreed to do business electronically.',
          'Attribution: the signature can be tied to them.',
          'Integrity: the document hasn\'t changed since it was signed.',
          'Records: everyone can keep an accurate copy.',
        ),
        h(InApp, null, 'the signer chooses Sign document after a consent statement (intent and consent), confirms a code sent to their email (attribution, as far as control of that mailbox goes), signs a document identified by its fingerprint, sealed and timestamped (integrity), and gets a link to the signed PDF with its certificate (records). See ', h(DocLink, { to: 'evidence' }, 'Certificates, seals and the audit trail'), '.'),
      ],
    },
    {
      id: 'consent-to-electronic-records',
      title: 'Consent to electronic records',
      body: [
        p('When the signer is a consumer, US law asks for more before electronic records replace paper: the consumer is told they may have a paper copy, how to withdraw consent, and what they need to open and keep the records, and then they consent.'),
        h(InApp, null, 'the signing page shows an electronic records disclosure that covers a paper copy, withdrawing consent, and what the signer needs; the signer agrees to it before signing. Its wording is a draft that still needs review by counsel.'),
      ],
    },
    {
      id: 'identity',
      title: 'Knowing who signed',
      body: [
        p('A code sent to an email address shows that the signer could read that mailbox at the time, not who they are. Where more is needed, the usual ways are for the signer to sign in with an account their organization manages, or to check an identity document.'),
        h(InApp, null, 'the code shows control of the signer\'s email address. A host product that has signed the signer in can tell E-sign how, and E-sign records it in the audit trail. E-sign doesn\'t check identity documents.'),
      ],
    },
    {
      id: 'documents-that-need-more',
      title: 'Documents that need more',
      body: [
        p('Some documents commonly can\'t be signed electronically, or need more than a simple electronic signature: for example wills, some family-law and court documents, some real-estate documents, and certain notices to consumers. Which ones depends on the country and the state, and changes over time.'),
        h(InApp, null, 'nothing checks what kind of document is sent. Whoever sends decides whether an electronic signature fits it.'),
      ],
    },
  ],
}
