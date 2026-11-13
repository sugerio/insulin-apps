import { b, code, DocLink, h, ol, p, PageLink, ul, type DocTopic } from './parts.ts'

// Docs › Getting started: what Esign does, its pages and how the navigation finds them (member/Shell.ts), the first
// envelope, what someone who only views sees, and what whoever runs the deployment sets up.

export const gettingStarted: DocTopic = {
  slug: 'getting-started',
  title: 'Getting started',
  summary: 'What Esign does, how to find your way around it, and how to send your first document for signature.',
  group: 'app',
  sections: [
    {
      id: 'what-esign-does',
      title: 'What Esign does',
      body: [
        p('Esign sends PDFs for electronic signature. Someone in your organization uploads a document as a ', b('template'), ', names who signs it and in which order, and sends it as an ', b('envelope'), '.'),
        p('Each signer, in turn, opens the signing page. Esign emails them a 6-digit code to confirm it\'s them, shows them the document, and records their agreement and their signature. When everyone has signed, Esign seals the signed PDF and emails each signer a link to download their copy with a certificate of completion.'),
        p(b('Esign is experimental. '), 'Use synthetic documents and test email addresses only. The consent wording, the certificate and the timestamp service still need review before real documents are signed.'),
      ],
    },
    {
      id: 'the-pages',
      title: 'The pages',
      body: ul(
        [b('Envelopes'), ' (', h(PageLink, { to: '/envelopes' }, 'open'), '): every envelope in your organization, newest first, with its status. Open one to see its signers, its audit trail and, once it is completed, the signed PDF and the certificate.'],
        [b('Templates'), ' (', h(PageLink, { to: '/templates' }, 'open'), '): the PDFs your organization sends, with their signer roles and fields.'],
        [b('Docs'), ': these pages. Everyone in the organization can read them, whatever their role.'],
        [b('Settings'), ': Esign\'s People, Integrations, API access and Connect AI pages. They are Insulin Apps pages, on insulinapps.com, where your organization manages who can use Esign, its stored credentials, its API clients and the AI agents connected to it.'],
      ),
    },
    {
      id: 'finding-your-way',
      title: 'Finding your way',
      body: [
        p('The navigation on the left has two columns.'),
        ul(
          [b('The first column'), ' has your organization at the top: choose it to see your other organizations, switch to one, go to All apps (your home page on Insulin Apps), or create a new one. Below are Envelopes, Templates and Contacts, then Docs and Settings, and at the bottom your name and role, with your Insulin Apps account and Sign out.'],
          [b('The second column'), ' lists what the open section holds. For Envelopes: All envelopes, New envelope (for roles that send), and one view for each status, such as Out for signature or Completed. For Docs: the topics, then Public docs, Esign\'s documentation on the web. For Settings: People, Integrations, API access and Connect AI, which open on insulinapps.com (in the console\'s preview they are listed without links). Templates has no second column.'],
          [b('The bar above the page'), ' shows where you are, such as Envelopes › Completed. Choose the section\'s name to go back to it.'],
        ),
        p('Each column has its own button to collapse it to icons; point at an icon to see its name. Esign remembers your choice in this browser. On a narrow screen, such as a phone, the menu button at the top opens both columns.'),
      ],
    },
    {
      id: 'your-first-envelope',
      title: 'Your first envelope',
      body: [
        p('To send, your role needs to send and manage envelopes: Owner, Admin and Editor can (see ', h(DocLink, { to: 'roles' }, 'Roles and permissions'), ').'),
        ol(
          [b('Upload a template. '), 'On Templates, choose a PDF and name the roles that sign it, in signing order (for example ', code('partner'), ' and ', code('seller'), '), and place their fields on its pages. See ', h(DocLink, { to: 'templates' }, 'Templates and fields'), '.'],
          [b('Send an envelope. '), 'On Envelopes, choose New envelope, pick the template and name one signer for each role. See ', h(DocLink, { to: 'sending' }, 'Sending an envelope'), '.'],
          [b('Have each signer sign. '), 'The signer opens the signing page from the invitation Esign emails them, in your host product, the system your organization uses Esign from, or you open it for them from the envelope\'s page. See ', h(DocLink, { to: 'signers' }, 'What signers see and do'), '.'],
          [b('Keep the result. '), 'When the envelope is completed, download the signed PDF with its certificate from the envelope\'s page. Each signer also gets a link to their copy by email.'],
        ),
        p('Esign emails a signer their invitation (unless you open the page for them), their verification code and, at the end, the link to their signed copy.'),
      ],
    },
    {
      id: 'if-you-only-view',
      title: 'If your role only views',
      body: [
        p('With the User or Viewer role, you see the same pages: every envelope and its status, signers and audit trail, the templates, and the signed PDF and certificate of a completed envelope. You can\'t upload templates, send, void or open a signing page; those buttons aren\'t shown, and Esign refuses them if they are tried another way.'),
        p('If there are no templates or envelopes yet, the pages say so. Nothing is missing: someone who sends hasn\'t started yet.'),
      ],
    },
    {
      id: 'setting-up-a-deployment',
      title: 'Setting up a deployment',
      body: [
        p('This is for whoever runs Esign for your organization.'),
        ul(
          [b('Signing settings. '), 'A published Esign signs nothing until its code pepper, mail relay and seal key are configured. Until then, the Envelopes page says that signing isn\'t set up.'],
          [b('Due work every five minutes. '), 'The platform runs Esign\'s due work for every organization every five minutes; there is nothing to set up. It expires envelopes past their sign-by deadline, finishes any envelope a signing request couldn\'t finish (for example after a time limit or an outage), and retries the signed-copy emails. To finish due work at once, someone who manages can choose ', b('Process due work'), ' on Envelopes, and a host can call ', code('POST /api/process-due'), ' with a service account; both cover their own organization.'],
          [b('Embedding. '), 'A host product can show the signing page and the field editor inside its own pages, from the origins the deployment allows.'],
        ),
      ],
    },
  ],
}
