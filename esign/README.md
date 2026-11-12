# Esign

Esign sends PDFs for electronic signature. A member of an organization uploads a document, names
who signs it and in which order, and Esign takes each signer through a signing page: it confirms
who they are with a code emailed to them, shows the document, records their consent and signature,
and, once everyone has signed, seals the result and emails each signer a link to their copy with a
certificate of completion.

It is an Insulin app: it runs at `esign.<domain>` behind the Insulin hosting gateway, which signs
members in and decides what their role allows. A host product can also drive it through the API
with a service account, embed the signing page and the template editor in its own pages, and follow
each envelope's status.

**Status: experimental.** Use synthetic documents and test addresses only. The consent wording, the
certificate and the timestamp service still need review before real documents are signed (see
"Known limitations" in [docs/architecture.md](docs/architecture.md)).

## What it does

- **Templates.** A PDF with the roles that sign it (for example `partner` and `seller`). Fields
  (signature, title, date signed) can be placed on its pages in the template editor; without fields,
  a signature page is appended.
- **Envelopes.** A template sent to named recipients, one per role, who sign in order. An envelope
  can carry the document's name and version, the sender, a sign-by deadline, and what each signer
  sees after signing. It can be voided; a signer can decline with a reason.
- **Signing.** The recipient opens a one-time link, confirms a six-digit code sent to their email,
  reviews the document, agrees to sign electronically and signs. Signing for a company records their
  title and authority.
- **Evidence.** Every signature is hash-chained to the previous one and to the document it was made
  on. The finished envelope is sealed with a signature by Esign's seal key and an RFC 3161 timestamp, and the
  certificate of completion lists the signers, the audit trail and how it was sealed.

## The pages

Members open Esign from their organization's Insulin apps:

- **Envelopes**: every envelope with its status; one envelope's signers, audit trail and, once
  completed, the signed PDF and certificate. Those who manage send new ones, void, open the active
  signer's signing page, and run the due work.
- **Templates**: upload a PDF with its roles, signed on an added page or in fields placed in the
  editor.
- **Docs**: getting started, the main tasks, what signers see, statuses, evidence, roles, background
  on electronic signatures (general information, not legal advice) and a glossary. Every role can
  open them.
- **Settings**: People, Integrations, API access and Connect AI, the platform's pages for Esign on
  `insulinapps.com/apps/esign/settings/`.

They are in the two-level navigation every Insulin app has: the organization switcher, these
sections (Envelopes and Templates from `insulin.navigation` in `package.json`) and the person in the
first column; the open section's items (the Envelopes views by status, the Docs topics, Settings'
pages) in the second; each column collapses to icons.

Signers use three public pages: the signing page (`/sign`, with an "About signing" panel), the copy
link (`/copy`), and, for hosts, the embedded field editor (`/editor/page/:id`).

## Who can do what

| Role | Esign permission | Can |
| --- | --- | --- |
| Editor and above (Owner, Admin, Editor) | `esign.manage` | send, void and follow envelopes, upload templates, open signing pages for testing |
| Viewer | `esign.view` | see the organization's templates and envelopes |

A custom role is built from these two permissions. Recipients don't need an account: their link and
emailed code are their access, to their own task only.

**The platform runs due work every five minutes.** Esign declares `"scheduled": "/api/scheduled"`
under `insulin` in `package.json`, and the hosting gateway POSTs there every five minutes with no
identity (`x-suger-access-via: schedule`). An envelope is normally finished right after its last
signature, after the signer's response; due work finishes any that a request couldn't (a CPU limit,
an outage), expires envelopes past their deadline and retries completion notices, for every
organization. Hosts no longer need to schedule anything: `POST /api/process-due` stays, for a
manager or a host's service account to finish their own organization's due work at once.

## For developers

### Run it locally

```sh
npm ci
npm run dev        # http://localhost:3000, as a preview Owner of a preview organization
```

The local preview signs with the HMAC test seal and keeps every emailed code in its test mailbox:
the signing page says so and shows where. Codes go only to synthetic addresses (`example.com`,
`.test`) unless a mail relay is configured. The database lives in `.suger/data/`.

### Test, typecheck, build

```sh
npm run typecheck
npm test
NITRO_PRESET=cloudflare_module npm run build
```

From the repository root: `node .github/scripts/check-insulin-app.mjs esign` (and with `--built`
after the build) and `node .github/scripts/check-public-content.mjs`. The browser tests need Chrome
(`ESIGN_TEST_CHROME`, or a usual install path) and skip without it. Tests use synthetic data,
Miniflare D1, a stub of the mail relay, generated seal keys, and fakes for the TSA (a recorded DigiCert
response and locally generated OpenSSL responses).

### Database changes

Edit `src/app/db/schema.ts` and run `npm run db:generate` (drizzle-kit 0.31.11 with drizzle-orm
0.45.3). The triggers that keep signatures and the audit trail append-only are the custom migration
`src/app/db/migrations/0001_triggers.sql`. `0002_seal_key.sql` was written by hand, in the form drizzle-kit gives a
table rebuild, to carry existing seals over to the new mode.

### Configuration

The secrets (`ESIGN_*`) are declared in `package.json` under `insulin.secrets` and described in
[docs/architecture.md](docs/architecture.md#configuration). A published app signs nothing until the
code pepper, the mail relay and the seal key are configured.

### The seal key

The managed seal's private key is the Worker's `ESIGN_SEAL_KEY` binding, a Cloudflare `secret_key`; its public half,
and every earlier key's, is listed in `src/app/server/esign/seal/keys.ts`. To make the first key, or a new one:

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node esign/scripts/put-seal-key.mjs
```

The script generates the key in memory, puts the private half on the Worker, and prints the entry for `keys.ts`.
Add it (when rotating, give the previous entry an `until` of the new entry's `from`; never remove one), then deploy.

### UI

[shadcn/ui](https://ui.shadcn.com) components (copied into `src/app/components/ui/`) on Tailwind CSS
v4 with the default neutral theme, light and dark, and Lucide icons; no CDNs. The UI files are `.ts`
with `React.createElement`, because the tests run on Node's type stripping, which can't run JSX.

### How it works

[docs/architecture.md](docs/architecture.md): the app on the platform, the pages and their headers,
the signing lifecycle, the data model, how writes commit, codes and sessions, evidence and seals, the
API and the embedded editor.

## License

MIT, like the rest of this repository. Third-party material is listed in [NOTICE](NOTICE).
