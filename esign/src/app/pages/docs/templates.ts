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
          'The PDF can be up to 5 MB and 100 pages.',
          'A template has 1 to 20 roles. Role names use letters, digits, - and _ (no spaces), up to 64 characters, and each is different.',
        ),
      ],
    },
    {
      id: 'two-ways',
      title: 'A signature page, or placed fields',
      body: [
        p('On ', h(PageLink, { to: '/templates' }, 'Templates'), ', choose ', b('New template'), '; in the dialog, choose the PDF, name the roles, then choose ', b('Upload and place fields'), ': the field editor opens, so you can put each role\'s signature, title and date exactly where they belong in the document.'),
        p('A host product can also upload a template through the API without placing fields; its signers then sign on a page Esign adds after the document\'s last page, one after another.'),
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
          ['Repeat for every role, then choose ', b('Save fields'), '.'],
        ),
        h(DocTable, {
          label: 'Field types',
          columns: ['Field', 'What the signer gives'],
          rows: [
            ['Signature', 'Their signature, from the full name they type. Each role needs exactly one. A long name can extend to the right of the field.'],
            ['Title', 'Their title, which they type.'],
            ['Date signed', 'Nothing: Esign fills in the date they sign.'],
          ],
        }),
        p('The editor won\'t save until every role has its one Signature field.'),
      ],
    },
    {
      id: 'templates-dont-change',
      title: 'Templates don\'t change',
      body: [
        p('A saved template is never changed, except its default signers. ', b('Place fields'), ' on an existing template opens the editor on a copy, and saving makes a new template; the old one stays as it was. An envelope always keeps the exact PDF and fields it was sent with, so what a signer signs is what was sent.'),
      ],
    },
    {
      id: 'who-sees-it',
      title: 'Who sees a template',
      body: p('A template is yours when you upload it, and nobody else sees it until you share it: ', b('Sharing'), ' on its row shows who sees it, and there you share it by email as Viewer (who sends envelopes from it), Editor (who also changes its default signers) or Admin (who also shares it). Your tags on it are yours alone. See ', h(DocLink, { to: 'roles', section: 'who-sees-what' }, 'Who sees each template and envelope'), '.'),
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
