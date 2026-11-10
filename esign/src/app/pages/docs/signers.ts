import { b, DocLink, h, ol, p, ul, type DocTopic } from './parts.ts'

// Docs › What signers see and do: how a signer reaches the signing page, its three steps, declining, and what they get
// at the end. The signing page's own "About signing" panel (ui/SigningHelp.ts) says the same in brief.

export const signers: DocTopic = {
  slug: 'signers',
  title: 'What signers see and do',
  summary: 'How a signer reaches the signing page, its three steps, and what they get when everyone has signed.',
  group: 'app',
  sections: [
    {
      id: 'reaching-the-signing-page',
      title: 'Reaching the signing page',
      body: [
        p('Signers don\'t need an account. Each signer, when it is their turn, opens the signing page in one of two ways:'),
        ul(
          [b('In your host product. '), 'The system your organization uses E-sign from shows the signing page inside its own pages, to the signer it has signed in.'],
          [b('From the envelope\'s page. '), 'Someone who manages envelopes chooses ', b('Open {name}\'s signing page'), ', for example when the signer signs in person, or to try E-sign out.'],
        ),
        p('Either way, the page is opened with a one-time link that works once, within two minutes, and only for that signer. The page then stays usable for 15 minutes; after that, the signer opens it again the same way. The code that confirms who they are still goes to the signer\'s own email address.'),
        p('A signer whose turn hasn\'t come yet, or whose envelope has ended, can\'t open it.'),
      ],
    },
    {
      id: 'the-three-steps',
      title: 'The three steps',
      body: [
        ol(
          [b('Review. '), 'The signer reads the document. Its fingerprint (SHA-256) identifies exactly this file, and they can download a copy. E-sign records which pages they looked at.'],
          [b('Confirm it\'s you. '), 'E-sign emails a 6-digit code to the signer\'s address. It works for 10 minutes. They can ask for a new one after a minute, up to 3 codes and 5 tries in 15 minutes.'],
          [b('Sign. '), 'The signer types their full name to adopt their signature, sees how it will look in each place it goes, gives their title if asked, reads the electronic records disclosure, agrees to sign electronically, and chooses ', b('Sign document'), '.'],
        ),
        p('The name is typed in English letters with single spaces, up to 64 characters. If the envelope says they sign for a company, they also give their title and confirm they are authorized to sign for it.'),
        p('The signing page has an ', b('About signing'), ' panel that explains these steps to the signer.'),
      ],
    },
    {
      id: 'declining',
      title: 'Declining',
      body: [
        p('A signer who doesn\'t want to sign chooses ', b('Decline to sign'), ' on the first step and gives a reason. They confirm it\'s them with the emailed code first. The envelope then ends for everyone: its status becomes Declined, nobody can sign it any more, and the audit trail records who declined, why, and when.'),
      ],
    },
    {
      id: 'after-signing',
      title: 'After signing',
      body: [
        p('The signer sees that their signature is recorded, and any lines the sender added for after signing. The next signer\'s turn starts.'),
        p('When everyone has signed, E-sign seals the signed PDF and emails every signer a link to download it, followed by its certificate of completion. The link works once, within 30 days. See ', h(DocLink, { to: 'evidence' }, 'Certificates, seals and the audit trail'), '.'),
      ],
    },
    {
      id: 'in-a-host-product',
      title: 'In a host product',
      body: [
        p('When the signing page is shown inside a host product, it tells the host when the signer has signed, declined or cancelled, so the host can move on. It works only inside the origins the deployment allows, and for the origin its link was made for.'),
      ],
    },
  ],
}
