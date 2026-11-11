import { b, code, DocTable, h, p, ul, type DocTopic } from './parts.ts'

// Docs › Roles and permissions: the console roles, Esign's two permissions, custom roles, service accounts and AI
// agents, and signers, who have no account.

export const roles: DocTopic = {
  slug: 'roles',
  title: 'Roles and permissions',
  summary: 'What each role can do in Esign, and how other systems and AI agents get access.',
  group: 'app',
  sections: [
    {
      id: 'who-can-do-what',
      title: 'Who can do what',
      body: [
        p('Your role in your Insulin organization decides what you can do in Esign. Esign has two permissions:'),
        ul(
          [b('Send and manage envelopes'), ' (', code('esign.manage'), '): upload templates and place fields, send envelopes, void them, open a signer\'s signing page, and run due work. It includes viewing.'],
          [b('View envelopes'), ' (', code('esign.view'), '): see the organization\'s templates and envelopes, their statuses and audit trails, and download completed envelopes\' signed PDFs and certificates.'],
        ),
        h(DocTable, {
          label: 'Roles',
          columns: ['Role', 'Permission', 'In Esign'],
          rows: [
            ['Owner', 'Send and manage', 'Everything in Esign.'],
            ['Admin', 'Send and manage', 'Everything in Esign.'],
            ['Editor', 'Send and manage', 'Everything in Esign.'],
            ['User', 'View', 'Sees templates and envelopes, read-only.'],
            ['Viewer', 'View', 'Sees templates and envelopes, read-only.'],
          ],
        }),
        p('Every role can read these Docs. The header shows your role. What your role can\'t do isn\'t shown, and Esign refuses it on the server too, however it is asked.'),
      ],
    },
    {
      id: 'custom-roles',
      title: 'Custom roles',
      body: p('An organization can also give people a custom role built from these two permissions. A custom role with only View envelopes, for example, sees everything a Viewer sees and changes nothing.'),
    },
    {
      id: 'service-accounts-and-ai-agents',
      title: 'Service accounts and AI agents',
      body: [
        ul(
          [b('Service accounts. '), 'Another system, such as your host product, calls Esign\'s API with a role of its own, and can do what that role allows. A host uses one to send envelopes, embed the signing page and the field editor, follow statuses, and, when it can\'t wait for the platform\'s five-minute run, finish due work at once with ', code('POST /api/process-due'), '.'],
          [b('AI agents. '), 'Someone can connect an AI assistant to Esign through the Insulin platform. It acts with that person\'s role and permissions, and no more.'],
        ),
        p('Both can call ', code('GET /api/catalog'), ', which lists only the calls they may make, with their fields. Neither can use the signing page\'s own API, which answers only a signer\'s link and session.'),
      ],
    },
    {
      id: 'signers',
      title: 'Signers',
      body: p('Signers don\'t need an account and don\'t need to be in your organization. Their one-time link and the code emailed to them give access to their own turn in their own envelope, and to nothing else.'),
    },
  ],
}
