import { Navigate, useLocation, useParams } from "react-router";
import { useMe } from "../auth/AuthProvider.tsx";
import { canSetUpCompany, hasAdminAccess } from "../auth/access.ts";
import { Docs } from "../components/Docs.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Breadcrumbs, Page, type Crumb } from "../components/Page.tsx";
import { PortalPage } from "../components/PortalParts.tsx";
import { usePortal } from "../components/PortalWorkspace.tsx";
import { useDocumentTitle } from "../lib/useDocumentTitle.ts";
import type { DocTopic } from "./docs/parts.tsx";
import { docTopic } from "./docs/topics.ts";
import { NotFoundPage } from "./Pages.tsx";
import { PortalNotFoundPage } from "./portal/PortfolioPage.tsx";

// The Docs, inside the frame of whoever reads them: the admin workspace (owners, admins and editors), the holder's
// portfolio (users and viewers, where the docs open on the holders' topic), or pages of their own for someone with
// neither, such as an owner who hasn't set up the company yet. An address with no topic opens the frame's default topic;
// one naming an unknown topic is that frame's "not found".

function docsTitle(topic: DocTopic): string {
  return `${topic.title} — Docs`;
}

/** `/companies/:orgId/docs/:topic?` */
export function WorkspaceDocsPage() {
  const { href } = useWorkspace();
  const topic = docTopic(useParams().topic, "getting-started");
  if (!topic) return <NotFoundPage />;
  return (
    <Page title={docsTitle(topic)} crumbs={[["Docs", href("docs")], [topic.title]]}>
      <Docs base={href("docs")} topic={topic} />
    </Page>
  );
}

/** `/portfolio/:orgId/docs/:topic?` */
export function PortalDocsPage() {
  const portal = usePortal();
  const topic = docTopic(useParams().topic, "for-stakeholders");
  if (!topic) return <PortalNotFoundPage />;
  return (
    <PortalPage title={docsTitle(topic)} crumb="Docs">
      <Docs base={portal.href("docs")} topic={topic} />
    </PortalPage>
  );
}

/** `/docs/:topic?`: for someone with a workspace or a portfolio, the docs there; for anyone else, these pages. */
export function StandaloneDocsPage() {
  const me = useMe();
  const { topic: slug } = useParams();
  const { hash } = useLocation();
  const company = me.company;
  const rest = `${slug ? `/${slug}` : ""}${hash}`;
  if (company && hasAdminAccess(me)) return <Navigate to={`/companies/${company.id}/docs${rest}`} replace />;
  if (company && me.portal.matches.some((match) => match.orgId === company.id)) return <Navigate to={`/portfolio/${company.id}/docs${rest}`} replace />;
  const topic = docTopic(slug, "getting-started");
  if (!topic) return <NotFoundPage />;
  // Before the company exists, the way back is the setup page.
  const home: Crumb = company === null && canSetUpCompany(me) ? ["Set up your company", "/setup"] : ["Home", "/"];
  return <StandaloneDocs topic={topic} home={home} />;
}

function StandaloneDocs({ topic, home }: { topic: DocTopic; home: Crumb }) {
  useDocumentTitle(docsTitle(topic));
  return (
    <section className="page">
      <Breadcrumbs items={[home, ["Docs", "/docs"], [topic.title]]} />
      <Docs base="/docs" topic={topic} />
    </section>
  );
}
