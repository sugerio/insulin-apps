import { useState } from "react";
import { Link } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { WriteButton } from "../components/Actions.tsx";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { DownloadError, useAllDocuments, useCanDownload, useDownload } from "../components/Documents.tsx";
import { Badge, Banner, InlineError, ResourceView } from "../components/Feedback.tsx";
import { UploadDocumentDialog, VisibilityDialog } from "../components/flows/DocumentDialogs.tsx";
import { CompanyContactDialog } from "../components/flows/OrgDialogs.tsx";
import { HowToExerciseDialog, PortalDocumentsDialog, PublishResourceDialog, stalePicks } from "../components/flows/PortalDialogs.tsx";
import { Icon } from "../components/Icon.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { isPublishedResource, portalUseOf } from "../lib/documents.ts";
import { DASH } from "../lib/format.ts";
import { documentKindLabel } from "../lib/labels.ts";
import { useResource } from "../lib/useResource.ts";

// Stakeholder Portal settings (Hire and Retain › Stakeholder Portal): the company contact, the
// holder documents (company resources every holder sees), counsel's notice of exercise form and privacy notice
// (picked among those resources), the How to exercise text and what holders see. Owners and admins edit; editors view.
// Publishing a company resource is done here.

type Dialog =
  | { kind: "contact" } | { kind: "documents" } | { kind: "howTo" } | { kind: "upload" }
  | { kind: "publish"; preselect?: string } | { kind: "unpublish"; document: api.Document };

const WHAT_HOLDERS_SEE = "Their own holdings only: vesting status and timeline, exercisable amounts with the contractual and ISO deadlines, documents, and How to exercise with the payment instructions and their reference. No cap table, no other holders, no fully diluted or ownership percentage. Exercising is offline for now.";

export function PortalSettingsPage() {
  const workspace = useWorkspace();
  const { orgId, readOnly, reloadOrg } = workspace;
  const org = useResource((signal) => apiRequest(api.routes.getOrg, { params: { orgId }, signal }), [orgId]);
  const documents = useAllDocuments();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  // The settings change what the portal and the workspace show: read the org again everywhere.
  const orgSaved = () => {
    close();
    org.reload();
    reloadOrg();
  };
  const documentsChanged = () => {
    close();
    documents.reload();
  };
  const resources = documents.data ? documents.data.filter(isPublishedResource) : null;
  return (
    <Page title="Stakeholder Portal" crumbs={[["Hire and Retain"], ["Stakeholder Portal"]]}>
      <Card>
        <PageHead title="Stakeholder Portal" sub={readOnly ? "What every holder sees in the portal. View only — owners and admins edit." : "What every holder sees in the portal. Owners and admins edit; editors view."} />
        <ResourceView resource={org}>
          {(data) => {
            const stale = stalePicks(data, resources ? new Set(resources.map((document) => document.id)) : null);
            return (
              <>
                {stale.length ? (
                  <Banner kind="warn" title="A portal document is no longer a published company resource">
                    The portal still names it, and every change to the portal settings is refused until it is replaced: choose another one under Notice of exercise form and privacy notice.
                  </Banner>
                ) : null}
                <section id="contact">
                  <div className="card-h"><h2>Company contact</h2><WriteButton label="Edit" size="sm" ariaLabel="Edit the company contact" onClick={() => setDialog({ kind: "contact" })} /></div>
                  <DescriptionList rows={[["Name", data.settings.companyContact?.name ?? DASH], ["E-mail", data.settings.companyContact?.email ?? DASH]]} />
                  <p className="small muted">Shown in the portal footer and on How to exercise.</p>
                </section>
                <section id="resources" className="mt-16">
                  <div className="card-h">
                    <h2>Holder documents (company resources)</h2>
                    <div className="row">
                      <WriteButton label="Upload" icon="upload" size="sm" ariaLabel="Upload a company resource" onClick={() => setDialog({ kind: "upload" })} />
                      <WriteButton label="Publish a document" size="sm" onClick={() => setDialog({ kind: "publish" })} />
                    </div>
                  </div>
                  <ResourceList org={data} documents={documents.data} error={documents.error} onRetry={documents.reload} onUnpublish={(document) => setDialog({ kind: "unpublish", document })} />
                </section>
                <section id="notices" className="mt-16">
                  <div className="card-h"><h2>Notice of exercise form and privacy notice</h2><WriteButton label="Edit" size="sm" ariaLabel="Edit the portal documents" onClick={() => setDialog({ kind: "documents" })} /></div>
                  <DescriptionList
                    rows={[
                      ["Notice of exercise form (counsel's)", <PickedDocument id={data.settings.portal.noticeFormDocumentId} documents={documents.data} />],
                      ["Privacy notice (counsel's)", <PickedDocument id={data.settings.portal.privacyNoticeDocumentId} documents={documents.data} />],
                    ]}
                  />
                  <p className="small muted">Each is a company resource every holder sees: How to exercise links the form, and the portal footer the privacy notice.</p>
                </section>
                <section id="how-to" className="mt-16">
                  <div className="card-h"><h2>How to exercise — text</h2><WriteButton label="Edit" size="sm" ariaLabel="Edit the How to exercise text" onClick={() => setDialog({ kind: "howTo" })} /></div>
                  {data.settings.portal.howToExerciseText ? <p style={{ whiteSpace: "pre-wrap" }}>{data.settings.portal.howToExerciseText}</p> : <p className="muted">The default text (no custom text is set).</p>}
                  <p className="small muted">Holders see it on How to exercise, above the payment instructions and their own reference.</p>
                </section>
                <section id="what-holders-see" className="mt-16">
                  <h2>What holders see</h2>
                  <p className="muted">{WHAT_HOLDERS_SEE}</p>
                </section>
                {dialog?.kind === "contact" ? <CompanyContactDialog org={data} onClose={close} onDone={orgSaved} /> : null}
                {dialog?.kind === "documents" ? <PortalDocumentsDialog org={data} resources={resources} onClose={close} onDone={orgSaved} /> : null}
                {dialog?.kind === "howTo" ? <HowToExerciseDialog org={data} resources={resources} onClose={close} onDone={orgSaved} /> : null}
                {dialog?.kind === "upload" ? (
                  <UploadDocumentDialog title="Upload a company resource" onClose={close}
                    onDone={(stored) => { documents.reload(); setDialog({ kind: "publish", preselect: stored.id }); }} />
                ) : null}
                {dialog?.kind === "publish" ? <PublishResourceDialog documents={documents.data ?? null} preselect={dialog.preselect} onClose={close} onDone={documentsChanged} /> : null}
                {dialog?.kind === "unpublish" ? <VisibilityDialog document={dialog.document} next={false} scope="company" onClose={close} onDone={documentsChanged} /> : null}
              </>
            );
          }}
        </ResourceView>
      </Card>
    </Page>
  );
}

