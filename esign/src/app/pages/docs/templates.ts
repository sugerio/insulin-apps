import { b, code, DocLink, DocTable, h, ol, p, PageLink, ul, type DocTopic } from './parts.ts'

// Docs › Templates and fields: what a template is, the two ways to make one, the field editor, and why templates
// don't change once saved.

export const templates: DocTopic = {
  slug: 'templates',
  title: 'Templates and fields',
  summary: 'A template is a PDF and the roles that sign it, signed on a page of its own or in fields you place.',
  group: 'app',
  sections: [
    {
      id: 'what-a-template-is',
      title: 'What a template is',
      body: [
        p('A template is a PDF and the ', b('roles'), ' that sign it, in signing order. A role is a name for a part in the document, such as ', code('partner'), ' or ', code('seller'), '; when you send an envelope, you name the person for each role.'),
        ul(
          ['The PDF can be up to 5 MB and 100 pages. Esign prepares it for signing when you upload it: see ', h(DocLink, { to: 'templates', section: 'the-pdf' }, 'What Esign does to a PDF'), '.'],
          'A template has 1 to 20 roles. Role names use letters, digits, - and _ (no spaces), up to 64 characters, and each is different.',
        ),
      ],
    },
    {
      id: 'the-pdf',
      title: 'What Esign does to a PDF',
      body: [
        p('Fields are drawn into the page itself, where the page shows them. So when you upload a PDF, for a template or with Upload and send, Esign changes what would get in the way, and keeps how the page looks:'),
        ul(
          [b('Form fields'), ' are flattened into the page: their values stay as you see them, and they can no longer be edited.'],
          [b('Comments, highlights and stamps'), ' are flattened into the page the same way.'],
          [b('Links'), ' are removed: their text stays, it no longer opens anything.'],
          [b('Rotated or cropped pages'), ' are redrawn upright, at the size they are shown.'],
          [b('Pages that share their content'), ' in the file each get their own copy, so a signature drawn on one never shows on another. Nothing you see changes.'],
        ),
        p('Esign tells you when it changed something. Signers see and sign the PDF as it is then, and the certificate of completion records the fingerprint (SHA-256) of the file as you uploaded it, with what was changed. A PDF that needed no change is kept exactly as uploaded.'),
        p('Some PDFs can\'t be prepared, and Esign says why when you upload one: a password-protected or encrypted PDF, a damaged one, more than 100 pages, a dynamic (XFA) form, a filled-in form field or a comment that doesn\'t say how it looks, or a page in unusual units, at an odd angle or larger than 200 inches, more than 10,000 form fields and comments, or one that would be over 5 MB once prepared. Printing it to PDF (Save as PDF) usually makes one Esign can use.'),
      ],
    },
    {
      id: 'two-ways',
      title: 'A signature page, or placed fields',
      body: [
        p('On ', h(PageLink, { to: '/templates' }, 'Templates'), ', choose ', b('New template'), '; in the dialog, choose the PDF, name the template (it starts as the file\'s name) and its roles, then choose ', b('Upload and place fields'), ': the field editor opens, so you can put each role\'s signature, title and date exactly where they belong in the document.'),
        p('A host product can also upload a template through the API without placing fields; its signers then sign on a page Esign adds after the document\'s last page, one after another. A PDF Esign can\'t prepare for placed fields is kept as uploaded then, since that page needs none of it.'),
        p('Templates lists each one by its name, when a host product gave it one through the API, then its id; a new envelope\'s template picker shows the name first too.'),
      ],
    },
    {
      id: 'default-signers',
      title: 'Default signers',
      body: [
        p('Next to a role you can give who usually signs as it: a ', b('Signer name'), ', a ', b('Signer email'), ', or both, such as the person who always countersigns for your company. Both are optional, and your contacts are suggested as you type.'),
        p('When you send from the template, they are filled in for that role, and you can still change them. A copy made with Place fields keeps them, for the roles it keeps. They aren\'t part of what is signed: an envelope records whom it was sent to.'),
      ],
    },
    {
      id: 'placing-fields',
      title: 'Placing fields',
      body: [
        ol(
          'Choose a role in the editor.',
          'Drag a field from the toolbar onto a page. Move a placed field by dragging it, or select it and use the arrow keys. Remove it with ×.',
          ['Fields are required. To let the signer leave one empty, select it and clear ', b('Required'), ' under ', b('Selected field'), '.'],
          ['Repeat for every role, then choose ', b('Save'), ': the template is ready to use. Or choose ', b('Save draft'), ' to finish it later: a draft can\'t be used to send until it is saved as ready, and its ', b('Edit'), ' opens its fields again.'],
        ),
        h(DocTable, {
          label: 'Field types',
          columns: ['Field', 'What the signer gives'],
          rows: [
            ['Signature', 'Their signature, from the full name they type. Each role needs at least one; add more where they sign again, and the name they type goes in each one they sign. A long name can extend to the right of the field.'],
            ['Title', 'Their title, which they type.'],
            ['Date signed', 'Nothing: Esign fills in the date they sign.'],
          ],
        }),
        p('The signer signs each field by selecting it, and can\'t finish until every required one is signed. The editor won\'t save until every role has a required Signature field, and it saves at most 20 fields.'),
        p(b('Pre-filled fields'), ' are filled in when an envelope is sent, before anyone signs, such as the partner\'s legal name. Nobody signs them: whoever sends gives each value by its name, or its default is used, and it is drawn on the document signers see. In the editor, give one a ', b('Label'), ' and a ', b('Name'), ' (such as partner.legalName), choose ', b('Add pre-filled field'), ' and drag it into place; drag its entry again to show it somewhere else too. Select it to change its label, name, default or whether it is required, wherever it is placed. Values are plain English letters, digits and punctuation, at most 128 characters, and must fit their box.'),
      ],
    },
    {
      id: 'templates-dont-change',
      title: 'Editing, and what envelopes keep',
      body: [
        p('A template\'s row has ', b('Use'), ' (or ', b('Edit'), ', for a draft) and a ⋯ menu: ', b('View'), ' (or a click on its name: its page, read only, with its details and, below them, its PDF with the box of each placed field, in its role\'s colour), ', b('Edit'), ' (its name and default signers on Details, the field editor on Fields), ', b('Tags'), ', ', b('Share'), ' and ', b('Delete'), ', each for the roles in it that may. The Access column says when a template is shared with you, and as what.'),
        p('A template\'s PDF and fields never change: saving its fields makes a new version, which takes its place with the same name, owner, people and tags, while the earlier one is archived, like a deleted one: no longer listed in Esign, but kept for the envelopes sent from it and for a system that sends with its id. An envelope always keeps the exact PDF and fields it was sent with, so what a signer signs is what was sent, even after its template is edited or deleted.'),
      ],
    },
    {
      id: 'who-sees-it',
      title: 'Who sees a template',
      body: p('A template is yours when you upload it, and nobody else sees it until you share it: ', b('Share'), ' in its row\'s menu shows who sees it, and there you share it by email as Viewer (who sends envelopes from it), Editor (who also edits it) or Admin (who also shares and deletes it), or, with ', b('General access'), ', with everyone in your organization as Viewer or Editor. Your tags on it are yours alone. See ', h(DocLink, { to: 'roles', section: 'who-sees-what' }, 'Who sees each template and envelope'), '.'),
    },
    {
      id: 'in-a-host-product',
      title: 'The editor in a host product',
      body: [
        p('A host product can show the same field editor inside its own pages. It opens an editing session for its own origin, which must be one the deployment allows; the editor refuses to work inside any other page. See ', h(DocLink, { to: 'roles', section: 'service-accounts-and-ai-agents' }, 'Service accounts and AI agents'), '.'),
      ],
    },
  ],
}
