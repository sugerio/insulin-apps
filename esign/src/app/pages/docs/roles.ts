import { b, code, DocTable, h, p, ul, type DocTopic } from './parts.ts'

// Docs › Roles and permissions: the console roles, Esign's two permissions, who sees each template and envelope (owners,
// sharing, tags and the Ownership page), custom roles, service accounts and AI agents, and signers, who have no account.

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
          [b('Send and manage envelopes'), ' (', code('esign.manage'), '): upload templates and place fields, send envelopes, void them, share them, and run due work. It includes viewing.'],
          [b('View envelopes'), ' (', code('esign.view'), '): see the templates and envelopes shared with you, their statuses and audit trails, and download completed envelopes\' signed PDFs and certificates.'],
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
        p('Every role can read these Docs. The bottom of the navigation shows your name and role. What your role can\'t do isn\'t shown (New envelope, for example, is only on the Envelopes page of roles that send), and Esign refuses it on the server too, however it is asked.'),
        p('People, Integrations, API access and Connect AI, under Settings, are Insulin Apps pages: who can do what there is decided by Insulin Apps, not by Esign.'),
      ],
    },
    {
      id: 'who-sees-what',
      title: 'Who sees each template and envelope',
      body: [
        p('Every template and envelope has an owner, whoever created it, and nobody else sees it, your organization\'s owners and admins included, unless it is shared with them by email, as one of:'),
        h(DocTable, {
          label: 'Roles in a template or an envelope',
          columns: ['Role in it', 'What it allows'],
          rows: [
            ['Viewer', 'See it, its audit trail and signed PDF, and who it is shared with; send envelopes from a template; tag it for yourself.'],
            ['Editor', 'Also change it: a template\'s default signers; an envelope\'s void and invitations.'],
            ['Admin', 'Also share it with others, and stop sharing it.'],
          ],
        }),
        p('A role in a template or an envelope never goes beyond your role in Esign: with View envelopes only, you are a Viewer of everything shared with you. ', b('Share'), ' in a template\'s ⋯ menu, or ', b('Who sees it'), ' on an envelope\'s page, shows its owner and the people it is shared with; its admins and owner share it there, and anyone can leave. An envelope sent from a template is its sender\'s, not shared with the template\'s people.'),
        p('Your tags on a template or an envelope are yours alone. The lists filter by them (', b('Tags'), '), and by whether they are yours or shared with you (', b('Sender'), ' on Envelopes, ', b('Owner'), ' on Templates).'),
        p(b('Ownership'), ', in the navigation of organization owners and admins, lists the API clients that have called Esign and the one person what each creates is shared with, as Admin (without one, only the client sees it); and, for organization owners, everyone who owns templates or envelopes, with ', b('Take over'), ' to become the owner of everything someone owns.'),
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
          [b('Service accounts. '), 'Another system, such as your host product, calls Esign\'s API with a role of its own, and can do what that role allows. What it creates is its own, and is shared with the person Ownership names for it. A host uses one to send envelopes, embed the signing page and the field editor, follow statuses, and, when it can\'t wait for the platform\'s five-minute run, finish due work at once with ', code('POST /api/process-due'), '.'],
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
