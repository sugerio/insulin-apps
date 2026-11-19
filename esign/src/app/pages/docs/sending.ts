import { b, code, DocLink, DocTable, h, ol, p, PageLink, ul, type DocTopic } from './parts.ts'

// Docs › Sending an envelope: the New envelope form, field by field, what happens on Send, and the API a host uses.

export const sending: DocTopic = {
  slug: 'sending',
  title: 'Sending an envelope',
  summary: 'Send a template to the people who sign it, one for each role, in order.',
  group: 'app',
  sections: [
    {
      id: 'before-you-start',
      title: 'Before you start',
      body: ul(
        ['You need a template: a PDF with its signer roles. See ', h(DocLink, { to: 'templates' }, 'Templates and fields'), '.'],
        ['Your role needs to send and manage envelopes (Owner, Admin or Editor). See ', h(DocLink, { to: 'roles' }, 'Roles and permissions'), '.'],
        'Signing needs to be set up on the deployment. If it isn\'t, the Envelopes page says so.',
      ),
    },
    {
      id: 'steps',
      title: 'Steps',
      body: ol(
        ['On ', h(PageLink, { to: '/' }, 'Envelopes'), ', choose ', b('New envelope'), ' › ', b('From a template'), '. Or, on Templates, choose ', b('Use'), ' next to a template. To send a PDF of your own without a template, choose ', b('New envelope'), ' › ', b('Upload and send'), ' instead: the document and its signers (each with a role you name), the fields in the editor, then a review and Send. Esign prepares the PDF for signing when you upload it (see ', h(DocLink, { to: 'templates', section: 'the-pdf' }, 'What Esign does to a PDF'), ').'],
        'Choose the template.',
        ['For each role, name the signer and give their email address, or choose them from your contacts. The signers sign in this order.'],
        'Add what the signers should see about the document, and a sign-by day if there is one. Both are optional.',
        ['Choose ', b('Send for signature'), '. The envelope opens, and it is the first signer\'s turn. Or choose ', b('Save draft'), ' to finish it later: nobody is asked to sign until it is sent, and Envelopes lists it as a draft, with Continue and Discard. ', b('Send later…'), ', under the arrow beside the send button, picks a day and a time instead: it is checked now, stays a draft, and Esign sends it then, as you, within a few minutes; Continue opens it to send it now, pick another time, or cancel with Save draft. If it can\'t be sent then (you can no longer send in Esign, say), Envelopes says Not sent, and why. Rarely, just after an upgrade of the platform, it says Waiting since its time instead: Insulin Apps hasn\'t yet confirmed that your organization uses Esign; opening Esign confirms it, and Esign, which tries again every ten minutes, sends it then.'],
      ),
    },
    {
      id: 'signers',
      title: 'Signers',
      body: [
        p('One signer for each role of the template, in the template\'s order. Each is asked when the one before has signed.'),
        h(DocTable, {
          label: 'What you give for each signer',
          columns: ['Field', 'What it does'],
          rows: [
            ['Name', 'The signer\'s name, shown on their signing page and on the certificate. A role\'s default signer, if the template has one, is filled in.'],
            ['Email', 'Where their verification code and, at the end, the link to their signed copy are sent. Only someone who can read this mailbox can sign.'],
            ['Title', 'Optional. Shown on the signing page and recorded with the signature.'],
            ['Signs for company', 'Optional. When given, the signer must give their title and confirm they are authorized to sign for that company.'],
            ['Email subject and message', 'Optional, when you write each signer a message of their own: shown on their signing page and in their invitation.'],
          ],
        }),
      ],
    },
    {
      id: 'the-document',
      title: 'The document and the sign-by day',
      body: [
        ul(
          [b('Document name. '), 'Shown to signers, named in the statement they agree to when they sign, and the name of the signed PDF. It is filled in with the template\'s name (on Upload and send, the PDF\'s), and you can change it; left empty, the template\'s is used.'],
          [b('Version'), ' and ', b('Published'), ': which version of the document this is, and when it was published.'],
          [b('Sender name'), ' and ', b('Sender company'), ': who sent it, shown on the signing page.'],
          [b('Sign by. '), 'If a signer hasn\'t signed by the end of this day, the envelope expires and nobody can sign it any more. It can be up to 400 days ahead.'],
          [b('Message. '), 'Optional: an email subject and a message, shown on the signing page and in the invitations Esign emails. Choose Write a different message to each signer to give each their own instead.'],
        ),
        p('All of these are optional. An envelope always has a document name: the template\'s (or the PDF\'s) when you don\'t give one, else "Document" and the day.'),
      ],
    },
    {
      id: 'after-you-send',
      title: 'After you send',
      body: [
        p('The envelope\'s page, titled with the document\'s name, shows its signers, where each one stands, the metadata the sending system gave it (if any; signers never see it), and the audit trail. It updates by itself while the envelope is out for signature.'),
        p('The signer whose turn it is gets an emailed invitation and signs from it; if it went astray, ', b('Resend invitation'), ' on the envelope\'s page sends a new link. See ', h(DocLink, { to: 'signers' }, 'What signers see and do'), '. To withdraw the envelope, void it; see ', h(DocLink, { to: 'statuses', section: 'voiding' }, 'Voiding'), '.'),
        p('If sending fails, for example because the connection drops, choose Send again. The retry carries the same request key, so the envelope is never sent twice.'),
        p('The envelope is yours: nobody else sees it until you share it under ', b('Who sees it'), ' on its page, with people by email or, with ', b('General access'), ', everyone in your organization. Your tags on it, from the form or its page, are yours alone, with yours on its template. See ', h(DocLink, { to: 'roles', section: 'who-sees-what' }, 'Who sees each template and envelope'), '.'),
      ],
    },
    {
      id: 'the-list',
      title: 'The Envelopes list',
      body: [
        p(h(PageLink, { to: '/envelopes' }, 'Envelopes'), ' lists the envelopes you own or that are shared with you, newest first, a page at a time. Out for signature, a row shows how many have signed and whose turn it is (point at it for every signer); otherwise its status. Its button fits its state: ', b('Resend'), ' to the signer whose turn it is, ', b('Download'), ' the signed PDF once completed, else ', b('View'), '; its ⋯ menu has View, Void, Tags and Share.'),
        p('Search by the document\'s name, a signer\'s name or email, or an envelope id, as you type. ', b('Date'), ', ', b('Status'), ', ', b('Sender'), ' (sent by me, shared with me), ', b('Quick views'), ' (waiting for others, expiring soon) and ', b('Tags'), ' (your own, picked by clicking) narrow it; each shows as a chip that removes it, and ', b('Clear all'), ' removes them all.'),
      ],
    },
    {
      id: 'contacts',
      title: 'Contacts',
      body: [
        p(h(PageLink, { to: '/contacts' }, 'Contacts'), ' is your organization\'s address book, and everyone who can use Esign sees all of it, Viewers included: the signers of envelopes only others see too. Everyone an envelope names as a signer is added, or refreshed with the name, title and company given that time, most recently used first. Search it by name or email; add someone with ', b('Add contact'), '; delete one with ', b('Delete'), ' on their row (you confirm it); open a contact to change them or to see the envelopes you see that name them.'),
        p('When you send, matching contacts are suggested under a signer\'s Name and Email as you type (from two characters on); choosing one fills in that signer\'s name, email, title and company.'),
        p('A contact only fills in the form. An envelope keeps the name and email it was sent with: changing or deleting a contact changes no envelope, and the next envelope that names them adds them again.'),
      ],
    },
    {
      id: 'from-another-system',
      title: 'Sending from another system',
      body: [
        p('A host product, or an AI agent someone connects, sends with ', code('POST /api/envelopes'), ' and an ', code('Idempotency-Key'), ' header, a fresh random value for each new envelope. The API can also give each signer a deadline of their own and say who named them. ', code('GET /api/catalog'), ' lists the calls the caller may make, with their fields, including the contacts (', code('/api/contacts'), ').'),
      ],
    },
  ],
}
