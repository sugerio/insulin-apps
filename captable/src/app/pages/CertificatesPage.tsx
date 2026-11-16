import { Link } from "react-router";
import { api } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { apiRequest } from "../api/request.ts";
import { DataTable, byDecimal, byDisplayId, byText } from "../components/DataTable.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { useDownload } from "../components/Documents.tsx";
import { Badge, Banner, ResourceView } from "../components/Feedback.tsx";
import { HolderLink, SecurityLink } from "../components/Links.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { DASH, formatDate } from "../lib/format.ts";
import { allOf, useResource } from "../lib/useResource.ts";

// Certificates, legends and terms, view only. Imported certificates are unsigned PDFs rendered by Pulley; the app
// doesn't generate, sign or send certificates.

const STATUS_LABELS: Record<api.Certificate["status"], [string, "grey" | "red"]> = {
  ISSUED: ["Unsigned PDF (migrated)", "grey"],
  VOID: ["Voided (migrated)", "red"],
  CANCELLED: ["Cancelled", "red"],
};

function Subnav({ active }: { active: "certificates" | "legends" | "terms" }) {
  const { href } = useWorkspace();
  const items = [["certificates", "Certificates", "certificates"], ["legends", "Legends", "certificates/legends"], ["terms", "Terms", "certificates/terms"]] as const;
  return (
    <nav className="flex flex-wrap gap-1.5" aria-label="Certificates">
      {items.map(([key, label, path]) => (
        <Button key={key} asChild variant={key === active ? "secondary" : "ghost"} size="sm" className="rounded-full">
          <Link to={href(path)} aria-current={key === active ? "page" : undefined}>{label}</Link>
        </Button>
      ))}
    </nav>
  );
}

function CertificateDownload({ certificate }: { certificate: api.Certificate }) {
  const { download, error, busy } = useDownload();
  if (!certificate.documentId) return <>{DASH}</>;
  return (
    <>
      <Button type="button" variant="ghost" size="xs" disabled={busy === certificate.documentId} onClick={() => void download(certificate.documentId!, `${certificate.certificateNumber}_certificate_unsigned.pdf`)}>
        Download <span className="sr-only">certificate {certificate.certificateNumber}</span>
      </Button>
      {error ? <div className="text-xs font-medium text-destructive" role="alert">{error}</div> : null}
    </>
  );
}

export function CertificatesPage() {
  const { orgId, format, href } = useWorkspace();
  const certificates = useResource((signal) => apiRequest(api.routes.listCertificates, { params: { orgId }, signal }), [orgId]);
  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, query: { family: "STOCK" }, signal }), [orgId]);
  const classes = useResource((signal) => apiRequest(api.routes.listStockClasses, { params: { orgId }, signal }), [orgId]);
  return (
    <Page title="Certificates" crumbs={[["Certificates"]]}>
      <Card>
        <PageHead title="Certificates" sub="View only." />
        <Subnav active="certificates" />
        <Banner kind="info" title="No officer signature is recorded on migrated certificates">
          Cap Table doesn't generate or sign certificates: shares it creates, such as the shares from an exercise, are book entries, and a share without a certificate shows "Uncertificated" on its page.
        </Banner>
        {/* Holder, class and quantity come from the share records: the table waits for them rather than leaving blanks. */}
        <ResourceView resource={allOf(certificates, securities, classes)}>
          {([data, securityList, classList]) => {
            const byId = new Map(securityList.items.map((item) => [item.id, item]));
            const classNames = new Map(classList.items.map((item) => [item.id, item.name]));
            const security = (certificate: api.Certificate) => byId.get(certificate.securityId);
            return (
              <DataTable
                id="certificates"
                label="Certificates"
                rows={data.items}
                rowKey={(certificate) => certificate.id}
                defaultSort={["id", "asc"]}
                search={(certificate) => `${certificate.certificateNumber} ${security(certificate)?.stakeholderName ?? ""}`}
                empty="No certificates were migrated."
                filters={[{ key: "date", label: "Issue date", type: "daterange", test: (certificate, range) => (!range.from || certificate.issuedDate >= range.from) && (!range.to || certificate.issuedDate <= range.to) }]}
                columns={[
                  { key: "id", label: "Cert ID", render: (certificate) => <SecurityLink id={certificate.securityId} family="STOCK" displayId={certificate.certificateNumber} />, compare: byDisplayId((certificate) => certificate.certificateNumber) },
                  {
                    key: "holder", label: "Stakeholder",
                    render: (certificate) => { const known = security(certificate); return known ? <HolderLink id={known.stakeholderId} name={known.stakeholderName} /> : DASH; },
                    compare: byText((certificate) => security(certificate)?.stakeholderName),
                  },
                  { key: "class", label: "Class", render: (certificate) => { const classId = security(certificate)?.stockClassId; return classId ? classNames.get(classId) ?? DASH : DASH; } },
                  { key: "qty", label: "Quantity", numeric: true, render: (certificate) => format.shares(security(certificate)?.numbers?.issued ?? null), compare: byDecimal((certificate) => security(certificate)?.numbers?.issued) },
                  { key: "date", label: "Issue date", render: (certificate) => formatDate(certificate.issuedDate), compare: byText((certificate) => certificate.issuedDate) },
                  { key: "pdf", label: "Certificate", render: (certificate) => <CertificateDownload certificate={certificate} /> },
                  { key: "status", label: "Status", render: (certificate) => <Badge tone={STATUS_LABELS[certificate.status][1]}>{STATUS_LABELS[certificate.status][0]}</Badge> },
                ]}
              />
            );
          }}
        </ResourceView>
        <p className="text-xs text-muted-foreground">The app doesn't generate, sign or send certificates. <Link className="font-medium underline underline-offset-4" to={href("share-classes")}>Share classes</Link></p>
      </Card>
    </Page>
  );
}

