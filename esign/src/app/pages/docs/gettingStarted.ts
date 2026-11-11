import { b, code, DocLink, h, ol, p, PageLink, ul, type DocTopic } from './parts.ts'

// Docs › Getting started: what E-sign does, its pages, the first envelope, what someone who only views sees, and what
// whoever runs the deployment sets up.

export const gettingStarted: DocTopic = {
  slug: 'getting-started',
  title: 'Getting started',
  summary: 'What E-sign does, its pages, and how to send your first document for signature.',
  group: 'app',
  sections: [
    {
      id: 'what-e-sign-does',
      title: 'What E-sign does',
      body: [
        p('E-sign sends PDFs for electronic signature. Someone in your organization uploads a document as a ', b('template'), ', names who signs it and in which order, and sends it as an ', b('envelope'), '.'),
        p('Each signer, in turn, opens the signing page. E-sign emails them a 6-digit code to confirm it\'s them, shows them the document, and records their agreement and their signature. When everyone has signed, E-sign seals the signed PDF and emails each signer a link to download their copy with a certificate of completion.'),
        p(b('E-sign is experimental. '), 'Use synthetic documents and test email addresses only. The consent wording, the certificate and the timestamp service still need review before real documents are signed.'),
      ],
    },
    {
      id: 'the-pages',
      title: 'The pages',
      body: ul(
        [b('Envelopes'), ' (', h(PageLink, { to: '/' }, 'open'), '): every envelope in your organization, newest first, with its status. Open one to see its signers, its audit trail and, once it is completed, the signed PDF and the certificate.'],
        [b('Templates'), ' (', h(PageLink, { to: '/templates' }, 'open'), '): the PDFs your organization sends, with their signer roles and fields.'],
        [b('Docs'), ': these pages. Everyone in the organization can read them, whatever their role.'],
      ),
    },
    {
      id: 'your-first-envelope',
      title: 'Your first envelope',
      body: [
        p('To send, your role needs to send and manage envelopes: Owner, Admin and Editor can (see ', h(DocLink, { to: 'roles' }, 'Roles and permissions'), ').'),
        ol(
          [b('Upload a template. '), 'On Templates, choose a PDF and name the roles that sign it, in signing order (for example ', code('partner'), ' and ', code('seller'), '). Upload it with a signature page, or place fields on its pages. See ', h(DocLink, { to: 'templates' }, 'Templates and fields'), '.'],
          [b('Send an envelope. '), 'On Envelopes, choose New envelope, pick the template and name one signer for each role. See ', h(DocLink, { to: 'sending' }, 'Sending an envelope'), '.'],
          [b('Have each signer sign. '), 'The signer opens the signing page in your host product, the system your organization uses E-sign from, or you open it for them from the envelope\'s page. See ', h(DocLink, { to: 'signers' }, 'What signers see and do'), '.'],
          [b('Keep the result. '), 'When the envelope is completed, download the signed PDF with its certificate from the envelope\'s page. Each signer also gets a link to their copy by email.'],
        ),
        p('E-sign doesn\'t email signers an invitation to sign. The only emails it sends a signer are their verification code and, at the end, the link to their signed copy.'),
      ],
    },
    {
      id: 'if-you-only-view',
      title: 'If your role only views',
      body: [
        p('With the User or Viewer role, you see the same pages: every envelope and its status, signers and audit trail, the templates, and the signed PDF and certificate of a completed envelope. You can\'t upload templates, send, void or open a signing page; those buttons aren\'t shown, and E-sign refuses them if they are tried another way.'),
        p('If there are no templates or envelopes yet, the pages say so. Nothing is missing: someone who sends hasn\'t started yet.'),
      ],
    },
    {
      id: 'setting-up-a-deployment',
      title: 'Setting up a deployment',
      body: [
        p('This is for whoever runs E-sign for your organization.'),
        ul(
          [b('Signing settings. '), 'A published E-sign signs nothing until its code pepper, mail relay and seal key are configured. Until then, the Envelopes page says that signing isn\'t set up.'],
          [b('Due work every five minutes. '), 'The platform runs E-sign\'s due work for every organization every five minutes; there is nothing to set up. It expires envelopes past their sign-by deadline, finishes any envelope a signing request couldn\'t finish (for example after a time limit or an outage), and retries the signed-copy emails. To finish due work at once, someone who manages can choose ', b('Process due work'), ' on Envelopes, and a host can call ', code('POST /api/process-due'), ' with a service account; both cover their own organization.'],
          [b('Embedding. '), 'A host product can show the signing page and the field editor inside its own pages, from the origins the deployment allows.'],
        ),
      ],
    },
  ],
}
