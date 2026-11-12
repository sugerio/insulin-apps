import { b, code, DocTable, h, p, ul, type DocTopic } from './parts.ts'

// Docs › Envelope statuses and voiding: what each envelope and signer status means, voiding, deadlines, and the due
// work that finishes what a request couldn't.

export const statuses: DocTopic = {
  slug: 'statuses',
  title: 'Envelope statuses and voiding',
  summary: 'Where an envelope stands, where each signer stands, and how an envelope ends.',
  group: 'app',
  sections: [
    {
      id: 'envelope-statuses',
      title: 'Envelope statuses',
      body: h(DocTable, {
        label: 'Envelope statuses',
        columns: ['Status', 'What it means'],
        rows: [
          ['Out for signature', 'Signers are signing in turn. It is the only status in which anyone can sign, decline or void.'],
          ['Finishing', 'Everyone has signed, and Esign is sealing the signed PDF. This usually takes seconds.'],
          ['Completed', 'Sealed. The signed PDF and the certificate of completion can be downloaded, and each signer has been sent a link to their copy.'],
          ['Voided', 'Someone who manages envelopes withdrew it before everyone had signed.'],
          ['Declined', 'The signer whose turn it was declined to sign, with a reason.'],
          ['Expired', 'A signer\'s sign-by deadline passed before they signed.'],
        ],
      }),
    },
    {
      id: 'signer-statuses',
      title: 'Signer statuses',
      body: [
        h(DocTable, {
          label: 'Signer statuses',
          columns: ['Status', 'What it means'],
          rows: [
            ['Waiting for an earlier signer', 'Someone before them in the order hasn\'t signed yet.'],
            ['Asked to sign', 'It is their turn. The envelope\'s page also shows when they opened the signing page, and their deadline if there is one.'],
            ['Signed', 'Their signature is recorded.'],
          ],
        }),
        p('These are the only signer statuses. When an envelope ends early (voided, declined or expired), signers who hadn\'t signed keep the status they had, so the signer who declined still shows ', b('Asked to sign'), '. The envelope\'s status says how it ended, and its audit trail says who, when and, for a void or a decline, the reason.'),
      ],
    },
    {
      id: 'voiding',
      title: 'Voiding',
      body: [
        p('Someone who manages envelopes can void an envelope that is out for signature: on the envelope\'s page, choose ', b('Void envelope'), ', give a reason if you like, and confirm. Signers who haven\'t signed can no longer open, verify or sign it.'),
        ul(
          'Voiding can\'t be undone. To try again, send a new envelope.',
          'The reason is kept in the audit trail.',
          'An envelope that is finishing, completed, declined or expired can\'t be voided.',
        ),
      ],
    },
    {
      id: 'deadlines',
      title: 'Sign-by deadlines',
      body: p('An envelope with a sign-by day expires when a signer who hasn\'t signed passes it. A signer who has already signed is past their deadline\'s reach. Esign applies an expiry when someone next opens the envelope, and when due work runs.'),
    },
    {
      id: 'due-work',
      title: 'Due work',
      body: [
        p('Esign usually finishes an envelope right after its last signature, without making the signer wait. If that can\'t happen, for example after a time limit or an outage, the envelope stays Finishing until due work runs.'),
        p('Due work expires envelopes past their deadline, finishes those left Finishing, and retries the signed-copy emails that didn\'t go out. The platform runs it for every organization every five minutes, so an envelope left Finishing usually completes within a few minutes. To run it at once for your organization, someone who manages can choose ', b('Process due work'), ' on Envelopes (it says what it did), and a host can call ', code('POST /api/process-due'), '.'),
      ],
    },
  ],
}