export function LegendsPage() {
  const { orgId, href } = useWorkspace();
  const legends = useResource((signal) => apiRequest(api.routes.listLegends, { params: { orgId }, signal }), [orgId]);
  return (
    <Page title="Legends" crumbs={[["Certificates", href("certificates")], ["Legends"]]}>
      <Card>
        <PageHead title="Legends" sub="View only." />
        <Subnav active="legends" />
        <ResourceView resource={legends}>
          {(data) => (
            <DataTable
              id="legends"
              label="Legends"
              rows={data.items}
              rowKey={(legend) => legend.id}
              toolbar={false}
              paginate={false}
              empty="No legends were migrated."
              columns={[
                { key: "name", label: "Name", render: (legend) => legend.name, compare: byText((legend) => legend.name) },
                { key: "text", label: "Text", className: "whitespace-normal", render: (legend) => legend.text },
                { key: "status", label: "Status", render: (legend) => (legend.archivedAt === null ? <Badge tone="green">Active</Badge> : <Badge tone="grey">Archived</Badge>) },
              ]}
            />
          )}
        </ResourceView>
      </Card>
    </Page>
  );
}

const SAMPLE = { "{{holder_name}}": "Jane Example", "{{quantity}}": "10,000", "{{share_class}}": "Common Stock" } as const;

export function CertificateTermsPage() {
  const { orgId, href, legalName } = useWorkspace();
  const terms = useResource((signal) => apiRequest(api.routes.listCertificateTerms, { params: { orgId }, signal }), [orgId]);
  return (
    <Page title="Certificate terms" crumbs={[["Certificates", href("certificates")], ["Terms"]]}>
      <Card>
        <PageHead title="Certificate terms" sub="View only." />
        <Subnav active="terms" />
        <ResourceView resource={terms}>
          {(data) => {
            const items = data.items;
            if (!items.length) return <p className="text-sm text-muted-foreground">No certificate terms were migrated.</p>;
            return items.map((item) => (
              <div key={item.id} className="flex flex-col gap-3">
                <DescriptionList rows={[["Name", item.name], ["Front text", <span className="font-mono text-xs">{item.text}</span>]]} />
                <div className="rounded-md border-[6px] border-double border-primary bg-card px-8 py-6 text-sm" aria-label={`Preview of ${item.name}`}>
                  <div className="mt-1.5 mb-0.5 text-center text-xl font-bold">{legalName}</div>
                  <p>{Object.entries(SAMPLE).reduce((text, [field, value]) => text.replaceAll(field, value), item.text)}</p>
                </div>
              </div>
            ));
          }}
        </ResourceView>
      </Card>
    </Page>
  );
}
