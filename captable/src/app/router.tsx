import type { ReactNode } from "react";
import { Navigate, createBrowserRouter, type RouteObject } from "react-router";
import { RequireAuth, RequireOrgAccess, RequirePortal } from "./auth/guards.tsx";
import { AppLayout } from "./components/AppLayout.tsx";
import { OrgWorkspace } from "./components/OrgWorkspace.tsx";
import { PortalWorkspace, PreviewWorkspace } from "./components/PortalWorkspace.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { CapTablePage } from "./pages/CapTablePage.tsx";
import { CertificatesPage, CertificateTermsPage, LegendsPage } from "./pages/CertificatesPage.tsx";
import { CompanyPage } from "./pages/CompanyPage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { DocumentPage } from "./pages/DocumentPage.tsx";
import { DocumentsPage } from "./pages/DocumentsPage.tsx";
import { PortalDocsPage, StandaloneDocsPage, WorkspaceDocsPage } from "./pages/DocsPage.tsx";
import { EquityPlanPage, EquityPlansPage } from "./pages/EquityPlansPage.tsx";
import { ExpiryRunsPage } from "./pages/ExpiryRunsPage.tsx";
import { ExerciseRequestPage, ExerciseRequestsPage } from "./pages/ExerciseRequestsPage.tsx";
import { ImportPage } from "./pages/ImportPage.tsx";
import { PortalSettingsPage } from "./pages/PortalSettingsPage.tsx";
import { ReportsPage } from "./pages/ReportsPage.tsx";
import { SecuritiesStatusPage } from "./pages/SecuritiesStatusPage.tsx";
import { SecurityPage } from "./pages/SecurityPage.tsx";
import { ShareClassesPage, ShareClassPage } from "./pages/ShareClassesPage.tsx";
import { StakeholderPage } from "./pages/StakeholderPage.tsx";
import { StakeholdersPage } from "./pages/StakeholdersPage.tsx";
import { ValuationPage, ValuationsPage } from "./pages/ValuationsPage.tsx";
import { VestingPage, VestingSchedulePage } from "./pages/VestingPage.tsx";
import { NoAccessPage, NotFoundPage, RouteErrorPage } from "./pages/Pages.tsx";
import { RecordExercisePage } from "./pages/RecordExercisePage.tsx";
import { RecordGrantPage } from "./pages/RecordGrantPage.tsx";
import { RecordValuationPage } from "./pages/RecordValuationPage.tsx";
import { StakeholderFormPage } from "./pages/StakeholderFormPage.tsx";
import { TerminatePage } from "./pages/TerminatePage.tsx";
import { HowToExercisePage } from "./pages/portal/HowToExercisePage.tsx";
import { PortalDocumentsPage } from "./pages/portal/PortalDocumentsPage.tsx";
import { PortalNotFoundPage, PortfolioHome, PortfolioOverviewPage } from "./pages/portal/PortfolioPage.tsx";
import { PortalSecurityPage } from "./pages/portal/PortalSecurityPage.tsx";
import { useMe } from "./auth/AuthProvider.tsx";
import { hasAdminAccess } from "./auth/access.ts";
import { SetupPage } from "./pages/SetupPage.tsx";