function PickedDocument({ id, documents }: { id: string | null; documents: readonly api.Document[] | undefined }) {
  const { href } = useWorkspace();
  if (id === null) return <>Not chosen</>;
  const document = documents?.find((item) => item.id === id);
  if (!documents) return <span className="muted">Loading…</span>;
  if (!document) return <span>A document you can't see here</span>;
  return (
    <>
      <Link to={href(`documents/${document.id}`)}>{document.filename}</Link>
      {!isPublishedResource(document) ? <> <Badge tone="amber">No longer a published company resource</Badge></> : null}
    </>
  );
}

/** The company resources every holder sees, with "Stop showing" for owners and admins. */
function ResourceList({ org, documents, error, onRetry, onUnpublish }: { org: api.Org; documents: readonly api.Document[] | undefined; error: unknown; onRetry: () => void; onUnpublish: (document: api.Document) => void }) {
  const { href } = useWorkspace();
  const canDownload = useCanDownload();
  const { download, error: downloadError, busy } = useDownload();
  if (!documents && error !== undefined) return <InlineError what="the company resources" error={error} onRetry={onRetry} />;
  if (!documents) return <p className="muted small" role="status">Loading the company resources…</p>;
  const resources = documents.filter(isPublishedResource);
  if (!resources.length) return <p className="muted small">No company resources are published yet. Upload one, or publish a document that has no holder link.</p>;
  return (
    <>
      <ul className="plain" aria-label="Company resources">
        {resources.map((document) => {
          const use = portalUseOf(org, document.id);
          return (
            <li key={document.id} className="row" style={{ justifyContent: "space-between" }}>
              <span>
                <Icon name="file" /> <Link to={href(`documents/${document.id}`)}>{document.filename}</Link>{" "}
                <span className="small muted">{documentKindLabel(document.kind)}</span>
                {use ? <> <Badge tone="teal">{use[0]!.toUpperCase()}{use.slice(1)}</Badge></> : null}
              </span>
              <span className="row">
                {canDownload ? <button type="button" className="btn btn-ghost btn-xs" disabled={busy === document.id} onClick={() => void download(document.id, document.filename)}>Download <span className="sr-only">{document.filename}</span></button> : null}
                <WriteButton label="Stop showing" size="xs" ariaLabel={`Stop showing ${document.filename} to holders`} onClick={() => onUnpublish(document)} />
              </span>
            </li>
          );
        })}
      </ul>
      <DownloadError error={downloadError} />
      <p className="small muted">Upload more here or under Documents; only documents with no holder link can be published for every holder.</p>
    </>
  );
}
