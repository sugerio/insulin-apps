import { Navigate, createBrowserRouter, type RouteObject } from "react-router";
import { RequireAuth } from "./auth/guards.tsx";
import { AppLayout } from "./components/AppLayout.tsx";
import { YearFrame, YearIndex } from "./components/YearFrame.tsx";
import { DocsPage } from "./pages/DocsPage.tsx";
import { HouseholdPage } from "./pages/HouseholdPage.tsx";
import { HouseholdStep } from "./pages/HouseholdStep.tsx";
import { LaterStep } from "./pages/LaterStep.tsx";
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
          { path: "/household", element: <HouseholdPage /> },
          {
            path: "/returns/:year",
            element: <YearFrame />,
            children: [
              { index: true, element: <YearIndex /> },
              { path: "household", element: <HouseholdStep /> },
              { path: "upload", element: <LaterStep step="upload" /> },
              { path: "applies", element: <LaterStep step="applies" /> },
              { path: "confirm", element: <LaterStep step="confirm" /> },
              { path: "deductions", element: <LaterStep step="deductions" /> },
              { path: "finish", element: <LaterStep step="finish" /> },
              { path: "*", element: <NotFoundPage /> },
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
