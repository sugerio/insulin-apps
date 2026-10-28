import "./app.css";
import "./components/workspace.css";
import "./components/portal.css";
import { StrictMode } from "react";
import { RouterProvider } from "react-router/dom";
import { AuthProvider } from "./auth/AuthProvider.tsx";
import { createAppRouter } from "./router.tsx";

// One router for the page's lifetime: created on first render, never twice (StrictMode renders components twice in
// development, and a second browser router would also listen to the history).
let router: ReturnType<typeof createAppRouter> | undefined;

// The React root (src/main.tsx mounts it inside the AppBuilder's preview bridge): who is using the app, then the pages.
export default function App() {
  router ??= createAppRouter();
  return (
    <StrictMode>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </StrictMode>
  );
}