function Home() {
  const me = useMe();
  // One company per Insulin organization: an owner or admin sets it up the first time this organization opens the app.
  if (me.company === null) return <Navigate to="/setup" replace />;
  if (hasAdminAccess(me)) return <Navigate to={`/companies/${me.company.id}/dashboard`} replace />;
  if (me.portal.matches.length > 0) return <Navigate to="/portfolio" replace />;
  return <Navigate to="/no-access" replace />;
}
// The admin workspace: a company's pages, under /companies/:orgId/. An address that matches none of them is the
// shell's "Page not found".
const companyPages: [path: string, element: ReactNode][] = [
  ["dashboard", <DashboardPage />],
  ["captable", <CapTablePage />],
  ["share-classes", <ShareClassesPage />],
  ["share-classes/:classId", <ShareClassPage />],
  ["equity-plans", <EquityPlansPage />],
  ["equity-plans/:planId", <EquityPlanPage />],
  ["securities-status", <SecuritiesStatusPage />],
  ["expiry-runs", <ExpiryRunsPage />],
  ["vesting", <VestingPage />],
  ["vesting/schedules/:scheduleId", <VestingSchedulePage />],
  ["stakeholders", <StakeholdersPage />],
  ["stakeholders/:stakeholderId", <StakeholderPage />],
  ["securities/:securityId", <SecurityPage />],
  ["securities/:securityId/exercise", <RecordExercisePage />],
  ["securities/:securityId/cancel", <SecurityPage dialog="cancel" />],
  ["issue/options", <RecordGrantPage />],
  ["stakeholders/new", <StakeholderFormPage mode="create" />],
  ["stakeholders/:stakeholderId/edit", <StakeholderFormPage mode="edit" />],
  ["stakeholders/:stakeholderId/terminate", <TerminatePage />],
  ["compliance/409a/new", <RecordValuationPage />],
  ["convertibles/:convertibleId", <SecurityPage />],
  ["exercise-requests", <ExerciseRequestsPage />],
  ["exercise-requests/:requestId", <ExerciseRequestPage />],
  ["compliance/409a", <ValuationsPage />],
  ["compliance/409a/:valuationId", <ValuationPage />],
  ["certificates", <CertificatesPage />],
  ["certificates/legends", <LegendsPage />],
  ["certificates/terms", <CertificateTermsPage />],
  ["company", <CompanyPage />],
  ["documents", <DocumentsPage />],
  ["documents/:documentId", <DocumentPage />],
  ["stakeholder-portal", <PortalSettingsPage />],
  ["reports", <ReportsPage />],
  ["activity", <ActivityPage />],
  ["docs/:topic?", <WorkspaceDocsPage />],
];
// The portal pages a holder sees, and the same tree as the admin's "Preview as stakeholder" (the
// exact portal view): every page reads through the portal scope, from the holder's routes or the preview's twins.
const portalPages: RouteObject[] = [
  { index: true, element: <PortfolioOverviewPage /> },
  { path: "securities/:securityId", element: <PortalSecurityPage /> },
  { path: "convertibles/:securityId", element: <PortalSecurityPage /> },
  { path: "how-to-exercise", element: <HowToExercisePage /> },
  { path: "documents", element: <PortalDocumentsPage /> },
  // Any other address in the portal is the portal's own "not found", inside the holder's frame.
  { path: "*", element: <PortalNotFoundPage /> },
];
const companyRoutes: RouteObject[] = [
  { path: "/companies/:orgId/stakeholders/:stakeholderId/preview", element: <PreviewWorkspace />, children: portalPages },
  ...companyPages.map(([path, element]) => ({ path: `/companies/:orgId/${path}`, element })),
];
export const routes: RouteObject[] = [
  {
    element: <RequireAuth />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Home /> },
      { path: "/setup", element: <SetupPage /> },
      { path: "/no-access", element: <NoAccessPage /> },
      {
        element: <AppLayout />,
        errorElement: <RouteErrorPage />,
        children: [
          {
            element: <RequireOrgAccess />,
            children: [{ element: <OrgWorkspace />, children: companyRoutes }],
          },
          // Beside the workspace, not in it: the import replaces the company, and its result outlives the switch.
          { path: "/companies/:orgId/import", element: <ImportPage /> },
          {
            element: <RequirePortal />,
            children: [
              { path: "/portfolio", element: <PortfolioHome /> },
              // The docs are the holder's own, not part of the portal view an admin previews.
              { path: "/portfolio/:orgId", element: <PortalWorkspace />, children: [...portalPages, { path: "docs/:topic?", element: <PortalDocsPage /> }] },
            ],
          },
          // The docs for someone with no workspace or portfolio yet (an owner setting up); anyone else is sent to theirs.
          { path: "/docs/:topic?", element: <StandaloneDocsPage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
// In the console the app is served from its own origin's root, so browser history routes work as they are.
export function createAppRouter() { return createBrowserRouter(routes); }
