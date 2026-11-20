import { Navigate, createBrowserRouter, type RouteObject } from "react-router";
import { RequireAuth } from "./auth/guards.tsx";
import { AppLayout } from "./components/AppLayout.tsx";
import { ReturnFrame, ReturnIndex, YearFrame, YearIndex } from "./components/YearFrame.tsx";
import { DocsPage } from "./pages/DocsPage.tsx";
import { ProfilePage } from "./pages/ProfilePage.tsx";
import { PersonalInfoStep } from "./pages/PersonalInfoStep.tsx";
import { ConfirmStep } from "./pages/ConfirmStep.tsx";
import { ModuleStep } from "./pages/ModuleStep.tsx";
import { FinishStep } from "./pages/FinishStep.tsx";
import { UploadStep } from "./pages/UploadStep.tsx";
import { NotFoundPage, RouteErrorPage } from "./pages/Pages.tsx";
import { ReturnsPage } from "./pages/ReturnsPage.tsx";

export const routes: RouteObject[] = [
  {
    element: <RequireAuth />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        element: <AppLayout />,
        errorElement: <RouteErrorPage />,
        children: [
          { index: true, element: <Navigate to="/returns" replace /> },
          { path: "/returns", element: <ReturnsPage /> },
          { path: "/profile", element: <ProfilePage /> },
          {
            path: "/returns/:year",
            element: <YearFrame />,
            children: [
              { index: true, element: <YearIndex /> },
              {
                path: ":person",
                element: <ReturnFrame />,
                children: [
                  { index: true, element: <ReturnIndex /> },
                  { path: "personal", element: <PersonalInfoStep /> },
                  { path: "upload", element: <UploadStep /> },
                  { path: "income", element: <ModuleStep key="income" module="income" /> },
                  { path: "deductions", element: <ModuleStep key="deductions" module="deductions" /> },
                  { path: "credits", element: <ModuleStep key="credits" module="credits" /> },
                  // What applies became Income, Deductions and Credits.
                  { path: "applies", element: <Navigate to="../income" replace /> },
                  { path: "confirm", element: <ConfirmStep /> },
                  { path: "finish", element: <FinishStep /> },
                  { path: "*", element: <NotFoundPage /> },
                ],
              },
            ],
          },
          { path: "/docs/:topic?", element: <DocsPage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

// In Insulin Apps the app is served from its own origin's root, so browser history routes work as they are.
export function createAppRouter() {
  return createBrowserRouter(routes);
}
