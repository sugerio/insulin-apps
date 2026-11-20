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

## What it does

- **Templates.** A PDF with the roles that sign it (for example `partner` and `seller`). Fields
  (signature, title, date signed) can be placed on its pages in the template editor; without fields,
  a signature page is appended.
- **Envelopes.** A template sent to named recipients, one per role, who sign in order. An envelope
  can carry the document's name and version, the sender, a sign-by deadline, and what each signer
  sees after signing. It can be voided; a signer can decline with a reason.
- **Signing.** The recipient opens the signing page from the invitation Esign emails them (or a host product's one-time
  link), confirms a six-digit code sent to their email,
  reviews the document, agrees to sign electronically and signs. Signing for a company records their
  title and authority.
- **Evidence.** Every signature is hash-chained to the previous one and to the document it was made
  on. The finished envelope is sealed with a signature by Esign's seal key and an RFC 3161 timestamp, and the
  certificate of completion lists the signers, the audit trail and how it was sealed.

## The pages

Members open Esign from their organization's Insulin apps:

- **Envelopes**: the envelopes they own or that are shared with them, with their status; one envelope's
  signers, audit trail and, once completed, the signed PDF and certificate. Those who manage send new
  ones (Esign emails each signer an invitation), void them and resend an invitation.
- **Templates**: upload a PDF with its roles and place its fields in the editor (templates signed on an
  added page come through the API).
- **Contacts**: the organization's address book, everyone its envelopes named as signers and anyone
  added by hand; everyone who can use Esign sees it.
- **Docs**: getting started, the main tasks, what signers see, statuses, evidence, roles, background
  on electronic signatures (general information, not legal advice) and a glossary. Every role can
  open them.
- **Settings**: People, Integrations, API access and Connect AI, the platform's pages for Esign on
  `insulinapps.com/apps/esign/settings/`.

They are in the two-level navigation every Insulin app has: the organization switcher, these
sections (Envelopes, Templates and Contacts from `insulin.navigation` in `package.json`) and the person
in the first column; the open section's items (the Docs topics, Settings' pages) in the second; each
column collapses to icons.

Signers use three public pages: the signing page (`/sign`, with an "About signing" panel), the copy
link (`/copy`), and, for hosts, the embedded field editor (`/editor/page/:id`).

## Who can do what

| Role | Esign permission | Can |
| --- | --- | --- |
| Editor and above (Owner, Admin, Editor) | `esign.manage` | send, void and follow envelopes, resend invitations, upload templates |
| Viewer | `esign.view` | see the templates and envelopes shared with them |

A custom role is built from these two permissions. Recipients don't need an account: their link and
emailed code are their access, to their own task only.

**The platform runs due work every five minutes.** Esign declares `"scheduled": "/api/scheduled"`
under `insulin` in `package.json`, and the hosting gateway POSTs there every five minutes with no
identity (`x-suger-access-via: schedule`). An envelope is normally finished right after its last
signature, after the signer's response; due work sends the drafts scheduled with Send later whose
time has come, finishes any envelope a request couldn't (a CPU limit, an outage), expires envelopes
past their deadline and retries completion notices and invitations, for every organization. Hosts no longer need to schedule anything: `POST /api/process-due` stays, for a
manager or a host's service account to finish their own organization's due work at once.

**A scheduled send can wait after the platform's upgrade.** Esign checks whoever scheduled a send with the
platform's member status, which answers only for organizations where the platform has recorded that Esign is used
(`.github/hosting/DESIGN.md` §8.9). The gateway's migration `0012` records those from Esign's usage reports and mail
before it, so an organization whose first use of Esign came after Esign's last report before that migration (under an
hour: a release deploys Esign before the gateway) isn't recorded until someone opens Esign there. Until then its due
drafts stay scheduled and say so (`sendWaiting: "organization_unconfirmed"`; "Waiting since … Insulin Apps is
confirming your organization" on Envelopes, and why on the draft), tried again every ten minutes; opening Esign
records the organization, and they are sent at the next try. A known limit of that upgrade, nothing to do by hand.

**Esign reports its usage every hour.** After the due work, the first tick of each hour sends the
platform that hour's usage (`usage-metrics.ts`): for each organization, its envelopes in all and by
status, its templates and signatures, and the bytes its documents take in storage; for the app, the
size of its database and how many organizations have data. Counts and sizes only, never names, email
addresses, document titles or contents. It goes to `SUGER_METRICS_URL` with `SUGER_APP_TOKEN`, over
the `SUGER_GATEWAY` binding; without them nothing is reported. One tick claims each hour in
`metrics_reports`, so the report is sent once, and a report the platform refused is sent again by
the next tick.

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
`src/app/db/migrations/0001_triggers.sql`. The history before Esign shipped is folded into `0000_init.sql`: a local
database made from the earlier chain is recreated, not migrated.

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
Add it (when rotating, give the previous entry an `until` at least an hour after the script finished, such as the
time of that deploy, not the new entry's `from`: requests already running seal with the old key for a while after;
never remove one), then deploy.

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
