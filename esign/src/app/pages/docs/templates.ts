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
        p('On ', h(PageLink, { to: '/templates' }, 'Templates'), ', choose the PDF, name the roles, then:'),
        ul(
          [b('Upload with a signature page. '), 'Signers sign on a page Esign adds after the document\'s last page, one after another.'],
          [b('Upload and place fields. '), 'The field editor opens, so you can put each role\'s signature, title and date exactly where they belong in the document.'],
        ),
        p('Templates lists each one by its name, when a host product gave it one through the API, then its id; a new envelope\'s template picker shows the name first too.'),
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
        p('A saved template is never changed. ', b('Place fields'), ' on an existing template opens the editor on a copy, and saving makes a new template; the old one stays as it was. An envelope always keeps the exact PDF and fields it was sent with, so what a signer signs is what was sent.'),
      ],
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
