import { Card, PageHead, SectionTitle } from "../../components/Page.tsx";
import { DocumentCards, PortalLink, PortalPage, PortalResourceView } from "../../components/PortalParts.tsx";
import { usePortal } from "../../components/PortalWorkspace.tsx";
import { useResource } from "../../lib/useResource.ts";

// Documents: the holder's own documents (agreements, notices of exercise, migrated certificates,
// 83(b) proofs) and the company resources every holder may open (plan, notice form, FAQ, privacy notice). The portal
// lists only what the server marks visible to this holder (one linked holder, or a company resource);
// downloads go through the audited portal route. The company's designated privacy notice leads the company resources,
// marked as such.

export function PortalDocumentsPage() {
  const portal = usePortal();
  const documents = useResource((signal) => portal.source.documents(signal), [portal.source.key]);
  return (
    <PortalPage title="Documents" crumb="Documents">
      <Card>
        <PageHead title="Documents" />
        <PortalResourceView resource={documents} what="Documents">
          {(data) => {
            const newestFirst = [...data].sort((a, b) => b.createdAt - a.createdAt);
            return (
              <>
                <SectionTitle>My documents</SectionTitle>
                <DocumentCards documents={newestFirst.filter((document) => document.scope === "mine")} empty="No documents of yours have been shared here yet." />
                <SectionTitle>Company resources</SectionTitle>
                <DocumentCards documents={newestFirst.filter((document) => document.scope === "company")} empty="No company resources yet." />
                <p className="small muted mt-12">See also <PortalLink to="how-to-exercise">How to exercise</PortalLink>.</p>
              </>
            );
          }}
        </PortalResourceView>
      </Card>
    </PortalPage>
  );
}
