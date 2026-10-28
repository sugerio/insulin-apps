import { Navigate, Outlet, useParams } from "react-router";
import { useAuth, useMe } from "./AuthProvider.tsx";
import { hasAdminAccess } from "./access.ts";
import { OpenFromConsolePage } from "../pages/Pages.tsx";

export function RequireAuth() {
  const { state, refresh } = useAuth();
  if (state.status === "loading") return <div className="center-page" role="status">Loading Cap Table…</div>;
  // Signing in is the console's: without its identity every page gives way to the one message that helps.
  if (state.status === "unauthenticated") return <OpenFromConsolePage onRetry={() => void refresh()} />;
  if (state.status === "error") {
    return (
      <div className="center-page">
        <div className="card">
          <h1>Couldn’t load Cap Table</h1>
          <p>Something went wrong while loading your access. Try again in a moment.</p>
          <button className="btn" onClick={() => void refresh()}>Try again</button>
        </div>
      </div>
    );
  }
  return (
    <>
      {state.me.preview ? <PreviewStrip /> : null}
      <Outlet />
    </>
  );
}

/** Above every page, setup included, while the app runs without a console identity (the console's preview). */
function PreviewStrip() {
  return (
    <div className="preview-mode" role="status">
      <b>Preview mode.</b> You're using the app as a stand-in owner, with no console account. Once published, everyone opens it from the Insulin console with their own role.
    </div>
  );
}

// Every refusal lands on the no-access page; an app whose company isn't set up yet lands on the setup page.

export function RequireOrgAccess() {
  const { orgId } = useParams();
  const me = useMe();
  if (me.company === null) return <Navigate to="/setup" replace />;
  if (!hasAdminAccess(me)) return <Navigate to="/no-access" replace />;
  // One company per Insulin organization: another id is foreign or retired, so an administrator goes home.
  return me.company.id === orgId ? <Outlet /> : <Navigate to="/" replace />;
}

export function RequirePortal() {
  const { orgId } = useParams();
  const { matches } = useMe().portal;
  // Holder access is recomputed on every request: one that has ended, or another company's portfolio, leads to the
  // no-access page.
  const allowed = matches.length > 0 && (orgId === undefined || matches.some((match) => match.orgId === orgId));
  return allowed ? <Outlet /> : <Navigate to="/no-access" replace />;
}
